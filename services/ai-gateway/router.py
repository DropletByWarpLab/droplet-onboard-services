"""Routes inference requests to the correct provider (local Ollama, Anthropic, OpenAI).

As of WARP-104, the gateway is a pure provider router. Tool dispatch is
owned by the orchestrator (`apps/orchestrator/src/services/llm-agent.service.ts`)
which talks to MCP (`services/mcp-server`) for handler execution. The
gateway forwards `tools[]` to the model and returns the raw response —
including any `tool_calls[]` the model emits — so the orchestrator can
loop on its side.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncGenerator

from auth.byok import get_api_key
from middleware.off_lan_gating import check_off_lan_gate
from providers.anthropic_cloud import AnthropicCloudProvider
from providers.ollama_local import OllamaLocalProvider
from providers.openai_cloud import OpenAICloudProvider
from providers.base import BaseProvider
from schemas import ChatRequest, ModelInfo

logger = logging.getLogger(__name__)

# Model name prefix → provider mapping.
#
# Order matters: dicts iterate in insertion order, and `resolve_provider`
# returns the first provider whose prefix matches. `ollama` is listed
# FIRST so a local family whose name collides with a cloud prefix wins.
# The canonical collision is `gpt-oss` — OpenAI's OPEN-WEIGHTS model,
# served locally by Ollama, whose name starts with the openai cloud
# prefix `gpt`. It must route to ollama (the off-LAN gate blocks the
# nonexistent cloud call with HTTP 451). `gpt-oss` is more specific than
# `gpt`, and matched first, so genuine cloud models (`gpt-4o`, `o1`)
# still resolve to openai.
PROVIDER_PREFIXES = {
    "ollama": [
        "llama",
        "mistral",
        "phi",
        "gemma",
        "qwen",
        "codellama",
        "deepseek",
        "gpt-oss",
    ],
    "anthropic": ["claude"],
    "openai": ["gpt", "o1", "o3"],
}


class ProviderRouter:
    """Resolves model names to providers and delegates inference."""

    def __init__(self):
        self.ollama = OllamaLocalProvider()
        self.anthropic = AnthropicCloudProvider()
        self.openai = OpenAICloudProvider()
        self._providers: dict[str, BaseProvider] = {
            "ollama": self.ollama,
            "anthropic": self.anthropic,
            "openai": self.openai,
        }
        # The one configured local model (the "one-model rule"). When the
        # chat request targets exactly this model it ALWAYS routes to the
        # local Ollama provider, regardless of any cloud-looking name —
        # we know it's local because it's what this deployment runs, so we
        # never have to guess from the model string. Empty when unset
        # (e.g. tests / cloud-only deploys), in which case routing falls
        # back to prefix matching alone.
        self._local_model = (os.getenv("LLM_MODEL") or "").strip().lower() or None

    async def refresh_keys(self, user_id: str | None = None):
        """Reload API keys from the BYOK keystore for a given caller.

        WARP-561: keys are namespaced per authenticated user. ``user_id`` is
        the caller threaded down from the HTTP route (the orchestrator-provided
        principal). ``None`` reads the shared/device namespace and is used by
        server-side callers that have no per-request identity (model listing,
        gRPC EmbedText). Cloud providers are rebuilt per call rather than
        cached on the instance so two concurrent users never see each other's
        key — the router holds no per-user key state between requests.
        """
        anthropic_key = await get_api_key("anthropic", user_id=user_id)
        openai_key = await get_api_key("openai", user_id=user_id)
        self.anthropic = AnthropicCloudProvider(api_key=anthropic_key)
        self.openai = OpenAICloudProvider(api_key=openai_key)
        self._providers["anthropic"] = self.anthropic
        self._providers["openai"] = self.openai

    def resolve_provider(self, model: str, explicit_provider: str | None = None) -> BaseProvider:
        """Resolve which provider handles the given model."""
        if explicit_provider and explicit_provider in self._providers:
            return self._providers[explicit_provider]

        model_lower = model.lower()

        # The configured local model always routes local, even if its name
        # collides with a cloud prefix (the gpt-oss / cloud-finetune case).
        # This is the explicit one-model rule, not a name heuristic.
        if self._local_model and model_lower == self._local_model:
            return self.ollama

        for provider_name, prefixes in PROVIDER_PREFIXES.items():
            if any(model_lower.startswith(p) for p in prefixes):
                return self._providers[provider_name]

        # Default to Ollama (local-first)
        return self.ollama

    async def list_all_models(self, user_id: str | None = None) -> list[ModelInfo]:
        """Query all providers for available models concurrently."""
        await self.refresh_keys(user_id=user_id)
        tasks = [provider.list_models() for provider in self._providers.values()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        models: list[ModelInfo] = []
        for provider_name, result in zip(self._providers.keys(), results):
            if isinstance(result, Exception):
                logger.warning("Failed to list models from %s: %s", provider_name, result)
            else:
                models.extend(result)
        return models

    async def chat(
        self, request: ChatRequest, user_id: str | None = None
    ) -> dict | AsyncGenerator[str, None]:
        """Route a chat request to the appropriate provider.

        Forwards `tools[]` to the model untouched. If the model emits
        `tool_calls[]` they are returned to the caller (the orchestrator
        agent loop) verbatim — this gateway never executes tools.

        WARP-561: ``user_id`` selects which caller's BYOK keys are loaded for
        this turn so a cloud request uses the requesting user's key, not a
        device-global one.
        """
        await self.refresh_keys(user_id=user_id)
        provider = self.resolve_provider(request.model, request.provider)

        # WARP-468: off-LAN gate. Refuses any non-local provider with
        # HTTP 451 when `cloud_model_escape` is disabled. The provider
        # name is the canonical key in `_providers`; we reverse-lookup
        # here so the gate sees `"ollama"` / `"anthropic"` / `"openai"`
        # rather than the BaseProvider instance.
        provider_name = next(
            (n for n, p in self._providers.items() if p is provider),
            "unknown",
        )
        await check_off_lan_gate(provider_name)

        kwargs = dict(
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        if request.tools:
            kwargs["tools"] = request.tools

        return await provider.chat(
            messages=request.messages,
            model=request.model,
            stream=request.stream,
            **kwargs,
        )

    async def close(self):
        await self.ollama.close()

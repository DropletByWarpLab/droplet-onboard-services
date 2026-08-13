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
from typing import NamedTuple

from auth.byok import get_api_key
from middleware.off_lan_gating import check_off_lan_gate, is_local_provider
from providers.anthropic_cloud import AnthropicCloudProvider
from providers.ollama_local import OllamaLocalProvider
from providers.openai_cloud import OpenAICloudProvider
from providers.base import BaseProvider
from schemas import ChatRequest, ModelInfo

logger = logging.getLogger(__name__)

# Model name prefix → provider mapping.
#
# Order matters: dicts iterate in insertion order, and `resolve_provider`
# returns the first provider whose prefix matches. `local` is listed
# FIRST so a local family whose name collides with a cloud prefix wins.
# The canonical collision is `gpt-oss` — OpenAI's OPEN-WEIGHTS model,
# served on-box, whose name starts with the openai cloud prefix `gpt`.
# It must route to `local` (the off-LAN gate blocks the nonexistent
# cloud call with HTTP 451). `gpt-oss` is more specific than `gpt`, and
# matched first, so genuine cloud models (`gpt-4o`, `o1`) still resolve
# to openai.
#
# WARP-1926: this key was `ollama` until the appliance's default runtime
# became Docker Model Runner. It names WHERE inference happens (on the
# box), never WHICH daemon serves it — both DMR and Ollama answer here,
# selected by INFERENCE_RUNTIME. Mirrored by LOCAL_MODEL_PREFIXES in
# apps/orchestrator/src/services/cloud-access.service.ts, pinned by a
# parity test that parses THIS dict — names and order both.
PROVIDER_PREFIXES = {
    "local": [
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


class ModelListResult(NamedTuple):
    """Result of the list_all_models provider fan-out (WARP-1284).

    `degraded_providers` names the providers whose list_models() raised.
    Before this existed, a dead Ollama produced the same bare empty list as
    a genuine first-boot model pull, so the setup wizard showed "your model
    is still downloading" for an unreachable AI service. Unkeyed cloud
    providers return [] rather than raising, so a healthy single-box with
    no BYOK keys reports an empty degraded list.
    """

    models: list[ModelInfo]
    degraded_providers: list[str]


class ProviderRouter:
    """Resolves model names to providers and delegates inference."""

    def __init__(self):
        # `local` is the on-box provider whichever daemon backs it — DMR by
        # default since WARP-1870, Ollama when INFERENCE_RUNTIME=ollama. The
        # class is still named OllamaLocalProvider because it speaks the
        # Ollama-compatible wire protocol that BOTH runtimes serve; that is a
        # protocol name, not a deployment claim.
        self.local = OllamaLocalProvider()
        self.anthropic = AnthropicCloudProvider()
        self.openai = OpenAICloudProvider()
        self._providers: dict[str, BaseProvider] = {
            "local": self.local,
            "anthropic": self.anthropic,
            "openai": self.openai,
        }
        # The one configured local model (the "one-model rule"). When the
        # chat request targets exactly this model it ALWAYS routes to the
        # on-box provider, regardless of any cloud-looking name —
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
        # WARP-1933: `provider` is a PERSISTED column, so a replayed turn can
        # arrive spelled `ollama`/`ollama_local` — the legacy names for the
        # on-box provider before WARP-1926 renamed the key to `local`. Those
        # spellings are not in `_providers` (deliberately: aliasing them in
        # would double-query the local provider in `list_all_models`'s fan-out
        # and skew the reverse lookup), so without this they missed the lookup
        # below and fell through to prefix matching — resolving a CLOUD
        # provider whenever the persisted model name matched a cloud prefix.
        # Same allowlist the off-LAN gate uses, so the two cannot disagree
        # about whether a given request is local.
        if explicit_provider and is_local_provider(explicit_provider):
            return self.local

        if explicit_provider and explicit_provider in self._providers:
            return self._providers[explicit_provider]

        model_lower = model.lower()

        # The configured local model always routes local, even if its name
        # collides with a cloud prefix (the gpt-oss / cloud-finetune case).
        # This is the explicit one-model rule, not a name heuristic.
        if self._local_model and model_lower == self._local_model:
            return self.local

        for provider_name, prefixes in PROVIDER_PREFIXES.items():
            if any(model_lower.startswith(p) for p in prefixes):
                return self._providers[provider_name]

        # Default to the on-box provider (local-first)
        return self.local

    async def list_all_models(self, user_id: str | None = None) -> ModelListResult:
        """Query all providers for available models concurrently.

        WARP-1284: per-provider failures are no longer silently swallowed
        into a shorter list — the survivors' models still return, and the
        failed providers are NAMED in `degraded_providers` so callers
        (/ai/models → orchestrator → setup wizard) can tell "provider down"
        apart from "provider has no models yet".
        """
        await self.refresh_keys(user_id=user_id)
        tasks = [provider.list_models() for provider in self._providers.values()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        models: list[ModelInfo] = []
        degraded_providers: list[str] = []
        for provider_name, result in zip(self._providers.keys(), results):
            if isinstance(result, Exception):
                logger.warning("Failed to list models from %s: %s", provider_name, result)
                degraded_providers.append(provider_name)
            else:
                models.extend(result)
        return ModelListResult(models=models, degraded_providers=degraded_providers)

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
        # Tool-call/tool-result message-contract integrity is enforced at
        # ChatRequest construction (schemas.py `_validate_tool_message_integrity`,
        # WARP-176), which covers the HTTP, gRPC and session paths alike — so no
        # redundant re-validation is done here.
        await self.refresh_keys(user_id=user_id)
        provider = self.resolve_provider(request.model, request.provider)

        # WARP-468: off-LAN gate. Refuses any non-local provider with
        # HTTP 451 when `cloud_model_escape` is disabled. The provider
        # name is the canonical key in `_providers`; we reverse-lookup
        # here so the gate sees `"local"` / `"anthropic"` / `"openai"`
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
        # WARP-1442 — forward the reasoning-effort knob ONLY when the caller set
        # one. Leaving the kwarg absent (not None) when unset keeps the outbound
        # provider call byte-for-byte identical to the pre-WARP-1442 behavior for
        # every existing caller; the local provider is the one place that decides
        # whether the target model actually supports it.
        if request.reasoning_effort is not None:
            kwargs["reasoning_effort"] = request.reasoning_effort

        return await provider.chat(
            messages=request.messages,
            model=request.model,
            stream=request.stream,
            **kwargs,
        )

    async def close(self):
        await self.local.close()

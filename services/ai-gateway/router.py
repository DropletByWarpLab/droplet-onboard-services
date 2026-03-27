"""Routes inference requests to the correct provider (local Ollama, Anthropic, OpenAI)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator

from auth.byok import get_api_key
from providers.anthropic_cloud import AnthropicCloudProvider
from providers.ollama_local import OllamaLocalProvider
from providers.openai_cloud import OpenAICloudProvider
from providers.base import BaseProvider
from schemas import ChatRequest, ModelInfo

logger = logging.getLogger(__name__)

# Model name prefix → provider mapping
PROVIDER_PREFIXES = {
    "ollama": ["llama", "mistral", "phi", "gemma", "qwen", "codellama", "deepseek"],
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

    async def refresh_keys(self):
        """Reload API keys from the BYOK keystore."""
        anthropic_key = await get_api_key("anthropic")
        openai_key = await get_api_key("openai")
        self.anthropic = AnthropicCloudProvider(api_key=anthropic_key)
        self.openai = OpenAICloudProvider(api_key=openai_key)
        self._providers["anthropic"] = self.anthropic
        self._providers["openai"] = self.openai

    def resolve_provider(self, model: str, explicit_provider: str | None = None) -> BaseProvider:
        """Resolve which provider handles the given model."""
        if explicit_provider and explicit_provider in self._providers:
            return self._providers[explicit_provider]

        model_lower = model.lower()
        for provider_name, prefixes in PROVIDER_PREFIXES.items():
            if any(model_lower.startswith(p) for p in prefixes):
                return self._providers[provider_name]

        # Default to Ollama (local-first)
        return self.ollama

    async def list_all_models(self) -> list[ModelInfo]:
        """Query all providers for available models concurrently."""
        await self.refresh_keys()
        tasks = [provider.list_models() for provider in self._providers.values()]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        models: list[ModelInfo] = []
        for provider_name, result in zip(self._providers.keys(), results):
            if isinstance(result, Exception):
                logger.warning("Failed to list models from %s: %s", provider_name, result)
            else:
                models.extend(result)
        return models

    async def chat(self, request: ChatRequest) -> dict | AsyncGenerator[str, None]:
        """Route a chat request to the appropriate provider."""
        await self.refresh_keys()
        provider = self.resolve_provider(request.model, request.provider)
        return await provider.chat(
            messages=request.messages,
            model=request.model,
            stream=request.stream,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )

    async def close(self):
        await self.ollama.close()

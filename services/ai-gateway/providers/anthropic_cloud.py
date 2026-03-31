"""Anthropic Claude provider — cloud API via LiteLLM."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import litellm

from providers.base import BaseProvider
from schemas import ChatMessage, ModelInfo

logger = logging.getLogger(__name__)

ANTHROPIC_MODELS = [
    ModelInfo(id="claude-sonnet-4-20250514", provider="anthropic", name="Claude Sonnet 4", context_window=200000),
    ModelInfo(id="claude-3-5-haiku-20241022", provider="anthropic", name="Claude 3.5 Haiku", context_window=200000),
    ModelInfo(id="claude-3-5-sonnet-20241022", provider="anthropic", name="Claude 3.5 Sonnet", context_window=200000),
]


class AnthropicCloudProvider(BaseProvider):
    """Provider for Anthropic Claude models via LiteLLM."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key

    async def list_models(self) -> list[ModelInfo]:
        return ANTHROPIC_MODELS if self.api_key else []

    async def chat(
        self, messages: list[ChatMessage], model: str, stream: bool = False, **kwargs
    ) -> dict | AsyncGenerator[str, None]:
        if not self.api_key:
            raise ValueError("Anthropic API key not configured. Add your key in Settings.")

        litellm_messages = [{"role": m.role, "content": m.content} for m in messages]
        litellm_model = f"anthropic/{model}" if not model.startswith("anthropic/") else model

        # Build optional params
        extra = {}
        if kwargs.get("tools"):
            extra["tools"] = [t.model_dump() if hasattr(t, "model_dump") else t for t in kwargs["tools"]]

        if not stream:
            response = await litellm.acompletion(
                model=litellm_model,
                messages=litellm_messages,
                api_key=self.api_key,
                temperature=kwargs.get("temperature", 0.7),
                max_tokens=kwargs.get("max_tokens", 4096),
                **extra,
            )
            return response.model_dump()

        return self._stream_chat(litellm_model, litellm_messages, kwargs)

    async def _stream_chat(
        self, model: str, messages: list[dict], kwargs: dict
    ) -> AsyncGenerator[str, None]:
        response = await litellm.acompletion(
            model=model,
            messages=messages,
            api_key=self.api_key,
            temperature=kwargs.get("temperature", 0.7),
            max_tokens=kwargs.get("max_tokens", 4096),
            stream=True,
        )
        async for chunk in response:
            data = chunk.model_dump_json()
            yield f"data: {data}\n\n"
        yield "data: [DONE]\n\n"

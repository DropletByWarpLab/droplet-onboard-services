"""OpenAI provider — cloud API via LiteLLM."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import litellm

from providers.base import BaseProvider
from schemas import ChatMessage, ModelInfo

logger = logging.getLogger(__name__)

OPENAI_MODELS = [
    ModelInfo(id="gpt-4o", provider="openai", name="GPT-4o", context_window=128000),
    ModelInfo(id="gpt-4o-mini", provider="openai", name="GPT-4o Mini", context_window=128000),
    ModelInfo(id="gpt-4-turbo", provider="openai", name="GPT-4 Turbo", context_window=128000),
]


class OpenAICloudProvider(BaseProvider):
    """Provider for OpenAI GPT models via LiteLLM."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key

    async def list_models(self) -> list[ModelInfo]:
        return OPENAI_MODELS if self.api_key else []

    async def chat(
        self, messages: list[ChatMessage], model: str, stream: bool = False, **kwargs
    ) -> dict | AsyncGenerator[str, None]:
        if not self.api_key:
            raise ValueError("OpenAI API key not configured. Add your key in Settings.")

        litellm_messages = [{"role": m.role, "content": m.content} for m in messages]
        litellm_model = f"openai/{model}" if not model.startswith("openai/") else model

        if not stream:
            response = await litellm.acompletion(
                model=litellm_model,
                messages=litellm_messages,
                api_key=self.api_key,
                temperature=kwargs.get("temperature", 0.7),
                max_tokens=kwargs.get("max_tokens", 4096),
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

"""OpenAI provider — cloud API via LiteLLM."""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

from capabilities import cloud_capabilities
from providers.base import BaseProvider, to_litellm_messages
from request_context import get_request_id
from schemas import ChatMessage, ModelInfo

logger = logging.getLogger(__name__)

OPENAI_MODELS = [
    ModelInfo(id="gpt-4o", provider="openai", name="GPT-4o", context_window=128000, capabilities=cloud_capabilities("gpt-4o")),
    ModelInfo(id="gpt-4o-mini", provider="openai", name="GPT-4o Mini", context_window=128000, capabilities=cloud_capabilities("gpt-4o-mini")),
    ModelInfo(id="gpt-4-turbo", provider="openai", name="GPT-4 Turbo", context_window=128000, capabilities=cloud_capabilities("gpt-4-turbo")),
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

        import litellm  # lazy: heavy import, only needed on a cloud call

        litellm_messages = to_litellm_messages(messages)
        litellm_model = f"openai/{model}" if not model.startswith("openai/") else model

        # Build optional params
        extra = {}
        if kwargs.get("tools"):
            extra["tools"] = [t.model_dump() if hasattr(t, "model_dump") else t for t in kwargs["tools"]]

        if not stream:
            rid = get_request_id()
            extra_headers = {"x-request-id": rid} if rid else None
            response = await litellm.acompletion(
                model=litellm_model,
                messages=litellm_messages,
                api_key=self.api_key,
                temperature=kwargs.get("temperature", 0.7),
                max_tokens=kwargs.get("max_tokens", 4096),
                extra_headers=extra_headers,
                **extra,
            )
            return response.model_dump()

        return self._stream_chat(litellm_model, litellm_messages, kwargs)

    async def _stream_chat(
        self, model: str, messages: list[dict], kwargs: dict
    ) -> AsyncGenerator[str, None]:
        import litellm  # lazy: heavy import, only needed on a cloud call

        rid = get_request_id()
        extra_headers = {"x-request-id": rid} if rid else None
        # GWV-008: forward tools on the streaming path too (see anthropic_cloud).
        extra = {}
        if kwargs.get("tools"):
            extra["tools"] = [t.model_dump() if hasattr(t, "model_dump") else t for t in kwargs["tools"]]
        response = await litellm.acompletion(
            model=model,
            messages=messages,
            api_key=self.api_key,
            temperature=kwargs.get("temperature", 0.7),
            max_tokens=kwargs.get("max_tokens", 4096),
            extra_headers=extra_headers,
            stream=True,
            **extra,
        )
        async for chunk in response:
            data = chunk.model_dump_json()
            yield f"data: {data}\n\n"
        yield "data: [DONE]\n\n"

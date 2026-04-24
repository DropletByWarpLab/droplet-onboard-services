"""Ollama provider — routes to Jetson over LAN."""

from __future__ import annotations

import logging
import os
import re
from collections.abc import AsyncGenerator

import httpx

from providers.base import BaseProvider
from schemas import ChatMessage, ModelInfo

logger = logging.getLogger(__name__)

JETSON_OLLAMA_URL = os.getenv("JETSON_OLLAMA_URL", "http://jetson-ai.local:11434")


def prettify_ollama_name(raw: str) -> str:
    """Turn an Ollama tag like 'llama3.1:8b' into a display name 'Llama 3.1 8B'.

    Other providers already return curated display names (e.g. 'Claude Sonnet 4');
    Ollama returns the raw tag, so match the convention at the provider edge.
    """
    base, _, tag = raw.partition(":")
    base_spaced = re.sub(r"([A-Za-z])(\d)", r"\1 \2", base)
    base_pretty = " ".join(
        part[:1].upper() + part[1:] if part and part[0].isalpha() else part
        for part in base_spaced.split()
    )
    if not tag:
        return base_pretty
    # Tag fragments: size first (uppercased), then any '-instruct'-style qualifiers.
    size, *qualifiers = tag.split("-")
    tag_pretty = size.upper() + "".join(
        f" {q[:1].upper() + q[1:]}" for q in qualifiers if q
    )
    return f"{base_pretty} {tag_pretty}".strip()


class OllamaLocalProvider(BaseProvider):
    """Provider for local Ollama models running on the Jetson."""

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or JETSON_OLLAMA_URL).rstrip("/")
        self.client = httpx.AsyncClient(base_url=self.base_url, timeout=60.0)

    async def list_models(self) -> list[ModelInfo]:
        try:
            resp = await self.client.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
            return [
                ModelInfo(
                    id=m["name"],
                    provider="ollama",
                    name=prettify_ollama_name(m["name"]),
                    context_window=None,
                )
                for m in data.get("models", [])
            ]
        except httpx.ConnectError:
            logger.warning("Jetson Ollama unreachable at %s", self.base_url)
            return []
        except Exception as e:
            logger.error("Error listing Ollama models: %s", e)
            return []

    async def chat(
        self, messages: list[ChatMessage], model: str, stream: bool = False, **kwargs
    ) -> dict | AsyncGenerator[str, None]:
        body = {
            "model": model,
            "messages": [m.model_dump(exclude_none=True) for m in messages],
            "stream": stream,
        }
        # Pass through supported kwargs
        for k in ("temperature", "max_tokens"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        # Pass tools if provided (Ollama supports OpenAI-compatible tool calling)
        if kwargs.get("tools"):
            body["tools"] = [t.model_dump() if hasattr(t, "model_dump") else t for t in kwargs["tools"]]

        if not stream:
            resp = await self.client.post("/v1/chat/completions", json=body)
            resp.raise_for_status()
            return resp.json()

        return self._stream_chat(body)

    async def _stream_chat(self, body: dict) -> AsyncGenerator[str, None]:
        async with self.client.stream("POST", "/v1/chat/completions", json=body) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    yield f"{line}\n\n"

    async def is_reachable(self) -> bool:
        try:
            resp = await self.client.get("/api/tags", timeout=3.0)
            return resp.status_code == 200
        except Exception:
            return False

    async def close(self):
        await self.client.aclose()

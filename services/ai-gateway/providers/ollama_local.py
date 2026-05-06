"""Ollama provider — routes to Jetson over LAN."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import AsyncGenerator

import httpx

from providers.base import BaseProvider
from schemas import ChatMessage, ModelInfo

logger = logging.getLogger(__name__)

JETSON_OLLAMA_URL = os.getenv("JETSON_OLLAMA_URL", "http://host.docker.internal:8002/proxy")

# Cold-loading a model on the Jetson can take 30-90s (8B Q4 with partial GPU offload),
# and long completions can stream for minutes. The previous flat 60s timeout aborted
# the request mid-load, returning HTTP 499 to the user and an apparent "slow" chat.
# Override via OLLAMA_READ_TIMEOUT for slower hardware or larger models.
_READ_TIMEOUT_S = float(os.getenv("OLLAMA_READ_TIMEOUT", "300"))
_OLLAMA_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=_READ_TIMEOUT_S,
    write=30.0,
    pool=10.0,
)


class _LimitsCache:
    """Tiny cache of the appliance's /health.limits — refreshed on 503 or on init.

    The Jetson appliance exposes its Ollama queue limits via /health so the
    orchestrator can size outbound concurrency. We debounce refreshes so a
    burst of 503s doesn't hammer /health.
    """

    def __init__(self, base_url: str):
        self.base_url = base_url
        self.num_parallel = 1
        self.max_queue = 16
        self.max_loaded_models = 1
        self._last_refresh = 0.0
        self._refresh_min_interval = 30.0  # seconds; debounce

    @property
    def health_url(self) -> str:
        # base_url is the proxy URL; strip /proxy to hit /health on :8002 root.
        root = self.base_url.removesuffix("/proxy")
        return f"{root}/health"

    async def refresh(self, client: httpx.AsyncClient) -> None:
        now = time.monotonic()
        if now - self._last_refresh < self._refresh_min_interval:
            return
        self._last_refresh = now
        try:
            resp = await client.get(self.health_url, timeout=5.0)
            if resp.status_code == 200:
                limits = resp.json().get("limits") or {}
                self.num_parallel = int(limits.get("num_parallel", self.num_parallel))
                self.max_queue = int(limits.get("max_queue", self.max_queue))
                self.max_loaded_models = int(
                    limits.get("max_loaded_models", self.max_loaded_models)
                )
                logger.info(
                    "appliance_limits_refreshed: num_parallel=%d max_queue=%d max_loaded_models=%d",
                    self.num_parallel,
                    self.max_queue,
                    self.max_loaded_models,
                )
        except Exception as e:
            logger.warning("appliance_limits_refresh_failed: %s", e)


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
        self._limits = _LimitsCache(self.base_url)
        self._sema: asyncio.Semaphore | None = None
        # Track the size used to construct the current `_sema`. asyncio.Semaphore
        # only exposes the private CPython attr `_value` (current free slots,
        # not the original size), which can't be relied on for resize decisions
        # mid-flight or across Python versions. We keep our own copy.
        self._sema_size: int = 0
        # Outbound connection cap matches the appliance's parallel slot count.
        # Refreshed on first chat via _ensure_limits.
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=_OLLAMA_TIMEOUT,
            limits=httpx.Limits(max_connections=self._limits.num_parallel),
        )

    def _build_sema(self, num_parallel: int) -> None:
        """(Re)build the in-flight semaphore at the requested size."""
        size = max(1, num_parallel)
        self._sema = asyncio.Semaphore(size)
        self._sema_size = size

    async def _ensure_limits(self) -> None:
        """Lazy first-call refresh of the appliance's limits + semaphore creation."""
        if self._limits._last_refresh > 0:
            if self._sema is None:
                self._build_sema(self._limits.num_parallel)
            return
        await self._limits.refresh(self.client)
        if self._sema is None:
            self._build_sema(self._limits.num_parallel)

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
        await self._ensure_limits()
        body = {
            "model": model,
            "messages": [m.model_dump(exclude_none=True) for m in messages],
            "stream": stream,
        }
        has_tools = bool(kwargs.get("tools"))
        # When tools are present, default temperature=0 so tool-call output is stable.
        if has_tools and kwargs.get("temperature") is None:
            body["temperature"] = 0.0
        # Pass through supported kwargs (caller's explicit value overrides our default).
        for k in ("temperature", "max_tokens"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        if has_tools:
            body["tools"] = [
                t.model_dump() if hasattr(t, "model_dump") else t
                for t in kwargs["tools"]
            ]

        if not stream:
            assert self._sema is not None  # set by _ensure_limits
            async with self._sema:
                resp = await self.client.post("/v1/chat/completions", json=body)
            if resp.status_code == 503:
                # The appliance is signaling overload (model_loading or circuit_open).
                # Refresh limits, resize the semaphore, then bubble up so the caller
                # can honor Retry-After and decide whether to retry.
                retry = resp.headers.get("Retry-After", "30")
                await self._limits.refresh(self.client)
                if self._sema_size != self._limits.num_parallel:
                    self._build_sema(self._limits.num_parallel)
                logger.warning(
                    "appliance_503_received: retry_after=%s body=%s",
                    retry,
                    resp.text[:200],
                )
            resp.raise_for_status()
            return resp.json()

        return self._stream_chat(body)

    async def _stream_chat(self, body: dict) -> AsyncGenerator[str, None]:
        # Streaming path is also semaphore-gated so we don't exceed num_parallel.
        assert self._sema is not None  # set by _ensure_limits in chat()
        async with self._sema:
            async with self.client.stream(
                "POST", "/v1/chat/completions", json=body
            ) as resp:
                if resp.status_code == 503:
                    await self._limits.refresh(self.client)
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

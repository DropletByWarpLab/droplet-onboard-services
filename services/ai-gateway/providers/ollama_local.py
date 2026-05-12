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

# Canonical chat path: direct to Ollama (port 11434), NOT through
# ollama-manager's /proxy on :8002. ollama-manager owns model lifecycle
# (pull/delete/manifest) and exposes an OPT-IN /proxy that adds tool-call
# observability + JSON repair, but its 120s read timeout (TIMEOUT_PROXY
# in droplet-jetson-ai/services/ollama-manager/timeouts.py) is too tight
# for the orchestrator's agent loop on CPU. Production .env already
# points at `inference-engine.local:11434` (direct); this default makes
# the macOS / fresh-install / unit-test paths agree with production.
# Override via JETSON_OLLAMA_URL to opt back into the /proxy (e.g. when
# you want the tool-call repair + circuit-breaker for a specific deploy).
# See ADR-004 in the droplet-jetson-ai repo for the original rationale.
JETSON_OLLAMA_URL = os.getenv("JETSON_OLLAMA_URL", "http://host.docker.internal:11434")

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

    Schema-version awareness (WARP-284):

    The appliance ships ``schema_version`` as a top-level integer in the
    /health response. This class carries ``_KNOWN_SCHEMA_VERSION`` — the
    version this orchestrator was built against — and logs a structured
    warning whenever the live appliance's version differs:

    * absent: pre-WARP-284 appliance — log warning, fall back to existing
      behavior (read limits by name).
    * equal: silent. Happy path.
    * newer: log warning. The appliance has been updated; the orchestrator
      may be ignoring new fields. Update ``_KNOWN_SCHEMA_VERSION`` and any
      consumers, then redeploy.
    * older: log warning. The appliance is on stale code; pull and
      re-run setup.sh on it.

    The point is forward compatibility — we never hard-fail on version
    mismatch, so a planned appliance bump can roll out independently. The
    warning log is the canary; until the shared-contracts package lands
    (audit option B) this is the cheapest drift detector available.
    """

    # Version of the /health schema this code knows. Bump in lockstep with
    # ``services/ollama-manager/main.py::_HEALTH_SCHEMA_VERSION`` in the
    # appliance repo. See ``droplet-jetson-ai/docs/model-management.md``
    # for the canonical schema-history table.
    _KNOWN_SCHEMA_VERSION = 1

    # Sentinel for "we haven't observed a schema_version yet" — distinct
    # from None ("appliance returned no schema_version key"). Without this,
    # the first observation of a missing key would silently equal the
    # initial state and skip the warning log.
    _SCHEMA_VERSION_UNOBSERVED = object()

    def __init__(self, base_url: str):
        self.base_url = base_url
        self.num_parallel = 1
        self.max_queue = 16
        self.max_loaded_models = 1
        self._last_refresh = 0.0
        self._refresh_min_interval = 30.0  # seconds; debounce
        # Track the last observed schema version so we only log on each new
        # observation, not on every refresh while the version is "wrong".
        # Starts at a sentinel distinct from None so a missing version key
        # is correctly detected as a first observation.
        self._last_seen_schema_version: object = self._SCHEMA_VERSION_UNOBSERVED

    @property
    def health_url(self) -> str:
        # base_url is the proxy URL; strip /proxy to hit /health on :8002 root.
        root = self.base_url.removesuffix("/proxy")
        return f"{root}/health"

    def _check_schema_version(self, body: dict) -> None:
        """Compare the appliance's schema_version against what we know.

        Logs a warning on first observation of any non-equal version. Silent
        on subsequent refreshes that observe the same version, so a long-lived
        appliance/orchestrator pair on different versions doesn't spam.
        """
        observed = body.get("schema_version")
        if observed == self._last_seen_schema_version:
            return  # already logged (or already silent on equal)
        self._last_seen_schema_version = observed

        if observed is None:
            logger.warning(
                "appliance_schema_version_missing: pre-WARP-284 appliance "
                "(known=%d). Reading limits by name; redeploy the appliance "
                "to pick up the versioned contract.",
                self._KNOWN_SCHEMA_VERSION,
            )
            return
        if not isinstance(observed, int):
            logger.warning(
                "appliance_schema_version_invalid: got %r, expected int",
                observed,
            )
            return
        if observed == self._KNOWN_SCHEMA_VERSION:
            return  # happy path — silent
        if observed > self._KNOWN_SCHEMA_VERSION:
            logger.warning(
                "appliance_schema_version_newer_than_known: "
                "appliance=%d orchestrator=%d. The appliance has been "
                "updated; the orchestrator may be ignoring new /health "
                "fields. Bump _KNOWN_SCHEMA_VERSION in ollama_local.py "
                "and any consumers.",
                observed,
                self._KNOWN_SCHEMA_VERSION,
            )
            return
        logger.warning(
            "appliance_schema_version_older_than_known: "
            "appliance=%d orchestrator=%d. The appliance is on stale "
            "code; pull and re-run setup.sh on the Jetson.",
            observed,
            self._KNOWN_SCHEMA_VERSION,
        )

    async def refresh(self, client: httpx.AsyncClient) -> None:
        now = time.monotonic()
        if now - self._last_refresh < self._refresh_min_interval:
            return
        self._last_refresh = now
        try:
            resp = await client.get(self.health_url, timeout=5.0)
            if resp.status_code == 200:
                body = resp.json()
                self._check_schema_version(body)
                limits = body.get("limits") or {}
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

    async def _handle_appliance_503(self, retry_after: str, body_preview: str) -> None:
        """Shared 503 handler for both streaming and non-streaming chat paths.

        The appliance signals overload via 503 (model_loading, circuit_open, or
        queue full). Refresh ``/health`` so we pick up the current
        ``num_parallel``, and rebuild the semaphore if it changed so subsequent
        calls match the appliance's new slot count.

        Both ``chat()`` (non-streaming) and ``_stream_chat()`` MUST go through
        this so the streaming path doesn't silently miss a scale-up event
        (silver-tier review issue I-4).
        """
        await self._limits.refresh(self.client)
        if self._sema_size != self._limits.num_parallel:
            self._build_sema(self._limits.num_parallel)
        logger.warning(
            "appliance_503_received: retry_after=%s body=%s",
            retry_after,
            body_preview,
        )

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
                # Appliance overload (model_loading / circuit_open / queue full).
                # Refresh limits + rebuild sema, then bubble up so the caller can
                # honor Retry-After and decide whether to retry.
                await self._handle_appliance_503(
                    resp.headers.get("Retry-After", "30"),
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
                    # Same handler the non-streaming branch uses, so a scale-up
                    # signaled via 503 is not silently missed here (I-4).
                    body_preview = (await resp.aread()).decode(errors="replace")[:200]
                    await self._handle_appliance_503(
                        resp.headers.get("Retry-After", "30"),
                        body_preview,
                    )
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

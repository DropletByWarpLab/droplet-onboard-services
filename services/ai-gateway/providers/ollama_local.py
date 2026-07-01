"""Ollama provider — routes to the local Ollama instance.

Deployment-shape-aware: targets the bundled `ollama` container (single-box),
a separate Ollama host over LAN (multi-box), or a host-installed Ollama
(local dev) — driven entirely by OLLAMA_URL. The provider has no
opinion about the underlying hardware (discrete GPU, integrated GPU,
NPU, CPU fallback, etc.) — it just talks HTTP.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import AsyncGenerator

import httpx

from capabilities import ollama_capabilities_from_show
from providers.base import BaseProvider
from request_context import get_request_id
from schemas import ChatMessage, ModelCapabilities, ModelInfo

logger = logging.getLogger(__name__)

# Canonical chat path: direct to Ollama (port 11434), NOT through
# ollama-manager's /proxy on :8002. ollama-manager owns model lifecycle
# (pull/delete/manifest) and exposes an OPT-IN /proxy that adds tool-call
# observability + JSON repair, but its 120s read timeout (TIMEOUT_PROXY
# in droplet-local-LLM/services/ollama-manager/timeouts.py) is too tight
# for the orchestrator's agent loop on CPU. The compose default below
# (`host.docker.internal:11434`) targets a host-installed Ollama for
# local Docker Desktop dev — note ai-gateway does not currently have the
# `extra_hosts: host.docker.internal:host-gateway` mapping, so this only
# resolves on Docker Desktop, not stock Linux. On the single-box PoC the
# orchestrator runs with OLLAMA_URL=http://droplet-ollama:11434 (the
# bundled Ollama container on the compose default network); on a
# multi-box deployment with a separate inference host, point at its
# static IP. Override via OLLAMA_URL to opt into the /proxy if you want
# the tool-call repair + circuit-breaker for a specific deploy.
# See ADR-004 in the droplet-local-LLM repo for the original rationale.
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434")

# XR-05: /health (the appliance limits + readiness contract) lives on
# ollama-manager (:8002), NOT on Ollama (:11434). On the canonical DIRECT chat
# path OLLAMA_URL points at :11434, so probing "{OLLAMA_URL}/health" 404s — the
# limits never size (outbound concurrency stuck at 1) and /ai/readiness is
# perpetually "degraded". OLLAMA_MANAGER_URL decouples the lifecycle/health
# endpoint from the chat endpoint. When it's unset AND OLLAMA_URL isn't the
# opt-in /proxy path (i.e. the manager isn't deployed — single-box today), we
# skip the probe entirely and run with sane default limits rather than spamming
# 404s. See droplet-local-LLM/services/ollama-manager (the /health owner).
OLLAMA_MANAGER_URL = os.getenv("OLLAMA_MANAGER_URL") or None


def _resolve_manager_health_url(base_url: str) -> str | None:
    """Return the ollama-manager /health URL, or None if no manager is wired.

    Precedence:
      1. explicit OLLAMA_MANAGER_URL → ``{manager}/health``
      2. OLLAMA_URL ending in ``/proxy`` (the opt-in manager chat path) →
         strip ``/proxy`` and use that root's ``/health`` (preserves the prior
         behavior for that specific deploy)
      3. otherwise None — the manager isn't deployed; skip the probe.
    """
    if OLLAMA_MANAGER_URL:
        return f"{OLLAMA_MANAGER_URL.rstrip('/')}/health"
    if base_url.endswith("/proxy"):
        return f"{base_url[: -len('/proxy')].rstrip('/')}/health"
    return None

# Cold-loading a large model can take 30-90s (e.g. 8B Q4 with partial GPU
# offload), and long completions can stream for minutes. The previous flat
# 60s timeout aborted the request mid-load, returning HTTP 499 to the user
# and an apparent "slow" chat. Override via OLLAMA_READ_TIMEOUT for slower
# hardware or larger models.
_READ_TIMEOUT_S = float(os.getenv("OLLAMA_READ_TIMEOUT", "300"))
_OLLAMA_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=_READ_TIMEOUT_S,
    write=30.0,
    pool=10.0,
)

# Upper bound on the httpx connection pool. The REAL concurrency gate is the
# in-flight semaphore (`_sema`), which is sized from the appliance's
# `num_parallel` and resized on a 503 scale-up. The connection pool only has to
# stay at-or-above whatever the semaphore admits, so we size it to a generous
# fixed cap rather than pinning it at construction-time `num_parallel` (which is
# 1 before the first /health refresh — the GW-13 bug, where a later scale-up
# resized the semaphore but left the pool serializing every chat through one
# connection). Connection reuse to a single Ollama host is cheap; an over-large
# cap costs nothing because the semaphore never lets that many requests run at
# once. Override for exotic deploys via OLLAMA_MAX_CONNECTIONS.
_MAX_CONNECTIONS = int(os.getenv("OLLAMA_MAX_CONNECTIONS", "64"))

# We ALWAYS talk to Ollama's OpenAI-compatible chat endpoint, never the native
# `/api/chat`. This keeps the request/response shape identical to the cloud
# providers (one code path in router.py) and is the canonical direct-to-:11434
# contract. The body therefore uses OpenAI field names (top-level
# `temperature` / `max_tokens`); see the note in `chat()` (GW-12).
_CHAT_PATH = "/v1/chat/completions"


class _LimitsCache:
    """Tiny cache of the appliance's /health.limits — refreshed on 503 or on init.

    The inference layer exposes its Ollama queue limits via /health so the
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
    # appliance repo. See ``droplet-local-LLM/docs/model-management.md``
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
        # XR-05: the ollama-manager /health URL, or None when no manager is
        # deployed (the direct :11434 path). None → skip the probe + keep
        # default limits instead of 404-ing against Ollama.
        self._manager_health_url: str | None = _resolve_manager_health_url(base_url)
        # Logged-once flag so a no-manager deploy notes the skip a single time
        # rather than on every refresh attempt.
        self._logged_no_manager = False
        # Track the last observed schema version so we only log on each new
        # observation, not on every refresh while the version is "wrong".
        # Starts at a sentinel distinct from None so a missing version key
        # is correctly detected as a first observation.
        self._last_seen_schema_version: object = self._SCHEMA_VERSION_UNOBSERVED

    @property
    def health_url(self) -> str | None:
        """ollama-manager's /health URL, or None when no manager is wired."""
        return self._manager_health_url

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
            "code; pull and re-run setup.sh on the inference host.",
            observed,
            self._KNOWN_SCHEMA_VERSION,
        )

    async def refresh(self, client: httpx.AsyncClient) -> None:
        now = time.monotonic()
        if now - self._last_refresh < self._refresh_min_interval:
            return
        self._last_refresh = now
        # XR-05: no ollama-manager wired (direct :11434 path) → don't probe a
        # non-existent /health on Ollama. Keep the sane defaults and note it
        # once. Marking _last_refresh above means _ensure_limits treats limits
        # as "settled" (at defaults) and won't retry every call.
        health_url = self.health_url
        if health_url is None:
            if not self._logged_no_manager:
                self._logged_no_manager = True
                logger.info(
                    "appliance_limits_probe_skipped: no OLLAMA_MANAGER_URL and "
                    "OLLAMA_URL is the direct path — using default limits "
                    "(num_parallel=%d, max_queue=%d, max_loaded_models=%d). "
                    "Set OLLAMA_MANAGER_URL to size outbound concurrency.",
                    self.num_parallel,
                    self.max_queue,
                    self.max_loaded_models,
                )
            return
        try:
            resp = await client.get(health_url, timeout=5.0)
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
    """Provider for the local Ollama instance.

    Endpoint is configured via OLLAMA_URL; works against the bundled
    `ollama` compose service (single-box), a separate inference host
    over LAN (multi-box), or a host-installed Ollama (local dev).
    """

    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or OLLAMA_URL).rstrip("/")
        self._limits = _LimitsCache(self.base_url)
        self._sema: asyncio.Semaphore | None = None
        # Track the size used to construct the current `_sema`. asyncio.Semaphore
        # only exposes the private CPython attr `_value` (current free slots,
        # not the original size), which can't be relied on for resize decisions
        # mid-flight or across Python versions. We keep our own copy.
        self._sema_size: int = 0
        # Connection pool is sized to a generous fixed cap, NOT to
        # `num_parallel`. The in-flight semaphore (`_sema`, resized on scale-up)
        # is the authoritative concurrency limit; the pool just has to stay at
        # or above it. Pinning the pool at construction-time `num_parallel` (1,
        # pre-first-refresh) was GW-13: a later semaphore resize was defeated
        # because httpx still serialized every chat through a single connection.
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=_OLLAMA_TIMEOUT,
            limits=httpx.Limits(max_connections=_MAX_CONNECTIONS),
        )
        # Per-model capability cache (vision/tools). Model capabilities are
        # immutable for a given tag, so we probe `/api/show` once per id and
        # reuse the result across list_models calls.
        self._caps_cache: dict[str, ModelCapabilities | None] = {}

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

    async def _capabilities(self, model: str) -> ModelCapabilities | None:
        """Best-effort capability probe via Ollama `/api/show`, cached per id.

        Returns None when the daemon is unreachable or errors — callers treat
        unknown capabilities conservatively (non-vision → OCR fallback).
        """
        if model in self._caps_cache:
            return self._caps_cache[model]
        caps: ModelCapabilities | None = None
        try:
            resp = await self.client.post("/api/show", json={"model": model})
            resp.raise_for_status()
            caps = ollama_capabilities_from_show(resp.json())
        except Exception as e:  # noqa: BLE001 — probe is best-effort
            logger.debug("ollama /api/show failed for %s: %s", model, e)
        self._caps_cache[model] = caps
        return caps

    async def list_models(self) -> list[ModelInfo]:
        try:
            resp = await self.client.get("/api/tags")
            resp.raise_for_status()
            data = resp.json()
            out: list[ModelInfo] = []
            for m in data.get("models", []):
                name = m["name"]
                out.append(
                    ModelInfo(
                        id=name,
                        provider="ollama",
                        name=prettify_ollama_name(name),
                        context_window=None,
                        capabilities=await self._capabilities(name),
                    )
                )
            return out
        except httpx.ConnectError:
            logger.warning("Ollama unreachable at %s", self.base_url)
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
        # Pass through supported generation controls (caller's explicit value
        # overrides our default).
        #
        # GW-12: these are OpenAI-compat field names — `temperature` and
        # `max_tokens` at the TOP LEVEL — which is correct because we always
        # POST to Ollama's OpenAI-compat `/v1/chat/completions` (see
        # _CHAT_PATH and the direct-to-:11434 rule in this module's header).
        # Ollama's NATIVE `/api/chat` ignores these top-level keys and instead
        # reads `options.{temperature,num_predict}`, so `max_tokens` would
        # silently become a no-op there. We deliberately do NOT support the
        # native endpoint; if that ever changes, map max_tokens→
        # options.num_predict and temperature→options.temperature here rather
        # than dropping them.
        for k in ("temperature", "max_tokens"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        if has_tools:
            body["tools"] = [
                t.model_dump() if hasattr(t, "model_dump") else t
                for t in kwargs["tools"]
            ]

        if not stream:
            rid = get_request_id()
            headers = {"x-request-id": rid} if rid else None
            assert self._sema is not None  # set by _ensure_limits
            async with self._sema:
                resp = await self.client.post(_CHAT_PATH, json=body, headers=headers)
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
        rid = get_request_id()
        headers = {"x-request-id": rid} if rid else None
        assert self._sema is not None  # set by _ensure_limits in chat()
        async with self._sema:
            async with self.client.stream(
                "POST", _CHAT_PATH, json=body, headers=headers
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

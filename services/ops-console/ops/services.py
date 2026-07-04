"""Fan-out probes against every Droplet service's /health endpoint.

The compose file already declares per-container HEALTHCHECK directives,
which docker uses to restart sick containers. THAT is the ground
truth for "is this container alive". This module is a SECOND opinion:
it confirms that the container's HTTP layer answers from a different
process (the ops-console) at the same moment — catching cases where
the container is "running" per docker but the FastAPI worker is wedged
inside a Python deadlock and HEALTHCHECK was generous enough to miss.

Probe shape
-----------
Each service in the registry maps to one URL. We GET it with a small
timeout, classify the result into one of:

  ok        — HTTP 2xx within timeout
  degraded  — HTTP 2xx but slow, OR 4xx (service answered but flagged)
  down      — HTTP 5xx, transport error, timeout
  unknown   — registry entry exists but env URL is empty (not deployed)

We collect rich error info on `down`/`degraded` so the operator does
not have to ssh in to see the exception text.

Registry mutability
-------------------
The set of services is hard-coded here, not pulled from
docker-compose at runtime. Two reasons:

  1. /var/run/docker.sock CAN tell us what's running, but not what
     URL each container exposes /health on. We'd have to encode that
     same lookup table somewhere — might as well live next to the
     probe code.
  2. compose is in a sibling repo dir; trying to parse it crosses a
     boundary the ops-console container can't see.

If a new service joins the stack, add it to SERVICE_REGISTRY here
and rebuild the image. That's a deliberate friction point — this
file is the operator's "here is what should be running" reference.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import urllib.parse
from dataclasses import dataclass, asdict
from typing import Any, Literal

import httpx

# WARP-236 — internal mTLS: rewrite first-party probe URLs to https:// and
# present ops-console's client cert when DROPLET_INTERNAL_TLS=1. Third-party
# probe targets (frigate :5000, web-dashboard) whose OPS_PROBE_* stay http://
# are rewritten too when the flag is on and are documented as out-of-scope —
# operators can point their OPS_PROBE_* at the real health path if a target
# doesn't speak TLS.
from _shared.internal_tls import base_url as _internal_base_url, httpx_client_kwargs

logger = logging.getLogger("ops.services")

# Timeouts: tight enough to flag real wedging, loose enough that a
# busy appliance host under load does not get marked down. 1.5s connect + 3s
# read matches what a human would call "felt slow" in a UI.
_PROBE_TIMEOUT = httpx.Timeout(connect=1.5, read=3.0, write=3.0, pool=3.0)

# Slow threshold for "degraded" classification on 2xx. If the request
# took longer than this but still returned 200, we surface it so the
# operator notices BEFORE the service hard-fails.
_SLOW_MS = 1500.0

ProbeStatus = Literal["ok", "degraded", "down", "unknown"]


@dataclass
class ProbeResult:
    name: str
    url: str | None                   # None means "no env URL set"
    status: ProbeStatus
    http_status: int | None           # None on transport error / unknown
    latency_ms: float | None
    detail: str | None                # human-readable reason for non-ok


# Registry: every service the operator should know about. URL is read
# from env so this same image works in dev (localhost ports) and POC
# (compose service DNS names). Defaults match docker-compose internal
# DNS — the ops-console runs in the same compose network.
#
# When env URL is empty/unset, we treat it as "not deployed in this
# profile" and emit unknown rather than down. Avoids spamming the UI
# for services that legitimately aren't part of the photo-studio POC
# (e.g. Frigate is only loaded when cameras are configured).
#
# URL validation: operator-controlled URLs are restricted to http(s)
# scheme + compose-DNS-shaped hostnames (alphanumeric + hyphens, or
# `host.docker.internal`). This prevents a misconfigured or
# attacker-pre-planted OPS_PROBE_* env var from turning the
# ops-console into an SSRF oracle (e.g. probing cloud metadata at
# 169.254.169.254 or reading file:// URIs). Invalid URLs are logged
# and treated as "not configured" rather than crashing the route.

# Allow http and https only (no file://, ftp://, gopher://, etc.).
_ALLOWED_SCHEMES = frozenset({"http", "https"})

# Hostname grammar: bare DNS label (compose service name) or the
# host.docker.internal alias for talking to the host gateway. No IP
# literals, no public hostnames. Compose DNS names are
# RFC 1035-shaped: start with a letter, then letters/digits/hyphens.
_ALLOWED_HOST_RE = re.compile(
    r"^(host\.docker\.internal|[a-z0-9][a-z0-9\-]*)$"
)


def _validate_probe_url(name: str, url: str) -> str:
    """Return `url` if it points at an allowed scheme + host; else "" + log.

    Empty input passes through (treated as "not configured" upstream).
    """
    if not url:
        return ""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        logger.warning("OPS_PROBE_%s rejected: malformed URL", name.upper())
        return ""
    if parsed.scheme not in _ALLOWED_SCHEMES:
        logger.warning(
            "OPS_PROBE_%s rejected: scheme %r not in %s",
            name.upper(), parsed.scheme, sorted(_ALLOWED_SCHEMES),
        )
        return ""
    host = (parsed.hostname or "").lower()
    if not _ALLOWED_HOST_RE.match(host):
        logger.warning(
            "OPS_PROBE_%s rejected: host %r not an allowed compose DNS name "
            "(must match %s)", name.upper(), host, _ALLOWED_HOST_RE.pattern,
        )
        return ""
    return url


def _u(env_name: str, default: str) -> str:
    """Read OPS_PROBE_* env, fall back to default, validate scheme + host.

    Tolerates misconfiguration: an invalid URL falls back to empty (the
    service surfaces as `unknown` rather than crashing the registry).
    """
    raw = os.environ.get(env_name, default).strip()
    return _validate_probe_url(env_name, raw)


def build_registry() -> dict[str, str]:
    """Service name → /health URL. Built fresh each call so tests can
    monkeypatch env between runs.

    Default URLs were verified empirically against the live POC on
    2026-05-15 — the comments below note WHICH ones were observed
    to answer 200 and which are intentionally blank.

    Services with empty default URLs DO exist in the stack but
    intentionally don't expose an HTTP /health endpoint (background
    workers, no FastAPI). They surface as `unknown` in /ops/services
    and rely on /ops/containers for liveness — the docker container
    state IS their health check. To enable an HTTP probe for any of
    them, set the matching OPS_PROBE_* env to a real URL.
    """
    return {
        # --- verified live on POC ---
        "orchestrator":      _u("OPS_PROBE_ORCHESTRATOR",      "http://orchestrator:3000/api/orchestrator/health"),
        "ai-gateway":        _u("OPS_PROBE_AI_GATEWAY",        "http://ai-gateway:8000/ai/health"),
        # WARP-227: renamed voice-orchestrator → voice-io. Registry key
        # tracks the compose service name so /ops/services output matches
        # what the operator sees in `docker compose ps`.
        "voice-io":          _u("OPS_PROBE_VOICE",             "http://voice-io:8086/health"),
        "frigate":           _u("OPS_PROBE_FRIGATE",           "http://frigate:5000/healthz"),
        # WARP-535: the dashboard now ships /healthz (Next.js route
        # handler at apps/web-dashboard/src/app/healthz/route.ts) as the
        # OTA update agent's liveness signal. This probe dials the compose
        # service DNS name (container IP), independent of the loopback
        # bind inside the container. Keep in lockstep with the compose
        # default (docker/docker-compose.yml ops-console environment).
        "web-dashboard":     _u("OPS_PROBE_WEB_DASHBOARD",     "http://web-dashboard:3001/healthz"),
        # --- no HTTP /health endpoint exposed; container state is the check ---
        # file-indexer is a daemon that watches Nextcloud — no HTTP layer.
        "file-indexer":      _u("OPS_PROBE_FILE_INDEXER",      ""),
        # camera-discovery exposes FastAPI but the POC instance was not
        # binding the port at the time of the empirical check. Default
        # blank until that's tightened; set the env if you've confirmed it.
        "camera-discovery":  _u("OPS_PROBE_CAMERA_DISCOVERY",  ""),
        "device-identity":   _u("OPS_PROBE_DEVICE_IDENTITY",   ""),
        "mcp-server":        _u("OPS_PROBE_MCP",               ""),
        "routing":           _u("OPS_PROBE_ROUTING",           ""),
        "switch":            _u("OPS_PROBE_SWITCH",            ""),
        "nextcloud":         _u("OPS_PROBE_NEXTCLOUD",         ""),
        # --- infrastructure: db / cache / broker have no HTTP face ---
        "db":                _u("OPS_PROBE_DB",                ""),
        "cache":             _u("OPS_PROBE_CACHE",             ""),
        "broker":            _u("OPS_PROBE_BROKER",            ""),
    }


async def _probe_one(
    client: httpx.AsyncClient,
    name: str,
    url: str,
) -> ProbeResult:
    if not url:
        return ProbeResult(
            name=name, url=None, status="unknown",
            http_status=None, latency_ms=None,
            detail="no probe URL configured (likely not part of this profile)",
        )

    # WARP-236: rewrite http://→https:// for the probe when internal mTLS is on
    # (identity when off); the client already carries our cert.
    url = _internal_base_url(url)
    started = time.monotonic()
    try:
        resp = await client.get(url, timeout=_PROBE_TIMEOUT)
    except httpx.TimeoutException as exc:
        return ProbeResult(
            name=name, url=url, status="down",
            http_status=None, latency_ms=(time.monotonic() - started) * 1000,
            detail=f"timeout: {exc.__class__.__name__}",
        )
    except httpx.TransportError as exc:
        return ProbeResult(
            name=name, url=url, status="down",
            http_status=None, latency_ms=(time.monotonic() - started) * 1000,
            detail=f"transport error: {exc.__class__.__name__}: {exc}",
        )
    except Exception as exc:  # noqa: BLE001 — last-resort catch keeps the fan-out alive
        return ProbeResult(
            name=name, url=url, status="down",
            http_status=None, latency_ms=(time.monotonic() - started) * 1000,
            detail=f"unexpected error: {exc.__class__.__name__}: {exc}",
        )

    latency_ms = (time.monotonic() - started) * 1000
    code = resp.status_code

    if 200 <= code < 300:
        if latency_ms > _SLOW_MS:
            return ProbeResult(
                name=name, url=url, status="degraded",
                http_status=code, latency_ms=latency_ms,
                detail=f"slow response: {latency_ms:.0f}ms (threshold {_SLOW_MS:.0f}ms)",
            )
        return ProbeResult(
            name=name, url=url, status="ok",
            http_status=code, latency_ms=latency_ms, detail=None,
        )

    if 400 <= code < 500:
        # 4xx from a /health endpoint usually means "service is up but
        # is reporting itself unhealthy" — degraded, not down.
        return ProbeResult(
            name=name, url=url, status="degraded",
            http_status=code, latency_ms=latency_ms,
            detail=f"4xx from health endpoint: {code} (service self-reporting unhealthy)",
        )

    if code == 503:
        # 503 Service Unavailable from a /health probe is the conventional
        # "I'm alive but reporting myself unhealthy" signal — e.g. voice-io
        # latches its wake pipeline into a stuck-and-deaf state and returns
        # 503 on purpose. The container is fully up and answering, so this
        # is degraded, not down. (Genuine unreachability surfaces as a
        # transport error / timeout, already classified down above.) Other
        # 5xx — 500/502/504 — indicate the service or its gateway is broken
        # rather than self-reporting, so they stay down.
        return ProbeResult(
            name=name, url=url, status="degraded",
            http_status=code, latency_ms=latency_ms,
            detail=f"503 from health endpoint: {code} (service self-reporting unhealthy)",
        )

    return ProbeResult(
        name=name, url=url, status="down",
        http_status=code, latency_ms=latency_ms,
        detail=f"5xx from health endpoint: {code}",
    )


async def probe_all(registry: dict[str, str] | None = None) -> list[ProbeResult]:
    """Probe every registered service in parallel. Always returns the
    full list (no exceptions escape) so the UI can render even when
    some probes fail."""
    reg = registry or build_registry()
    async with httpx.AsyncClient(**httpx_client_kwargs()) as client:
        tasks = [_probe_one(client, name, url) for name, url in reg.items()]
        return await asyncio.gather(*tasks)


def probe_all_dict(registry: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Synchronous wrapper for FastAPI handlers that prefer a sync
    return shape. Internally still uses the async client to fan out."""
    results = asyncio.run(probe_all(registry))
    return [asdict(r) for r in results]


def summarise(results: list[ProbeResult]) -> dict[str, int]:
    """Counts by status — handy for the UI's top-bar 'all green' badge."""
    out = {"ok": 0, "degraded": 0, "down": 0, "unknown": 0}
    for r in results:
        out[r.status] += 1
    return out

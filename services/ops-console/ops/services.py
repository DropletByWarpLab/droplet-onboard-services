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
import time
from dataclasses import dataclass, asdict
from typing import Any, Literal

import httpx

logger = logging.getLogger("ops.services")

# Timeouts: tight enough to flag real wedging, loose enough that a
# busy Pi under load does not get marked down. 1.5s connect + 3s read
# matches what a human would call "felt slow" in a UI.
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
def _u(env_name: str, default: str) -> str:
    return os.environ.get(env_name, default).strip()


def build_registry() -> dict[str, str]:
    """Service name → /health URL. Built fresh each call so tests can
    monkeypatch env between runs."""
    return {
        "orchestrator":      _u("OPS_PROBE_ORCHESTRATOR",      "http://orchestrator:3000/api/orchestrator/health"),
        "web-dashboard":     _u("OPS_PROBE_WEB_DASHBOARD",     "http://web-dashboard:3001/api/health"),
        "ai-gateway":        _u("OPS_PROBE_AI_GATEWAY",        "http://ai-gateway:8000/healthz"),
        "voice-orchestrator":_u("OPS_PROBE_VOICE",             "http://voice-orchestrator:8086/healthz"),
        "file-indexer":      _u("OPS_PROBE_FILE_INDEXER",      "http://file-indexer:8090/healthz"),
        "camera-discovery":  _u("OPS_PROBE_CAMERA_DISCOVERY",  "http://camera-discovery:8083/healthz"),
        "device-identity":   _u("OPS_PROBE_DEVICE_IDENTITY",   "http://device-identity-svc:8084/healthz"),
        "mcp-server":        _u("OPS_PROBE_MCP",               "http://mcp-server:8082/healthz"),
        "routing":           _u("OPS_PROBE_ROUTING",           "http://routing:8080/api/health"),
        "switch":            _u("OPS_PROBE_SWITCH",            "http://switch:8081/healthz"),
        "nextcloud":         _u("OPS_PROBE_NEXTCLOUD",         "http://nextcloud:9090/health"),
        "frigate":           _u("OPS_PROBE_FRIGATE",           "http://frigate:5000/api/version"),
        # Infra without HTTP /health — leave URL empty in env to skip:
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
    async with httpx.AsyncClient() as client:
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

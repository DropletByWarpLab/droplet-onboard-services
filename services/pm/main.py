"""pm-health sidecar.

Exposes the team's standardized /health endpoint backed by a background
asyncio poll of Plane's internal /api/health. No `while True` (rule 9) —
the poller uses an asyncio.Event for cancellation.

Structured JSON logs per new-service-checklist.md.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from config import settings


# --- Structured JSON logging ----------------------------------------------

class JsonFormatter(logging.Formatter):
    """Single-line JSON log records. No PII (rule 9 — truthful structured logs)."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: D401
        import json

        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "service": "pm-health",
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, separators=(",", ":"))


def _configure_logging() -> logging.Logger:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    return logging.getLogger("pm-health")


logger = _configure_logging()


# --- Health cache (eviction by age, not unbounded — rule 12) --------------

class HealthCache:
    """Single-slot cache. Holds last poll result + timestamp."""

    def __init__(self) -> None:
        self._last_ok: bool = False
        self._last_ts: float = 0.0
        self._lock = asyncio.Lock()

    async def update(self, *, ok: bool) -> None:
        async with self._lock:
            self._last_ok = ok
            self._last_ts = time.time()

    async def snapshot(self) -> tuple[bool, float]:
        async with self._lock:
            return self._last_ok, self._last_ts


cache = HealthCache()


# --- Background poller (no `while True` — uses an Event) ------------------

async def _poll_plane(stop: asyncio.Event) -> None:
    """Poll Plane /api/health on a cadence until cancelled."""
    timeout = httpx.Timeout(5.0, connect=2.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        while not stop.is_set():
            ok = False
            try:
                resp = await client.get(f"{settings.api_url}/api/health")
                ok = resp.status_code == 200
            except httpx.HTTPError as exc:
                logger.warning("plane_health_poll_failed: %s", exc)
            await cache.update(ok=ok)
            try:
                await asyncio.wait_for(
                    stop.wait(),
                    timeout=settings.health_poll_interval,
                )
            except asyncio.TimeoutError:
                continue


# --- FastAPI lifespan + route ---------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
    stop = asyncio.Event()
    poller = asyncio.create_task(_poll_plane(stop))
    logger.info("pm_health_sidecar_started")
    try:
        yield
    finally:
        stop.set()
        try:
            await asyncio.wait_for(poller, timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            poller.cancel()
        logger.info("pm_health_sidecar_stopped")


app = FastAPI(title="pm-health", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    """Standardized health response per 08-templates/new-service-checklist.md."""
    ok, ts = await cache.snapshot()
    age = time.time() - ts if ts else None

    # Result is degraded if (a) Plane unreachable on last poll OR
    # (b) cache is older than stale_after (poller died).
    fresh = ts != 0 and (age or 0) <= settings.health_stale_after
    status = "ok" if (ok and fresh) else "degraded"

    body = {
        "status": status,
        "service": "pm",
        "version": settings.plane_version,
        "plane_api_reachable": ok,
        "cache_age_seconds": age,
    }
    code = 200 if status == "ok" else 503
    return JSONResponse(status_code=code, content=body)

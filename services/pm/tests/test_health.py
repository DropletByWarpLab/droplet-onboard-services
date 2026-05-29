"""Unit tests for the pm-health sidecar.

Per 08-templates/new-service-checklist.md: cover happy path + at least
one failure mode per route. Mocks the Plane backend with respx.
"""

from __future__ import annotations

import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import main as pm_health
from main import app, cache


@pytest.fixture(autouse=True)
async def _reset_cache():
    """Cache is module-level singleton — reset between tests."""
    cache._last_ok = False
    cache._last_ts = 0.0
    yield


def test_health_returns_ok_when_plane_recently_reachable() -> None:
    """Happy path: cache says plane is up + cache is fresh → 200 ok."""
    import asyncio

    # Prime the cache with a recent successful poll.
    asyncio.run(cache.update(ok=True))
    cache._last_ts = time.time()

    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "pm"
    assert body["plane_api_reachable"] is True


def test_health_returns_degraded_when_cache_empty() -> None:
    """Failure: cache never primed (sidecar just started, no poll yet) → 503."""
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["plane_api_reachable"] is False


def test_health_returns_degraded_when_cache_stale() -> None:
    """Failure: cache older than stale_after → 503 even if last poll was ok."""
    import asyncio

    asyncio.run(cache.update(ok=True))
    # Force cache to look ancient.
    cache._last_ts = time.time() - 3600

    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 503
    assert resp.json()["status"] == "degraded"


@respx.mock
async def test_poller_updates_cache_on_success() -> None:
    """Integration: poller hits plane /api/health → cache reflects success."""
    import asyncio

    respx.get("http://pm-api:8000/api/health").mock(
        return_value=httpx.Response(200)
    )

    stop = asyncio.Event()
    poll_task = asyncio.create_task(pm_health._poll_plane(stop))
    # Let one iteration run, then cancel.
    await asyncio.sleep(0.1)
    stop.set()
    try:
        await asyncio.wait_for(poll_task, timeout=1.0)
    except asyncio.TimeoutError:
        poll_task.cancel()

    ok, ts = await cache.snapshot()
    assert ok is True
    assert ts > 0


@respx.mock
async def test_poller_records_failure_on_http_error() -> None:
    """Integration: poller catches httpx error → cache stays/becomes not-ok."""
    import asyncio

    respx.get("http://pm-api:8000/api/health").mock(
        side_effect=httpx.ConnectError("nope")
    )

    stop = asyncio.Event()
    poll_task = asyncio.create_task(pm_health._poll_plane(stop))
    await asyncio.sleep(0.1)
    stop.set()
    try:
        await asyncio.wait_for(poll_task, timeout=1.0)
    except asyncio.TimeoutError:
        poll_task.cancel()

    ok, _ = await cache.snapshot()
    assert ok is False

"""Health/readiness probes (routes/health.py)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

import main as main_mod


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.asyncio
async def test_healthz_ok():
    transport = ASGITransport(app=main_mod.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_readyz_503_when_db_pool_absent():
    # No pool initialized in a unit context -> not ready, never crashes.
    transport = ASGITransport(app=main_mod.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/readyz")
    assert resp.status_code == 503
    assert resp.json()["db"] is False

"""Tests for :mod:`auth` — bearer-token validation in AuthMiddleware.

Focus: the token comparison is constant-time (``hmac.compare_digest``) and still
behaves correctly — the correct token passes, any wrong token is rejected, and
``/health`` stays exempt.

``AUTH_TOKEN`` is a module global in ``auth`` (read at import), so each test
patches ``auth.AUTH_TOKEN`` directly via ``monkeypatch`` — fully isolated, with
no process-wide env mutation that would leak into other test modules.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import auth  # noqa: E402

TOKEN = "secret-token-123"


@pytest.fixture
def auth_enabled(monkeypatch):
    """Enable auth for the duration of a test, isolated to this module."""
    monkeypatch.setattr(auth, "AUTH_TOKEN", TOKEN)
    return TOKEN


def _make_app() -> FastAPI:
    """Minimal app: AuthMiddleware + one gated route + the exempt /health."""
    app = FastAPI()
    app.add_middleware(auth.AuthMiddleware)

    @app.get("/models/manifest")
    async def gated():
        return {"ok": True}

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app


async def _get(path: str, headers: dict | None = None):
    transport = ASGITransport(app=_make_app())
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        return await c.get(path, headers=headers or {})


def test_uses_constant_time_compare():
    """The middleware must compare via hmac.compare_digest, not ``!=``.

    Guards against a regression back to a short-circuiting string compare that
    leaks the token byte-by-byte through response timing.
    """
    import inspect

    src = inspect.getsource(auth.AuthMiddleware.dispatch)
    assert "compare_digest" in src, "token compare must use hmac.compare_digest"


@pytest.mark.asyncio
async def test_correct_token_passes(auth_enabled):
    resp = await _get(
        "/models/manifest", headers={"Authorization": f"Bearer {auth_enabled}"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


@pytest.mark.asyncio
async def test_wrong_token_rejected(auth_enabled):
    resp = await _get(
        "/models/manifest", headers={"Authorization": "Bearer wrong"}
    )
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Unauthorized"}


@pytest.mark.asyncio
async def test_missing_token_rejected(auth_enabled):
    resp = await _get("/models/manifest")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_health_still_exempt(auth_enabled):
    """Constant-time change must not affect the /health exemption."""
    resp = await _get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# --- WARP-LLM-06: extra deny/exempt coverage (salvaged from PR #22, adapted to
# main's import-time ``AUTH_TOKEN`` global + ``hmac.compare_digest``). The PR's
# per-request ``_current_token()`` refactor was dropped — it also swapped the
# constant-time compare for a plain ``!=``, a timing-attack regression. These
# cases run against main's unchanged, secure middleware. ----------------------


@pytest.mark.asyncio
async def test_malformed_scheme_rejected(auth_enabled):
    """A raw token without the ``Bearer `` scheme prefix → 401.

    The middleware compares the whole ``f"Bearer {token}"`` string, so a bare
    token (or any non-``Bearer`` scheme) must be rejected, not coerced.
    """
    resp = await _get(
        "/models/manifest", headers={"Authorization": auth_enabled}
    )
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Unauthorized"}


@pytest.mark.asyncio
async def test_health_trailing_slash_also_exempt(auth_enabled):
    """``/health/`` is exempt too — the middleware ``rstrip('/')``-normalizes.

    FastAPI 307-redirects ``/health/`` → ``/health``; following it must still
    succeed with no token, proving the trailing-slash variant is exempt rather
    than gated.
    """
    transport = ASGITransport(app=_make_app())
    async with AsyncClient(
        transport=transport, base_url="http://test", follow_redirects=True
    ) as c:
        resp = await c.get("/health/")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_empty_token_is_permissive(monkeypatch):
    """An empty ``AUTH_TOKEN`` (the dev/default) makes the middleware a no-op.

    With no token configured, a gated route is reachable with no
    ``Authorization`` header — the documented permissive dev mode.
    """
    monkeypatch.setattr(auth, "AUTH_TOKEN", "")
    resp = await _get("/models/manifest")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

"""WARP-598 — /health route on the file-indexer HTTP surface.

The route is a dependency-free liveness probe consumed by the
orchestrator health-monitor and the Docker healthcheck: a 200 means the
HTTP server — and the process hosting the watcher + scheduler threads —
is alive. Skips cleanly if FastAPI's test client deps aren't importable.
"""

from __future__ import annotations

import importlib

import pytest

# FastAPI is in requirements.txt (WARP-287 added the HTTP surface), but
# TestClient pulls in starlette/httpx — skip rather than error if a
# minimal env doesn't have them.
fastapi_testclient = pytest.importorskip("fastapi.testclient")


def _client():
    main = importlib.import_module("main")
    app = main.build_http_app()
    return fastapi_testclient.TestClient(app)


def test_health_returns_ok():
    resp = _client().get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "file-indexer"


def test_health_needs_no_auth_or_body():
    # Plain GET, no headers — the orchestrator health-monitor + Docker
    # healthcheck both hit it unauthenticated.
    resp = _client().get("/health")
    assert resp.status_code == 200

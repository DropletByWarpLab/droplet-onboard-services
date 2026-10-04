"""WARP-3625 — every file-indexer HTTP route except /health requires the bearer.

Fails CLOSED: 503 when FILE_INDEXER_SERVICE_TOKEN is unset, 401 without or with
a wrong bearer. Skips cleanly if FastAPI's test client deps aren't importable.
"""

from __future__ import annotations

import importlib
import re
import sys
import types

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")
from fastapi.routing import APIRoute  # noqa: E402

TOKEN = "t" * 64
NOT_CONFIGURED = "FILE_INDEXER_SERVICE_TOKEN unset"


@pytest.fixture()
def main(monkeypatch):
    m = importlib.import_module("main")
    monkeypatch.setattr(m, "FILE_INDEXER_SERVICE_TOKEN", TOKEN)
    return m


@pytest.fixture()
def api(main):
    return main.build_http_app()


@pytest.fixture()
def client(api, monkeypatch):
    # Past the gate the handler would reach the database; stub the indexer.
    monkeypatch.setitem(
        sys.modules,
        "brain_ingest",
        types.SimpleNamespace(reindex_one=lambda file_id: {"chunksWritten": 1}),
    )
    return fastapi_testclient.TestClient(api, raise_server_exceptions=False)


def test_app_wide_dependency_is_installed(main, api):
    assert main.require_bearer in [d.dependency for d in api.router.dependencies]


def test_only_health_is_exempt(main):
    assert main.AUTH_EXEMPT_PATHS == frozenset({"/health"})


def test_every_non_health_route_rejects_a_missing_bearer(main, api, client):
    routes = [
        (sorted(r.methods - {"HEAD", "OPTIONS"})[0], re.sub(r"\{[^}]+\}", "x", r.path))
        for r in api.routes
        if isinstance(r, APIRoute) and r.path not in main.AUTH_EXEMPT_PATHS
    ]
    assert routes, "route table not enumerated — guard would pass vacuously"
    assert ("POST", "/reindex/x") in routes
    for method, url in routes:
        assert client.request(method, url).status_code == 401, f"{method} {url}"


def test_wrong_bearer_is_401(client):
    r = client.post("/reindex/x", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_right_bearer_passes_the_gate(client):
    r = client.post("/reindex/x", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200
    assert r.json() == {"chunksWritten": 1}


def test_unset_token_fails_closed_with_503(main, client, monkeypatch):
    monkeypatch.setattr(main, "FILE_INDEXER_SERVICE_TOKEN", "")
    r = client.post("/reindex/x", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 503
    assert NOT_CONFIGURED in r.text


def test_health_needs_no_bearer(client):
    assert client.get("/health").status_code == 200

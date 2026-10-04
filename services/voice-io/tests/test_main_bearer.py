"""WARP-3625 — every voice-io route except /health requires the service bearer.

Fails CLOSED: 503 when VOICE_IO_SERVICE_TOKEN is unset, 401 without or with a
wrong bearer. The conftest autouse fixture opens the gate for the behaviour
tests; here it is closed again so the real dependency runs.
"""
from __future__ import annotations

import re

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import main

TOKEN = "t" * 64
NOT_CONFIGURED = "VOICE_IO_SERVICE_TOKEN unset"


@pytest.fixture
def client(monkeypatch):
    main.app.dependency_overrides.clear()
    monkeypatch.setattr(main, "VOICE_IO_SERVICE_TOKEN", TOKEN)
    # A handler that blows up past the gate is a 500, not a test error: this
    # file only asserts what the gate decided.
    return TestClient(main.app, raise_server_exceptions=False)


def _guarded_routes():
    return [
        (sorted(r.methods - {"HEAD", "OPTIONS"})[0], re.sub(r"\{[^}]+\}", "x", r.path))
        for r in main.app.routes
        if isinstance(r, APIRoute) and r.path not in main.AUTH_EXEMPT_PATHS
    ]


def test_app_wide_dependency_is_installed():
    assert main.require_bearer in [d.dependency for d in main.app.router.dependencies]


def test_only_health_is_exempt():
    assert main.AUTH_EXEMPT_PATHS == frozenset({"/health"})


def test_every_non_health_route_rejects_a_missing_bearer(client):
    routes = _guarded_routes()
    assert len(routes) > 15, "route table not enumerated — guard would pass vacuously"
    for method, url in routes:
        r = client.request(method, url)
        assert r.status_code == 401, f"{method} {url} -> {r.status_code}"


def test_wrong_bearer_is_401(client):
    r = client.get("/audio/devices", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    r = client.get("/audio/devices", headers={"Authorization": f"Basic {TOKEN}"})
    assert r.status_code == 401


def test_right_bearer_passes_the_gate(client):
    r = client.get("/audio/devices", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code != 401
    assert NOT_CONFIGURED not in r.text


def test_unset_token_fails_closed_with_503(client, monkeypatch):
    monkeypatch.setattr(main, "VOICE_IO_SERVICE_TOKEN", "")
    r = client.get("/audio/devices", headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 503
    assert NOT_CONFIGURED in r.text


def test_health_needs_no_bearer(client):
    r = client.get("/health")
    assert r.status_code != 401
    assert NOT_CONFIGURED not in r.text

"""Bearer auth — every route except /health requires WEB_FETCH_SERVICE_TOKEN.

- Missing / wrong / wrong-scheme tokens → 401.
- Unset token env → FAIL CLOSED: 503 on every non-/health route (no
  *_ALLOW_NO_AUTH dev escape on this service — it is the only component
  with outbound HTTP).
- /health stays open regardless (Docker healthcheck).
"""

from __future__ import annotations

import pytest

from tests.conftest import AUTH

# (method, path) — auth runs before any handler/provider work, so no mock
# transport is needed: the assertion is purely on the 401/503.
PROTECTED = [
    ("get", "/weather?location=Toulouse"),
    ("get", "/rates"),
]


def test_health_open_without_token(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_health_open_with_wrong_token(client):
    resp = client.get("/health", headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 200


@pytest.mark.parametrize("method,path", PROTECTED)
def test_rejects_missing_header(client, method, path):
    resp = getattr(client, method)(path)
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Unauthorized"


@pytest.mark.parametrize("method,path", PROTECTED)
def test_rejects_wrong_token(client, method, path):
    resp = getattr(client, method)(
        path, headers={"Authorization": "Bearer not-the-token"}
    )
    assert resp.status_code == 401


def test_rejects_wrong_scheme(client):
    """Basic / Token schemes must not smuggle past the bearer check."""
    resp = client.get(
        "/rates", headers={"Authorization": "Basic pytest-fake-token"}
    )
    assert resp.status_code == 401


@pytest.mark.parametrize("method,path", PROTECTED)
def test_fails_closed_when_token_unset(client, monkeypatch, method, path):
    """Unset WEB_FETCH_SERVICE_TOKEN must refuse ALL requests, even ones that
    present a token — a failed secret injection must not run this open."""
    import main

    monkeypatch.setattr(main, "WEB_FETCH_SERVICE_TOKEN", "")
    resp = getattr(client, method)(path, headers=AUTH)
    assert resp.status_code == 503
    assert "not configured" in resp.json()["detail"]


def test_health_still_open_when_token_unset(client, monkeypatch):
    import main

    monkeypatch.setattr(main, "WEB_FETCH_SERVICE_TOKEN", "")
    resp = client.get("/health")
    assert resp.status_code == 200

"""Bearer auth — every route except /health requires SANDBOX_SERVICE_TOKEN.

Missing / wrong / wrong-scheme tokens are 401. An UNSET token env fails CLOSED
with 503 on every non-/health route: there is no *_ALLOW_NO_AUTH escape,
because a failed secret injection at deploy must not leave a code-execution
service answering anything on the internal network.
"""

from __future__ import annotations

import main

BODY = {"code": "output = 1"}


def test_health_needs_no_token(client):
    assert client.get("/health").status_code == 200


def test_transform_rejects_a_missing_token(client):
    assert client.post("/transform", json=BODY).status_code == 401


def test_transform_rejects_a_wrong_token(client):
    assert client.post("/transform", json=BODY, headers={"Authorization": "Bearer nope"}).status_code == 401


def test_transform_rejects_a_wrong_scheme(client):
    r = client.post("/transform", json=BODY, headers={"Authorization": "Basic pytest-fake-token"})
    assert r.status_code == 401


def test_transform_accepts_the_configured_token(client, auth):
    r = client.post("/transform", json=BODY, headers=auth)
    assert r.status_code == 200
    assert r.json() == {"output": 1}


def test_unset_token_fails_closed_with_503(client, auth, monkeypatch):
    monkeypatch.setattr(main, "SANDBOX_SERVICE_TOKEN", "")
    assert client.post("/transform", json=BODY, headers=auth).status_code == 503
    assert client.get("/health").status_code == 200

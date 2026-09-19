"""Bearer auth — every route except /health requires DOC_RENDER_SERVICE_TOKEN.

Missing / wrong / wrong-scheme tokens are 401. An UNSET token env fails CLOSED
with 503 on every non-/health route: there is no *_ALLOW_NO_AUTH dev escape,
because a failed secret injection at deploy must not leave a document renderer
answering anything on the compose network. Same posture as web-fetch.
"""

from __future__ import annotations

import main

BODY = {"format": "pdf", "title": "t", "body_markdown": "b"}


def test_health_needs_no_token(client):
    assert client.get("/health").status_code == 200


def test_render_rejects_a_missing_token(client):
    assert client.post("/render", json=BODY).status_code == 401


def test_render_rejects_a_wrong_token(client):
    r = client.post("/render", json=BODY, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401


def test_render_rejects_a_wrong_scheme(client):
    r = client.post("/render", json=BODY, headers={"Authorization": "Basic pytest-fake-token"})
    assert r.status_code == 401


def test_render_accepts_the_configured_token(client, auth):
    r = client.post("/render", json=BODY, headers=auth)
    assert r.status_code == 200


def test_unset_token_fails_closed_with_503(client, auth, monkeypatch):
    monkeypatch.setattr(main, "DOC_RENDER_SERVICE_TOKEN", "")
    r = client.post("/render", json=BODY, headers=auth)
    assert r.status_code == 503


def test_health_still_answers_when_the_token_is_unset(client, monkeypatch):
    """The Docker healthcheck must not go red because a secret is missing."""
    monkeypatch.setattr(main, "DOC_RENDER_SERVICE_TOKEN", "")
    assert client.get("/health").status_code == 200

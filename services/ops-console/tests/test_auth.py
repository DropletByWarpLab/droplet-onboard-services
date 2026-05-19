"""auth.require_token — every failure mode + the happy path.

These tests use FastAPI's TestClient against a tiny app that wires
require_token on a single dummy route. Keeps the assertions about
auth alone; main.py wiring is covered by test_main.py.
"""
from __future__ import annotations

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


def _app(token: str = "test-token-for-pytest") -> TestClient:
    """Build a fresh app with an OPS_TOKEN set BEFORE auth import."""
    import importlib
    import os
    os.environ["OPS_TOKEN"] = token
    from ops import auth as auth_mod
    importlib.reload(auth_mod)

    app = FastAPI()

    @app.get("/probe", dependencies=[Depends(auth_mod.require_token)])
    def probe():
        return {"ok": True}

    return TestClient(app)


class TestRequireToken:

    def test_happy_path(self):
        c = _app("good-token")
        r = c.get("/probe", headers={"Authorization": "Bearer good-token"})
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_missing_authorization_header_401(self):
        c = _app()
        r = c.get("/probe")
        assert r.status_code == 401
        assert r.headers.get("www-authenticate") == "Bearer"
        assert "required" in r.json()["detail"].lower()

    def test_wrong_scheme_401(self):
        c = _app("good-token")
        r = c.get("/probe", headers={"Authorization": "Basic good-token"})
        assert r.status_code == 401
        assert "bearer" in r.json()["detail"].lower()

    def test_bearer_with_no_value_401(self):
        c = _app("good-token")
        r = c.get("/probe", headers={"Authorization": "Bearer "})
        assert r.status_code == 401

    def test_wrong_token_403(self):
        # Different status: 403 means "I see you tried, but no" —
        # client got past the malformed-header gate.
        c = _app("good-token")
        r = c.get("/probe", headers={"Authorization": "Bearer wrong-token"})
        assert r.status_code == 403
        assert "invalid" in r.json()["detail"].lower()

    def test_case_insensitive_scheme(self):
        # "bearer" / "BEARER" / "Bearer" all accepted — RFC 7235 says
        # scheme is case-insensitive. Cheap to support, surprising to
        # block.
        c = _app("good-token")
        for scheme in ("bearer", "BEARER", "Bearer", "BeArEr"):
            r = c.get("/probe", headers={"Authorization": f"{scheme} good-token"})
            assert r.status_code == 200, scheme

    def test_token_with_special_chars(self):
        # secrets.compare_digest doesn't care about charset — confirm
        # we don't accidentally normalise / strip.
        weird = "abc!@#$%^&*()_+-=[]{}|;:'\",.<>?/`~"
        c = _app(weird)
        r = c.get("/probe", headers={"Authorization": f"Bearer {weird}"})
        assert r.status_code == 200

    def test_ephemeral_token_when_env_unset(self, monkeypatch, caplog):
        # When OPS_TOKEN is unset, the module generates a token at
        # import time and logs a warning. The warning is the contract —
        # operators MUST notice they're running on a generated token.
        import importlib
        import logging
        monkeypatch.delenv("OPS_TOKEN", raising=False)
        with caplog.at_level(logging.WARNING, logger="ops.auth"):
            from ops import auth as auth_mod
            importlib.reload(auth_mod)
        assert any("OPS_TOKEN env not set" in r.message for r in caplog.records)
        # Generated token is 64 hex chars (32 bytes)
        assert len(auth_mod._OPS_TOKEN) == 64
        assert all(c in "0123456789abcdef" for c in auth_mod._OPS_TOKEN)

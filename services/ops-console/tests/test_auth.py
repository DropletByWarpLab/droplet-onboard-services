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

    def test_ephemeral_token_is_never_logged(self, monkeypatch, caplog):
        # WARP-3193 SEC-DATA-11: the token guards a docker.sock API, and
        # container logs leave the box in support bundles. Only a short
        # sha256 fingerprint may be logged, never the value.
        import hashlib
        import importlib
        import logging
        monkeypatch.delenv("OPS_TOKEN", raising=False)
        with caplog.at_level(logging.DEBUG, logger="ops.auth"):
            from ops import auth as auth_mod
            importlib.reload(auth_mod)
        text = "\n".join(r.getMessage() for r in caplog.records)
        assert auth_mod._OPS_TOKEN not in text
        fingerprint = hashlib.sha256(auth_mod._OPS_TOKEN.encode()).hexdigest()[:8]
        assert fingerprint in text


class TestSupportWindowExpiry:
    """WARP-3641: OPS_ACCESS_EXPIRES_AT ends the support window."""

    @staticmethod
    def _client(monkeypatch, expires: str | None, now_iso: str = "2026-10-03T12:00:00+00:00"):
        from datetime import datetime
        monkeypatch.delenv("OPS_ACCESS_EXPIRES_AT", raising=False)
        if expires is not None:
            monkeypatch.setenv("OPS_ACCESS_EXPIRES_AT", expires)
        c = _app("good-token")
        from ops import auth as auth_mod
        monkeypatch.setattr(auth_mod, "_now", lambda: datetime.fromisoformat(now_iso))
        return c, auth_mod

    def test_no_expiry_configured_keeps_working(self, monkeypatch):
        c, auth_mod = self._client(monkeypatch, None, "2099-01-01T00:00:00+00:00")
        assert auth_mod.window_description() == "support window: no expiry configured"
        assert c.get("/probe", headers={"Authorization": "Bearer good-token"}).status_code == 200

    def test_before_deadline_works(self, monkeypatch):
        c, _ = self._client(monkeypatch, "2026-10-03T18:00:00Z")
        assert c.get("/probe", headers={"Authorization": "Bearer good-token"}).status_code == 200

    def test_after_deadline_refuses_even_the_right_token(self, monkeypatch):
        c, _ = self._client(monkeypatch, "2026-10-03T11:00:00Z")
        r = c.get("/probe", headers={"Authorization": "Bearer good-token"})
        assert r.status_code == 403
        assert "window has ended" in r.json()["detail"]

    def test_deadline_is_checked_per_request(self, monkeypatch):
        from datetime import datetime
        c, auth_mod = self._client(monkeypatch, "2026-10-03T12:30:00Z")
        h = {"Authorization": "Bearer good-token"}
        assert c.get("/probe", headers=h).status_code == 200
        monkeypatch.setattr(
            auth_mod, "_now", lambda: datetime.fromisoformat("2026-10-03T12:30:01+00:00")
        )
        assert c.get("/probe", headers=h).status_code == 403

    def test_naive_timestamp_means_utc(self, monkeypatch):
        c, _ = self._client(monkeypatch, "2026-10-03T11:00:00")
        assert c.get("/probe", headers={"Authorization": "Bearer good-token"}).status_code == 403

    def test_unparseable_value_fails_closed(self, monkeypatch):
        c, _ = self._client(monkeypatch, "tomorrow-ish")
        assert c.get("/probe", headers={"Authorization": "Bearer good-token"}).status_code == 403


class TestTokenComparison:
    def test_non_ascii_token_is_refused_not_a_server_error(self):
        # compare_digest on two str values raises TypeError for non-ASCII
        # input, which would surface as a 500 to an unauthenticated caller.
        c = _app("good-token")
        r = c.get("/probe", headers={"Authorization": "Bearer caf\u00e9".encode("latin-1")})
        assert r.status_code == 403

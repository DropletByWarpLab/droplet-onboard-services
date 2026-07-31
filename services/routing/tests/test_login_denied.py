"""WARP-1673 — a router that REJECTS our credentials is not "offline".

On the edge-router shape a reflash regenerates the per-unit `droplet-ai`
password, stranding the copy in `docker/secrets/openwrt_password`. Before this
ticket that rendered as the same 503 "Router not connected" as a powered-off
router, so the dashboard showed "Router offline" instead of the actionable
"Credentials rejected" copy.

Wire contract under test:

  * SDK: `session login` → PERMISSION_DENIED raises `LoginDenied`
    (subclass of `ConnectionLost`, so every existing catch still works).
  * Routes: while the last connect attempt failed on auth, router-backed
    routes return **502** with detail `{code: "ROUTER_AUTH", ...}` — the
    orchestrator maps 502 → RouterError AUTH (types/router-error.ts).
  * A plain unreachable router keeps the exact pre-ticket 503 shape.
  * /health names the credential failure instead of "not connected at startup".
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import (
    ConnectionLost,
    LoginDenied,
    SessionManager,
    UbusError,
)
from reconnect import ReconnectCoordinator

AUTH_HEADERS = {"Authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# SDK: SessionManager.login classification
# ---------------------------------------------------------------------------
class TestSessionManagerLogin:
    def _manager_with_login_result(self, side_effect_or_result) -> SessionManager:
        client = MagicMock(name="UbusClient")
        if isinstance(side_effect_or_result, Exception):
            client.call.side_effect = side_effect_or_result
        else:
            client.call.return_value = side_effect_or_result
        return SessionManager(client, "droplet-ai", "stale-password")

    def test_permission_denied_raises_login_denied(self):
        mgr = self._manager_with_login_result(UbusError(6))
        with pytest.raises(LoginDenied) as excinfo:
            mgr.login()
        # The message names the user — the operator's first question.
        assert "droplet-ai" in str(excinfo.value)

    def test_login_denied_is_a_connection_lost(self):
        # Existing catches are all `except (ConnectionLost, UbusError)` —
        # the subclass relationship is what keeps them working unchanged.
        assert issubclass(LoginDenied, ConnectionLost)

    def test_other_ubus_errors_pass_through_unwrapped(self):
        mgr = self._manager_with_login_result(UbusError(7))  # TIMEOUT
        with pytest.raises(UbusError) as excinfo:
            mgr.login()
        assert not isinstance(excinfo.value, LoginDenied)
        assert excinfo.value.code == 7

    def test_successful_login_stores_token(self):
        mgr = self._manager_with_login_result(
            {"ubus_rpc_session": "tok-123", "timeout": 300}
        )
        assert mgr.login() == "tok-123"
        assert mgr.token == "tok-123"


# ---------------------------------------------------------------------------
# Routes: typed 502 while the router refuses our credentials
# ---------------------------------------------------------------------------
def _coordinator_failing_with(exc: Exception) -> ReconnectCoordinator:
    def _connect():
        # Mirror _connect_to_openwrt's classification side effect without
        # dialing anything.
        main._last_connect_failure = (
            "auth" if isinstance(exc, LoginDenied) else "unreachable"
        )
        raise exc

    return ReconnectCoordinator(
        connect_fn=_connect,
        on_connected=main._set_router_instance,
        is_connected=main._router_is_connected,
        cooldown_seconds=0.0,
    )


class TestAuthDeniedRoutes:
    @pytest.fixture
    def auth_denied_client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        monkeypatch.setattr(main, "router_instance", None)
        monkeypatch.setattr(
            main,
            "reconnect_coordinator",
            _coordinator_failing_with(LoginDenied("rejected for user 'droplet-ai'")),
        )
        return TestClient(main.app)

    def test_router_backed_route_returns_typed_502(self, auth_denied_client: TestClient):
        res = auth_denied_client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.status_code == 502
        detail = res.json()["detail"]
        assert detail["code"] == "ROUTER_AUTH"
        assert "openwrt_password" in detail["message"]

    def test_health_names_the_credential_failure(self, auth_denied_client: TestClient):
        # Prime the classifier the same way a real request would.
        auth_denied_client.get("/network/summary", headers=AUTH_HEADERS)
        res = auth_denied_client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["connected"] is False
        assert "droplet-ai password" in body["error"]

    def test_unreachable_router_keeps_plain_503(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(main, "router_instance", None)
        monkeypatch.setattr(
            main,
            "reconnect_coordinator",
            _coordinator_failing_with(ConnectionLost("connect refused")),
        )
        client = TestClient(main.app)
        res = client.get("/network/summary", headers=AUTH_HEADERS)
        assert res.status_code == 503
        assert res.json()["detail"] == "Router not connected"

    def test_recovery_clears_the_auth_state(self, monkeypatch: pytest.MonkeyPatch):
        """Once a connect succeeds (secret re-synced), the typed state must not
        linger — `_connect_to_openwrt` clears it on success."""
        monkeypatch.setattr(main, "router_instance", None)
        monkeypatch.setattr(main, "_last_connect_failure", "auth")
        router = MagicMock(name="DropletRouter")
        monkeypatch.setattr(main, "DropletRouter", MagicMock(return_value=router))
        assert main._connect_to_openwrt() is router
        assert main._last_connect_failure is None


# ---------------------------------------------------------------------------
# handle_router_error: mid-session rotation
# ---------------------------------------------------------------------------
class TestHandleRouterError:
    def test_login_denied_maps_to_typed_502(self):
        with pytest.raises(HTTPException) as excinfo:
            main.handle_router_error(LoginDenied("rotated mid-session"))
        assert excinfo.value.status_code == 502
        assert excinfo.value.detail["code"] == "ROUTER_AUTH"

    def test_connection_lost_still_maps_to_503(self):
        with pytest.raises(HTTPException) as excinfo:
            main.handle_router_error(ConnectionLost("gone"))
        assert excinfo.value.status_code == 503

    def test_permission_denied_on_an_object_is_not_auth(self):
        """UbusError(6) OUTSIDE `session login` can equally mean an ACL gap on
        one object — it must keep the generic 500, never the credentials 502."""
        with pytest.raises(HTTPException) as excinfo:
            main.handle_router_error(UbusError(6))
        assert excinfo.value.status_code == 500

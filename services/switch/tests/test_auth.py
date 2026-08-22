"""Service-to-service auth tests for the switch service.

Mirrors services/routing/tests/test_auth.py. `ServiceAuthMiddleware` gates every
route except `/health`. Its behaviour:
- If SERVICE_SECRET is unset, the service FAILS CLOSED — every non-/health route
  returns 403 (auth-not-configured) — unless SWITCH_ALLOW_NO_AUTH is set, which
  opts back into open dev mode. (The service binds under network_mode: host, so a
  failed secret injection must not run open.) 403 (not 503) is deliberate: the
  hardware reads raise 503 when no switch is attached, so an auth-config failure
  must use a distinct status the orchestrator can tell apart from "no switch".
- /health is exempt regardless of token.
- Missing / wrong tokens with a configured secret → 403.
- Right token with constant-time compare → passes the middleware (the route then
  503s because no switch is connected in tests — proving we got past auth).

The middleware reads the module globals SERVICE_SECRET / SWITCH_ALLOW_NO_AUTH at
request time, so monkeypatching `main.<global>` takes effect without reloading.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture
def client() -> TestClient:
    return TestClient(main.app)


@pytest.fixture
def set_secret(monkeypatch: pytest.MonkeyPatch):
    """Override `main.SERVICE_SECRET` for one test.

    ServiceAuthMiddleware reads the module global at dispatch time, so patching
    here works without reloading the module.
    """

    def _setter(value: str) -> None:
        monkeypatch.setattr(main, "SERVICE_SECRET", value)

    return _setter


# A privileged (non-/health) route used to probe the auth gate. /system/info
# 503s when no driver is connected, which is exactly what we want: a 503 here
# proves the request got PAST the auth middleware.
PROTECTED_ROUTE = "/system/info"


def test_health_exempt_without_auth(client):
    """/health returns 200 without any Authorization header."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert "status" in resp.json()


def test_health_exempt_with_wrong_token(client):
    """/health still works with a bad bearer — it's the Docker healthcheck."""
    resp = client.get("/health", headers={"Authorization": "Bearer this-is-wrong"})
    assert resp.status_code == 200


def test_secret_set_validates_token(client, set_secret):
    """Secret set + correct bearer → passes the middleware.

    The conftest default SERVICE_SECRET is `pytest-fake-secret`; pin it
    explicitly so this test is independent of import-time state. A valid token
    gets past auth; the route then 503s because no switch is connected in tests,
    which proves we cleared the middleware rather than being rejected by it.
    """
    set_secret("pytest-fake-secret")
    resp = client.get(
        PROTECTED_ROUTE,
        headers={"Authorization": "Bearer pytest-fake-secret"},
    )
    assert resp.status_code != 403, "valid token must not be rejected by auth"


def test_secret_set_rejects_wrong_token(client, set_secret):
    """Secret set + wrong bearer → 403 from the middleware."""
    set_secret("pytest-fake-secret")
    resp = client.get(
        PROTECTED_ROUTE,
        headers={"Authorization": "Bearer wrong-token-value"},
    )
    assert resp.status_code == 403
    assert "invalid or missing" in resp.json()["error"].lower()


def test_secret_set_rejects_missing_token(client, set_secret):
    """Secret set + no bearer at all → 403 from the middleware."""
    set_secret("pytest-fake-secret")
    resp = client.get(PROTECTED_ROUTE)
    assert resp.status_code == 403


def test_no_secret_with_allow_no_auth_passes(client, set_secret, monkeypatch):
    """No secret + SWITCH_ALLOW_NO_AUTH=1 → open dev mode, request reaches the
    handler (503 because no switch is connected, NOT a 403 auth rejection)."""
    set_secret("")
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", True)
    resp = client.get(PROTECTED_ROUTE)
    assert resp.status_code != 403, "ALLOW_NO_AUTH must let the request through"


def test_no_secret_no_opt_in_fails_closed_403(client, set_secret, monkeypatch):
    """Security regression: an unset SERVICE_SECRET must FAIL CLOSED with 403.

    403 (not 503) so the orchestrator can tell an auth-config failure apart from
    a genuinely-absent switch (the hardware reads raise 503). We assert the
    detail to prove the auth-not-configured branch fired, not a downstream 503.
    """
    set_secret("")
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", False)
    resp = client.get(PROTECTED_ROUTE)
    assert resp.status_code == 403
    assert "not configured" in resp.json()["error"].lower()


def test_health_reports_auth_configured_when_secret_set(client, set_secret):
    """/health surfaces auth_configured=True (presence only) when a secret is
    set — lets the orchestrator health check warn on a fail-closed deploy."""
    set_secret("pytest-fake-secret")
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["auth_configured"] is True


def test_health_reports_auth_not_configured_when_secret_unset(
    client, set_secret, monkeypatch
):
    """/health surfaces auth_configured=False when the secret is unset and no
    dev opt-in — the false-OK warning signal for the orchestrator."""
    set_secret("")
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", False)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["auth_configured"] is False


def test_health_never_leaks_secret_value(client, set_secret):
    """auth_configured is a bool — the secret value must never appear in the
    /health body."""
    set_secret("super-secret-value-123")
    resp = client.get("/health")
    body = resp.json()
    assert body["auth_configured"] is True
    assert "super-secret-value-123" not in resp.text


def test_health_does_not_leak_switch_inventory(client, monkeypatch):
    """WARP-2111: /health is auth-exempt on a 0.0.0.0:8081 host-network bind, so
    it must NOT echo get_system_info() (model/firmware/MAC/hostname) to
    unauthenticated LAN clients. Exercises the CONNECTED branch — a fake driver
    whose get_system_info() returns full inventory — to prove the switch model
    ("Fake 10-Port PoE Switch") and hostname never reach the wire. The detail
    lives behind GET /system/info."""
    from tests.fakes import FakeSwitchDriver

    monkeypatch.setattr(main, "driver_instance", FakeSwitchDriver())
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["connected"] is True
    assert "system_info" not in body
    assert "Fake 10-Port PoE Switch" not in resp.text
    assert "fake-switch" not in resp.text

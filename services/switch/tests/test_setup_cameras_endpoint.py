"""Endpoint-level coverage for POST /setup/cameras honesty.

The route builds the one-click camera VLAN + assigns ports, then returns a
``CameraSetupResult``. Under plan-only (dry-run) mode the driver never writes,
so the response MUST NOT claim the VLAN was "configured" — it has to read as a
plan, mirroring the honest dry-run pattern the other switch write endpoints use
(status "planned" vs "ok"). This guards the regression Romain caught: a
"planned" status paired with a "configured" message.

The route reaches the driver via ``main.driver_instance``; these tests install
a fake driver directly (no socket, never real hardware) and open
the auth gate with ``SWITCH_ALLOW_NO_AUTH`` so the middleware lets the POST
through, exactly as local dev would.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


class _FakeDriver:
    """Minimal stand-in for the route's two driver calls.

    Records writes so a test can assert plan-only never claims a write it did
    not make. ``plan_only`` is the only attribute the route inspects.
    """

    def __init__(self, *, plan_only: bool) -> None:
        self.plan_only = plan_only
        self.vlans_created: list[tuple[int, str]] = []
        self.memberships_set: list[tuple[int, list[dict]]] = []

    async def create_vlan(self, vlan_id: int, name: str) -> None:
        self.vlans_created.append((vlan_id, name))

    async def set_vlan_membership(self, vlan_id: int, membership: list[dict]) -> None:
        self.memberships_set.append((vlan_id, membership))


@pytest.fixture()
def _client(monkeypatch):
    main = importlib.import_module("main")
    # Open the auth gate the way local dev does (no SERVICE_SECRET configured).
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", True, raising=False)
    monkeypatch.setattr(main, "SERVICE_SECRET", "", raising=False)

    def _install(driver):
        monkeypatch.setattr(main, "driver_instance", driver, raising=False)
        return TestClient(main.app)

    return _install


def test_setup_cameras_plan_only_message_does_not_claim_configured(_client):
    driver = _FakeDriver(plan_only=True)
    client = _client(driver)

    resp = client.post("/setup/cameras", json={"vlan_id": 100})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Status already signals plan-only; the message must agree with it.
    assert body["status"] == "planned"
    msg = body["message"]
    # No write hit the wire, so the message must NOT assert it "configured".
    assert "configured:" not in msg, f"plan-only message falsely claims a write: {msg!r}"
    lower = msg.lower()
    assert "dry-run" in lower or "planned" in lower, msg
    assert "would" in lower, msg
    # Sanity: the driver was driven, but in plan-only it does not really write.
    assert driver.vlans_created == [(100, "cameras")]


def test_setup_cameras_apply_message_says_configured(_client):
    driver = _FakeDriver(plan_only=False)
    client = _client(driver)

    resp = client.post("/setup/cameras", json={"vlan_id": 100})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["status"] == "ok"
    msg = body["message"]
    # Applied for real — the honest word "configured" is correct here.
    assert "configured" in msg.lower(), msg
    assert "dry-run" not in msg.lower(), msg
    assert "would" not in msg.lower(), msg

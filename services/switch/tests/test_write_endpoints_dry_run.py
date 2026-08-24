"""WARP-1176 (PYNET-001): plan-only writes must never be reported as applied.

Switch drivers run plan-only by default (SWITCH_LIVE_WRITES=0) and every
write method no-ops (returning the plan dict instead of POSTing). The REST
layer used to answer unconditional ``{"status": "ok"}`` for those no-op writes
— and even discarded the driver's returned ``{**plan, "dry_run": True}`` on
/vlans/{id}/membership — so the orchestrator, dashboard, and the switch LLM
tools told the operator a change landed on hardware when nothing happened.

These tests pin the honest contract on EVERY write endpoint:

* plan-only mode -> ``status: "planned"`` + ``dry_run: true`` (HTTP 200 kept);
  endpoints whose driver method returns a plan dict also carry it as ``plan``.
* live mode      -> the pre-existing success shape: ``status: "ok"`` +
  ``dry_run: false`` and no ``plan`` key.

The fake driver mirrors the real drivers' write return shapes (see
``_gated_write``): ``set_vlan_membership`` / ``set_port_poe`` return
``{**plan, "dry_run": bool}``; ``set_port_enabled`` / ``create_vlan`` /
``delete_vlan`` return ``None`` (their endpoints fall back to the driver's
``plan_only`` attribute).
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


class _FakeDriver:
    """Stand-in mirroring the real drivers' write-method return shapes."""

    def __init__(self, *, plan_only: bool) -> None:
        self.plan_only = plan_only
        self.writes: list[tuple] = []

    # -- reads --

    async def get_ports(self) -> list[dict]:
        """WARP-2165: /setup/cameras derives its port banks from the device
        when the request omits them, so the stand-in has to be able to answer.
        Reports a 10HP (copper 1-8, SFP 9-10) — the layout these tests assumed
        back when it was a schema default."""
        return [{"port": n, "is_sfp": n >= 9} for n in range(1, 11)]

    # -- writes returning None (like the real driver) --

    async def set_port_enabled(self, port: int, enabled: bool) -> None:
        if not self.plan_only:
            self.writes.append(("set_port_enabled", port, enabled))

    async def create_vlan(self, vlan_id: int, name: str = "") -> None:
        if not self.plan_only:
            self.writes.append(("create_vlan", vlan_id, name))

    async def delete_vlan(self, vlan_id: int) -> None:
        if not self.plan_only:
            self.writes.append(("delete_vlan", vlan_id))

    # -- writes returning {**plan, "dry_run": bool} (like _gated_write) --

    async def set_vlan_membership(self, vlan_id: int, membership: list[dict]) -> dict:
        if not self.plan_only:
            self.writes.append(("set_vlan_membership", vlan_id))
        return {
            "vlan_id": vlan_id,
            "membership": membership,
            "dry_run": self.plan_only,
        }

    async def set_port_poe(self, port: int, enabled: bool) -> dict:
        if not self.plan_only:
            self.writes.append(("set_port_poe", port, enabled))
        return {"port": port, "enabled": enabled, "dry_run": self.plan_only}


@pytest.fixture()
def make_client(monkeypatch):
    main = importlib.import_module("main")
    # Open the auth gate the way local dev does (no SERVICE_SECRET configured).
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", True, raising=False)
    monkeypatch.setattr(main, "SERVICE_SECRET", "", raising=False)

    def _install(driver: _FakeDriver) -> TestClient:
        monkeypatch.setattr(main, "driver_instance", driver, raising=False)
        return TestClient(main.app)

    return _install


@pytest.fixture()
def plan_client(make_client):
    driver = _FakeDriver(plan_only=True)
    return make_client(driver), driver


@pytest.fixture()
def live_client(make_client):
    driver = _FakeDriver(plan_only=False)
    return make_client(driver), driver


# ---------------------------------------------------------------------------
# Plan-only mode: every write endpoint reports planned/dry_run, never "ok".
# ---------------------------------------------------------------------------

def test_plan_only_port_enable_reports_planned(plan_client):
    client, driver = plan_client
    body = client.post("/ports/3/enable").json()
    assert body == {"status": "planned", "port": 3, "enabled": True, "dry_run": True}
    assert driver.writes == []


def test_plan_only_port_disable_reports_planned(plan_client):
    client, driver = plan_client
    body = client.post("/ports/3/disable").json()
    assert body == {"status": "planned", "port": 3, "enabled": False, "dry_run": True}
    assert driver.writes == []


def test_plan_only_create_vlan_reports_planned(plan_client):
    client, driver = plan_client
    body = client.post("/vlans", json={"vlan_id": 100, "name": "cameras"}).json()
    assert body == {
        "status": "planned",
        "vlan_id": 100,
        "name": "cameras",
        "dry_run": True,
    }
    assert driver.writes == []


def test_plan_only_delete_vlan_reports_planned_and_not_deleted(plan_client):
    client, driver = plan_client
    body = client.delete("/vlans/100").json()
    # deleted must be False — nothing was removed from hardware.
    assert body == {
        "status": "planned",
        "vlan_id": 100,
        "deleted": False,
        "dry_run": True,
    }
    assert driver.writes == []


def test_plan_only_membership_propagates_driver_plan(plan_client):
    """The endpoint must not discard the driver's {**plan, dry_run:true}.

    mode="replace" is explicit here: this list mixes an untagged member with a
    tagged trunk, which is a whole-member-list write, not a set of access
    moves. The default (merge) path is covered in
    test_vlan_membership_endpoint.py.
    """
    client, driver = plan_client
    ports = [
        {"port": 1, "tagged": False, "member": True},
        {"port": 9, "tagged": True, "member": True},
    ]
    body = client.post(
        "/vlans/100/membership", json={"ports": ports, "mode": "replace"}
    ).json()
    assert body["status"] == "planned"
    assert body["dry_run"] is True
    assert body["vlan_id"] == 100
    assert body["ports_updated"] == 2
    # The driver's plan payload rides through (minus its dry_run flag).
    assert body["plan"] == {"vlan_id": 100, "membership": ports}
    assert driver.writes == []


def test_plan_only_poe_enable_reports_planned_with_plan(plan_client):
    client, driver = plan_client
    body = client.post("/poe/2/enable").json()
    assert body["status"] == "planned"
    assert body["dry_run"] is True
    assert body["port"] == 2
    assert body["poe_enabled"] is True
    assert body["plan"] == {"port": 2, "enabled": True}
    assert driver.writes == []


def test_plan_only_poe_disable_reports_planned_with_plan(plan_client):
    client, driver = plan_client
    body = client.post("/poe/2/disable").json()
    assert body["status"] == "planned"
    assert body["dry_run"] is True
    assert body["poe_enabled"] is False
    assert body["plan"] == {"port": 2, "enabled": False}
    assert driver.writes == []


def test_plan_only_setup_cameras_reports_planned_dry_run(plan_client):
    client, driver = plan_client
    body = client.post("/setup/cameras", json={"vlan_id": 100}).json()
    assert body["status"] == "planned"
    # Machine-readable signal, not just the status string / prose message.
    assert body["dry_run"] is True
    assert "configured:" not in body["message"]
    assert driver.writes == []


# ---------------------------------------------------------------------------
# Live mode: the pre-existing success shape is unchanged.
# ---------------------------------------------------------------------------

def test_live_port_enable_reports_ok(live_client):
    client, driver = live_client
    body = client.post("/ports/3/enable").json()
    assert body == {"status": "ok", "port": 3, "enabled": True, "dry_run": False}
    assert ("set_port_enabled", 3, True) in driver.writes


def test_live_port_disable_reports_ok(live_client):
    client, _ = live_client
    body = client.post("/ports/3/disable").json()
    assert body == {"status": "ok", "port": 3, "enabled": False, "dry_run": False}


def test_live_create_vlan_reports_ok(live_client):
    client, _ = live_client
    body = client.post("/vlans", json={"vlan_id": 100, "name": "cameras"}).json()
    assert body == {"status": "ok", "vlan_id": 100, "name": "cameras", "dry_run": False}


def test_live_delete_vlan_reports_ok_deleted(live_client):
    client, _ = live_client
    body = client.delete("/vlans/100").json()
    assert body == {"status": "ok", "vlan_id": 100, "deleted": True, "dry_run": False}


def test_live_membership_reports_ok_without_plan(live_client):
    client, driver = live_client
    ports = [{"port": 1, "tagged": False, "member": True}]
    body = client.post(
        "/vlans/100/membership", json={"ports": ports, "mode": "replace"}
    ).json()
    assert body == {
        "status": "ok",
        "vlan_id": 100,
        "ports_updated": 1,
        "mode": "replace",
        "dry_run": False,
    }
    assert "plan" not in body
    assert ("set_vlan_membership", 100) in driver.writes


def test_live_poe_enable_reports_ok_without_plan(live_client):
    client, _ = live_client
    body = client.post("/poe/2/enable").json()
    assert body == {"status": "ok", "port": 2, "poe_enabled": True, "dry_run": False}
    assert "plan" not in body


def test_live_setup_cameras_reports_ok(live_client):
    client, _ = live_client
    body = client.post("/setup/cameras", json={"vlan_id": 100}).json()
    assert body["status"] == "ok"
    assert body["dry_run"] is False
    assert "configured" in body["message"].lower()

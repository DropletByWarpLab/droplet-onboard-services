"""The INTERACTIVE membership endpoint must not be able to strand the fabric.

``set_port_access_vlan`` (the merge-safe primitive) was wired only into the
provisioner's internal auto-reconcile path. ``POST /vlans/{id}/membership`` —
the endpoint the orchestrator proxies for the dashboard's "move this port to
that VLAN" control AND for the ``set_port_vlan`` LLM tool — still called the
RAW replace-semantics ``set_vlan_membership``. Called with a single port (which
is exactly what both live callers send) that WIPES the VLAN's other members: on
VLAN 1 those are the router uplink, the AP and the appliance, so one operator
click or one agent tool call strands the whole rack with no remote recovery.

The two intents are now DECLARED, never guessed from the list's length:

* ``mode: "merge"`` (default) — each entry is an access move; every other
  member of the target VLAN is preserved. Entries that cannot be expressed as
  an access move (``tagged: true`` / ``member: false``) are REFUSED with a 400
  that names ``mode: "replace"`` — a full-membership caller is never silently
  downgraded to merge semantics.
* ``mode: "replace"`` — the historical whole-list write, unchanged.

The response echoes the mode that ran, so a caller can see which semantics
applied instead of inferring them.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


class _RecordingDriver:
    """Records which membership primitive the endpoint reached for."""

    def __init__(self, *, plan_only: bool = True) -> None:
        self.plan_only = plan_only
        self.access_moves: list[tuple[int, int]] = []
        self.replacements: list[tuple[int, list[dict]]] = []

    async def set_port_access_vlan(self, port: int, vlan_id: int) -> None:
        self.access_moves.append((port, vlan_id))

    async def set_vlan_membership(self, vlan_id: int, membership: list[dict]) -> dict:
        self.replacements.append((vlan_id, membership))
        return {"vlan_id": vlan_id, "membership": membership, "dry_run": self.plan_only}


@pytest.fixture()
def make_client(monkeypatch):
    main = importlib.import_module("main")
    monkeypatch.setattr(main, "SWITCH_ALLOW_NO_AUTH", True, raising=False)
    monkeypatch.setattr(main, "SERVICE_SECRET", "", raising=False)

    def _install(driver: _RecordingDriver) -> TestClient:
        monkeypatch.setattr(main, "driver_instance", driver, raising=False)
        return TestClient(main.app)

    return _install


ONE_PORT = [{"port": 2, "tagged": False, "member": True}]


# ---------------------------------------------------------------------------
# Default (merge): a single-port access move can never wipe the VLAN.
# ---------------------------------------------------------------------------

def test_default_mode_moves_the_port_without_replacing_the_vlan(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    body = client.post("/vlans/100/membership", json={"ports": ONE_PORT}).json()

    # The merge-safe primitive ran; the fabric-stranding one never did.
    assert driver.access_moves == [(2, 100)]
    assert driver.replacements == []
    assert body["mode"] == "merge"
    assert body["status"] == "ok"
    assert body["ports_updated"] == 1


def test_merge_moves_every_port_in_the_list(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    ports = [
        {"port": 2, "tagged": False, "member": True},
        {"port": 3, "tagged": False, "member": True},
    ]
    body = client.post("/vlans/100/membership", json={"ports": ports}).json()

    assert driver.access_moves == [(2, 100), (3, 100)]
    assert driver.replacements == []
    assert body["ports_updated"] == 2


def test_merge_in_plan_only_reports_planned_and_writes_nothing(make_client):
    """SWITCH_LIVE_WRITES=0 must read as planned on the merge path too."""
    driver = _RecordingDriver(plan_only=True)
    client = make_client(driver)

    body = client.post("/vlans/100/membership", json={"ports": ONE_PORT}).json()

    assert body["status"] == "planned"
    assert body["dry_run"] is True
    assert body["mode"] == "merge"
    assert body["plan"]["op"] == "set_port_access_vlan"
    assert body["plan"]["ports"] == [2]


# ---------------------------------------------------------------------------
# Merge refuses what it cannot express — loudly, never by guessing.
# ---------------------------------------------------------------------------

def test_merge_refuses_a_tagged_entry_and_names_replace_mode(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    resp = client.post(
        "/vlans/100/membership",
        json={"ports": [{"port": 9, "tagged": True, "member": True}]},
    )

    assert resp.status_code == 400
    assert "replace" in resp.json()["detail"]
    assert driver.access_moves == []
    assert driver.replacements == []


def test_merge_refuses_a_removal_entry(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    resp = client.post(
        "/vlans/100/membership",
        json={"ports": [{"port": 2, "tagged": False, "member": False}]},
    )

    assert resp.status_code == 400
    assert "replace" in resp.json()["detail"]
    assert driver.replacements == []


def test_unknown_mode_is_rejected(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    resp = client.post(
        "/vlans/100/membership", json={"ports": ONE_PORT, "mode": "clobber"}
    )

    assert resp.status_code == 422
    assert driver.access_moves == []
    assert driver.replacements == []


# ---------------------------------------------------------------------------
# Explicit replace: the historical contract, unchanged.
# ---------------------------------------------------------------------------

def test_explicit_replace_still_writes_the_whole_member_list(make_client):
    driver = _RecordingDriver(plan_only=False)
    client = make_client(driver)

    ports = [
        {"port": 2, "tagged": False, "member": True},
        {"port": 9, "tagged": True, "member": True},
    ]
    body = client.post(
        "/vlans/100/membership", json={"ports": ports, "mode": "replace"}
    ).json()

    assert driver.replacements == [(100, ports)]
    assert driver.access_moves == []
    assert body["mode"] == "replace"
    assert body["status"] == "ok"
    assert body["dry_run"] is False


def test_explicit_replace_in_plan_only_still_reports_planned(make_client):
    driver = _RecordingDriver(plan_only=True)
    client = make_client(driver)

    body = client.post(
        "/vlans/100/membership", json={"ports": ONE_PORT, "mode": "replace"}
    ).json()

    assert body["status"] == "planned"
    assert body["dry_run"] is True
    assert body["mode"] == "replace"
    # The driver's own plan payload still rides through (minus its dry_run).
    assert body["plan"] == {"vlan_id": 100, "membership": ONE_PORT}

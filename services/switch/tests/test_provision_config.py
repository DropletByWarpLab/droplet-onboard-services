"""Tests for the read-only surfaces the orchestrator §7 aggregation joins on
(ADR-018 item 12): GET /provision/config, GET /ports/status, and the model PoE
budget constant. All run against FakeSwitchDriver / a temp state file — never
the live switch.
"""

from __future__ import annotations

import importlib

from fastapi.testclient import TestClient

from tests.fakes import FakeSwitchDriver

_AUTH = {"Authorization": "Bearer pytest-fake-secret"}


def _client(monkeypatch, tmp_path, driver=None, **env):
    # Pin the provisioned-state file into a temp dir so tests never touch real
    # service state and don't bleed into each other.
    monkeypatch.setenv("SWITCH_STATE_DIR", str(tmp_path))
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    main = importlib.import_module("main")
    importlib.reload(main)
    main.driver_instance = driver
    return main, TestClient(main.app)


# --- GET /provision/config --------------------------------------------------


def test_provision_config_echoes_env(monkeypatch, tmp_path):
    driver = FakeSwitchDriver()
    main, client = _client(
        monkeypatch, tmp_path, driver=driver,
        SWITCH_VLAN_PROFILE="segmented",
        SWITCH_AUTOPROVISION="1",
        SWITCH_PROTECTED_PORT="9",
        SWITCH_CAMERA_PORTS="6,7,8",
        SWITCH_AP_PORTS="2,4",
        SWITCH_CLIENT_PORTS="1,3",
    )

    resp = client.get("/provision/config", headers=_AUTH)

    assert resp.status_code == 200
    body = resp.json()
    assert body["vlan_profile"] == "segmented"
    assert body["auto_managed"] is True
    assert body["protected_port"] == 9
    assert body["camera_ports"] == [6, 7, 8]
    assert body["ap_ports"] == [2, 4]
    assert body["client_ports"] == [1, 3]
    # PoE budget is a documented model constant (77 W for the GS1900-10HP),
    # surfaced in watts here for the orchestrator.
    assert body["poe_budget_w"] == 77
    # No reconcile has run -> last_provisioned_at is null, not fabricated.
    assert body["last_provisioned_at"] is None


def test_provision_config_defaults_auto_managed_off(monkeypatch, tmp_path):
    main, client = _client(monkeypatch, tmp_path, driver=FakeSwitchDriver())
    # SWITCH_AUTOPROVISION unset -> auto_managed false (explicit, not absence).
    monkeypatch.delenv("SWITCH_AUTOPROVISION", raising=False)
    importlib.reload(main)
    main.driver_instance = FakeSwitchDriver()
    client = TestClient(main.app)

    resp = client.get("/provision/config", headers=_AUTH)
    assert resp.status_code == 200
    assert resp.json()["auto_managed"] is False


def test_provision_config_requires_service_token(monkeypatch, tmp_path):
    main, client = _client(monkeypatch, tmp_path, driver=FakeSwitchDriver())
    resp = client.get("/provision/config")  # no bearer token
    assert resp.status_code == 403


def test_provision_config_available_when_switch_absent(monkeypatch, tmp_path):
    # provision-config is pure config echo — it must answer even when the
    # switch isn't connected (the orchestrator still needs profile/budget to
    # render the panel header).
    main, client = _client(monkeypatch, tmp_path, driver=None)
    resp = client.get("/provision/config", headers=_AUTH)
    assert resp.status_code == 200
    assert resp.json()["poe_budget_w"] == 77


# --- last_provisioned_at persistence ----------------------------------------


def test_last_provisioned_at_stamped_on_successful_reconcile(monkeypatch, tmp_path):
    # A stranded port on VLAN 100 -> flat-lan reconcile applies + stamps.
    driver = FakeSwitchDriver(port_vlans={1: 100, 2: 1}, vlans={1, 100})
    main, client = _client(
        monkeypatch, tmp_path, driver=driver,
        SWITCH_PROTECTED_PORT="9", SWITCH_VLAN_PROFILE="flat-lan",
    )

    # Before: no stamp.
    assert client.get("/provision/config", headers=_AUTH).json()["last_provisioned_at"] is None

    prov = client.post("/provision", headers=_AUTH)
    assert prov.status_code == 200
    assert prov.json()["status"] == "applied"

    # After a successful reconcile the stamp is persisted + echoed.
    stamped = client.get("/provision/config", headers=_AUTH).json()["last_provisioned_at"]
    assert isinstance(stamped, str) and stamped.endswith("Z")


def test_last_provisioned_at_stamped_on_noop_reconcile(monkeypatch, tmp_path):
    # Already at desired state -> noop, but the switch IS confirmed at the
    # managed layout, so we still record that it was provisioned now.
    driver = FakeSwitchDriver(port_vlans={1: 1, 2: 1}, vlans={1})
    main, client = _client(
        monkeypatch, tmp_path, driver=driver,
        SWITCH_PROTECTED_PORT="9", SWITCH_VLAN_PROFILE="flat-lan",
    )

    prov = client.post("/provision", headers=_AUTH)
    assert prov.json()["status"] == "noop"
    assert client.get("/provision/config", headers=_AUTH).json()["last_provisioned_at"] is not None


def test_last_provisioned_at_not_stamped_on_skipped_reconcile(monkeypatch, tmp_path):
    # Switch absent -> skipped. We did NOT touch the switch, so we must not
    # claim it was provisioned (no fabricated stamp).
    main, client = _client(monkeypatch, tmp_path, driver=None)

    prov = client.post("/provision", headers=_AUTH)
    assert prov.json()["status"] == "skipped"
    assert client.get("/provision/config", headers=_AUTH).json()["last_provisioned_at"] is None


# --- GET /ports/status (the link/speed read) --------------------------------


def test_ports_status_endpoint_returns_link_speed(monkeypatch, tmp_path):
    driver = FakeSwitchDriver()
    main, client = _client(monkeypatch, tmp_path, driver=driver)

    resp = client.get("/ports/status", headers=_AUTH)

    assert resp.status_code == 200
    rows = resp.json()["ports"]
    by_port = {r["port"]: r for r in rows}
    assert set(by_port) == set(range(1, 11))
    # Fake reports every port up at 1 Gb; SFP flag by position.
    assert by_port[1]["link_up"] is True
    assert by_port[1]["speed"] == "1 Gb"
    assert by_port[9]["is_sfp"] is True


def test_ports_status_switch_absent_is_503(monkeypatch, tmp_path):
    main, client = _client(monkeypatch, tmp_path, driver=None)
    resp = client.get("/ports/status", headers=_AUTH)
    assert resp.status_code == 503

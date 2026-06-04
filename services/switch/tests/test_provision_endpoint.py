"""Tests for the /provision endpoint + env-driven provision config (main.py).

These exercise the event-driven re-run surface (POST /provision) and the
config-from-env builder, against the FakeSwitchDriver — never the live switch.
The lifespan auto-provision behaviour (gated by SWITCH_AUTOPROVISION, default
off, non-blocking, never blocks boot) is covered in test_lifespan_autoprovision.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeSwitchDriver


def _client(monkeypatch, driver=None, **env):
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    main = importlib.import_module("main")
    importlib.reload(main)
    main.driver_instance = driver
    return main, TestClient(main.app)


def test_build_provision_config_defaults(monkeypatch):
    monkeypatch.delenv("SWITCH_VLAN_PROFILE", raising=False)
    monkeypatch.delenv("SWITCH_PROTECTED_PORT", raising=False)
    monkeypatch.delenv("SWITCH_CAMERA_PORTS", raising=False)
    main = importlib.import_module("main")
    importlib.reload(main)

    cfg = main.build_provision_config()

    # Safe defaults: flat-lan, no protected port baked, empty port lists.
    assert cfg.profile == "flat-lan"
    assert cfg.protected_port == 0
    assert cfg.camera_ports == []
    assert cfg.ap_ports == []
    assert cfg.client_ports == []


def test_build_provision_config_parses_env(monkeypatch):
    monkeypatch.setenv("SWITCH_VLAN_PROFILE", "segmented")
    monkeypatch.setenv("SWITCH_PROTECTED_PORT", "9")
    monkeypatch.setenv("SWITCH_CAMERA_PORTS", "1,2,3")
    monkeypatch.setenv("SWITCH_AP_PORTS", "4")
    monkeypatch.setenv("SWITCH_CLIENT_PORTS", "5, 6")
    main = importlib.import_module("main")
    importlib.reload(main)

    cfg = main.build_provision_config()

    assert cfg.profile == "segmented"
    assert cfg.protected_port == 9
    assert cfg.camera_ports == [1, 2, 3]
    assert cfg.ap_ports == [4]
    assert cfg.client_ports == [5, 6]


def test_build_provision_config_ignores_blank_port_lists(monkeypatch):
    monkeypatch.setenv("SWITCH_CAMERA_PORTS", "")
    monkeypatch.setenv("SWITCH_AP_PORTS", "  ")
    main = importlib.import_module("main")
    importlib.reload(main)

    cfg = main.build_provision_config()
    assert cfg.camera_ports == []
    assert cfg.ap_ports == []


def test_provision_endpoint_runs_reconcile(monkeypatch):
    # A stranded port on VLAN 100 → flat-lan moves it back, endpoint reports it.
    driver = FakeSwitchDriver(port_vlans={1: 100, 2: 1}, vlans={1, 100})
    main, client = _client(
        monkeypatch, driver=driver, SWITCH_PROTECTED_PORT="9", SWITCH_VLAN_PROFILE="flat-lan"
    )

    resp = client.post(
        "/provision", headers={"Authorization": "Bearer pytest-fake-secret"}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "applied"
    assert body["profile_applied"] == "flat-lan"
    assert body["ports_changed"] == [1]


def test_provision_endpoint_switch_absent_is_skipped_not_503(monkeypatch):
    # No driver connected. The event-driven re-run must report a skipped
    # result (switch-absent = no-op), NOT a 503 — provisioning is best-effort.
    main, client = _client(monkeypatch, driver=None)

    resp = client.post(
        "/provision", headers={"Authorization": "Bearer pytest-fake-secret"}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "skipped"
    assert body["skipped_reason"]


def test_provision_endpoint_requires_service_token(monkeypatch):
    driver = FakeSwitchDriver()
    main, client = _client(monkeypatch, driver=driver)

    resp = client.post("/provision")  # no bearer token
    assert resp.status_code == 403

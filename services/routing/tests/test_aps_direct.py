"""WARP-1675 — AP approval configures the AP ITSELF, not just the router.

On the edge-router shape the router (Pi 5) has no AP radios, so the historical
approve semantics — stage a `wifi-iface` uci section on the connected router —
configure nothing. These tests cover the two new behaviours:

  * radio gating: router-side staging is SKIPPED when the router positively
    reports zero wireless radios, and kept on every other shape / probe error;
  * AP-direct push: with an AP credential provisioned
    (/run/secrets/ap_openwrt_password), approve pushes ssid/key onto the AP's
    own wifi-iface sections over its rpcd at the discovered address, with
    typed 502s (AP_AUTH / AP_UNREACHABLE) on failure; decommission disables
    the AP's radios BEST-EFFORT (an unplugged AP never fails the call).

All against the MagicMock router from conftest — no sockets. The AP-direct
device connection goes through `main.DropletRouter`, which conftest's autouse
fixture already stubs to raise ConnectionLost — tests that want a reachable
AP install `_FakeApDevice` over it.
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import UbusError

AUTH = {"Authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:01"
AP_IP = "192.168.9.42"
APPROVE_BODY = {"ssid": "Droplet", "encryption_key": "longenoughpw"}


class _FakeApDevice:
    """Records the constructor args + uci writes `_push_ap_wireless` makes."""

    instances: list["_FakeApDevice"] = []

    def __init__(self, host, port=80, username="droplet-ai", password="",
                 auto_login=True, **_kw):
        self.ctor = {"host": host, "port": port, "username": username, "password": password}
        self.uci = MagicMock(name="ap-uci")
        self.uci.get.return_value = {"values": {
            "default_radio0": {".type": "wifi-iface"},
            "default_radio1": {".type": "wifi-iface"},
        }}
        self.safe_apply_calls = 0
        _FakeApDevice.instances.append(self)

    @contextmanager
    def safe_apply(self, timeout=60):
        self.safe_apply_calls += 1
        yield


@pytest.fixture(autouse=True)
def _reset_fake_ap():
    _FakeApDevice.instances = []


@pytest.fixture
def router(mock_router: MagicMock, monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Connected MagicMock router with a deterministic AP namespace."""
    mock_router.wireless.status.return_value = {"radio0": {"up": True}}
    mock_router.ap.get.return_value = {"mac": MAC, "last_ip": AP_IP}
    mock_router.ap.browse_discovered.return_value = [{"mac": MAC, "last_ip": AP_IP}]
    monkeypatch.setattr(main, "router_instance", mock_router)
    return mock_router


@pytest.fixture
def client(router: MagicMock) -> TestClient:
    return TestClient(main.app)


class TestRadioGating:
    def test_radio_less_router_skips_staging_but_approves(self, client, router):
        router.wireless.status.return_value = {}
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["router_staged"] is False
        assert body["ap_configured"] is False  # no AP credential in this test
        router.safe_apply.assert_not_called()
        router.ap.push_wireless_config.assert_not_called()

    def test_router_with_radios_keeps_staging(self, client, router):
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["router_staged"] is True
        router.safe_apply.assert_called_once()
        router.ap.push_wireless_config.assert_called_once()

    def test_wireless_probe_failure_fails_open_to_staging(self, client, router):
        router.wireless.status.side_effect = UbusError(7)  # TIMEOUT
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["router_staged"] is True

    def test_decommission_on_radio_less_router_skips_staging(self, client, router):
        router.wireless.status.return_value = {}
        resp = client.delete(f"/aps/{MAC}", headers=AUTH)
        assert resp.status_code == 200, resp.text
        router.safe_apply.assert_not_called()


class TestApDirectPush:
    @pytest.fixture(autouse=True)
    def _ap_credential(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")

    def test_approve_configures_the_ap_itself(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ap_configured"] is True
        assert AP_IP in body["ap_detail"]

        assert len(_FakeApDevice.instances) == 1
        dev = _FakeApDevice.instances[0]
        assert dev.ctor == {
            "host": AP_IP, "port": 80,
            "username": "droplet-ai", "password": "per-unit-ap-pw",
        }
        assert dev.safe_apply_calls == 1
        set_calls = dev.uci.set.call_args_list
        assert {c.args[1] for c in set_calls} == {"default_radio0", "default_radio1"}
        for c in set_calls:
            assert c.args[0] == "wireless"
            assert c.args[2]["ssid"] == "Droplet"
            assert c.args[2]["key"] == "longenoughpw"
            assert c.args[2]["disabled"] == "0"

    def test_ap_credential_rejection_is_typed_502(self, client, router, monkeypatch):
        class _DeniedApDevice(_FakeApDevice):
            def __init__(self, *a, **kw):
                raise UbusError(6)  # rpcd PERMISSION_DENIED at login

        monkeypatch.setattr(main, "DropletRouter", _DeniedApDevice)
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "AP_AUTH"
        assert "ap_openwrt_password" in detail["message"]

    def test_ap_unreachable_is_typed_502(self, client, router):
        # conftest's autouse stub makes main.DropletRouter raise ConnectionLost.
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_UNREACHABLE"

    def test_no_discovered_ip_is_typed_502(self, client, router):
        router.ap.get.return_value = {"mac": MAC}  # discovered, IP aged out
        router.ap.browse_discovered.return_value = []
        resp = client.post(f"/aps/{MAC}/approve", json=APPROVE_BODY, headers=AUTH)
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "AP_UNREACHABLE"
        assert "no discovered address" in detail["message"]

    def test_decommission_disables_the_ap_best_effort(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.delete(f"/aps/{MAC}", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ap_disabled"] is True
        dev = _FakeApDevice.instances[0]
        for c in dev.uci.set.call_args_list:
            assert c.args[2] == {"disabled": "1"}  # keep the AP's own ssid/key

    def test_decommission_survives_an_unreachable_ap(self, client, router):
        # main.DropletRouter still raises ConnectionLost (conftest stub).
        resp = client.delete(f"/aps/{MAC}", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ap_disabled"] is False
        assert "proceeding" in body["ap_detail"]

    def test_decommission_of_an_undiscovered_ap_succeeds(self, client, router):
        router.ap.get.return_value = {"mac": MAC}
        router.ap.browse_discovered.return_value = []
        resp = client.delete(f"/aps/{MAC}", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert "nothing to disable" in resp.json()["ap_detail"]

"""WARP-1703 — the AP band-steering master switch over the AP's own rpcd.

The AP image (droplet-edge-router PR #5) carries uci `droplet.wifi.band_steering`
('1'/'0', default '1'); committing the option fires the AP's own procd reload
trigger which unifies/splits the SSIDs and starts/stops dawn. These tests pin
the routing service's read/write surface for it:

  * honesty forks: no AP credential → supported:false (GET) / 422 (PUT), an AP
    image without the droplet.wifi substrate (ubus NOT_FOUND on the read) →
    supported:false / 422 — never a 5xx;
  * the write path: uci.set("droplet","wifi",{"band_steering": ...}) under the
    AP's own safe_apply;
  * typed 502s (AP_AUTH / AP_UNREACHABLE) for reachability problems on a
    configured AP — same classification as the WARP-1675 approval push.

All against the MagicMock router from conftest — no sockets. The AP-direct
device connection goes through `main.DropletRouter`, which conftest's autouse
fixture already stubs to raise ConnectionLost — tests that want a reachable
AP install `_FakeApDevice` over it.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Optional
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import UbusError

AUTH = {"Authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:01"
AP_IP = "192.168.9.42"
PATH = f"/aps/{MAC}/band-steering"


class _FakeApDevice:
    """Records the constructor args + uci traffic the band-steering path makes.

    `droplet_wifi` is the class-level stand-in for the AP's `droplet.wifi`
    uci section: a dict = the section's values envelope; None = the AP image
    predates the substrate (uci.get raises ubus NOT_FOUND).
    """

    instances: list["_FakeApDevice"] = []
    droplet_wifi: Optional[dict] = {"band_steering": "1"}

    def __init__(self, host, port=80, username="droplet-ai", password="",
                 auto_login=True, **_kw):
        self.ctor = {"host": host, "port": port, "username": username, "password": password}
        self.uci = MagicMock(name="ap-uci")
        cls = type(self)

        def _uci_get(config, section=None, option=None, **_kwargs):
            if config == "droplet":
                if cls.droplet_wifi is None:
                    raise UbusError(4)  # UBUS_STATUS_NOT_FOUND — no substrate
                return {"values": dict(cls.droplet_wifi)}
            return {"values": {}}

        self.uci.get.side_effect = _uci_get
        self.safe_apply_calls = 0
        _FakeApDevice.instances.append(self)

    @contextmanager
    def safe_apply(self, timeout=60):
        self.safe_apply_calls += 1
        yield


@pytest.fixture(autouse=True)
def _reset_fake_ap():
    _FakeApDevice.instances = []
    _FakeApDevice.droplet_wifi = {"band_steering": "1"}


@pytest.fixture
def router(mock_router: MagicMock, monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Connected MagicMock router with a deterministic AP namespace.

    The band-steering routes branch to the ROUTING_MODE=mock surface on
    `hasattr(ap, "get_band_steering"/"set_band_steering")` — a MagicMock
    auto-creates every attribute, so delete both to force the real
    AP-direct path (same reason test_aps_direct configures explicit
    return_values instead of trusting auto-specs).
    """
    mock_router.wireless.status.return_value = {"radio0": {"up": True}}
    mock_router.ap.get.return_value = {"mac": MAC, "last_ip": AP_IP}
    mock_router.ap.browse_discovered.return_value = [{"mac": MAC, "last_ip": AP_IP}]
    del mock_router.ap.get_band_steering
    del mock_router.ap.set_band_steering
    monkeypatch.setattr(main, "router_instance", mock_router)
    return mock_router


@pytest.fixture
def client(router: MagicMock) -> TestClient:
    return TestClient(main.app)


@pytest.fixture
def ap_credential(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "AP_PASSWORD", "per-unit-ap-pw")


@pytest.fixture
def reachable_ap(ap_credential, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)


class TestBandSteeringGet:
    def test_reflects_enabled(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = {"band_steering": "1"}
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supported"] is True
        assert body["enabled"] is True
        assert AP_IP in body["ap_detail"]
        dev = _FakeApDevice.instances[0]
        assert dev.ctor == {
            "host": AP_IP, "port": 80,
            "username": "droplet-ai", "password": "per-unit-ap-pw",
        }

    def test_reflects_disabled(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = {"band_steering": "0"}
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "supported": True,
            "enabled": False,
            "ap_detail": f"AP at {AP_IP}",
        }

    def test_unset_option_defaults_on(self, client, router, reachable_ap):
        # The substrate default is '1' — an AP that has the droplet.wifi
        # section but no explicit option reports steering active.
        _FakeApDevice.droplet_wifi = {"other_option": "x"}
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["enabled"] is True

    def test_missing_substrate_is_unsupported_not_500(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = None  # uci.get('droplet', ...) → UbusError(4)
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supported"] is False
        assert body["enabled"] is False
        assert "predates" in body["ap_detail"]

    def test_no_ap_credential_is_unsupported_with_no_dialout(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "")
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "supported": False,
            "enabled": False,
            "ap_detail": "no AP credential configured",
        }
        assert _FakeApDevice.instances == []  # never dialed the AP

    def test_unreachable_ap_is_typed_502(self, client, router, ap_credential):
        # conftest's autouse stub makes main.DropletRouter raise ConnectionLost.
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_UNREACHABLE"

    def test_no_discovered_ip_is_typed_502(self, client, router, ap_credential):
        router.ap.get.return_value = {"mac": MAC}  # discovered, IP aged out
        router.ap.browse_discovered.return_value = []
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "AP_UNREACHABLE"
        assert "no discovered address" in detail["message"]

    def test_invalid_mac_is_404(self, client, router):
        resp = client.get("/aps/not-a-mac/band-steering", headers=AUTH)
        assert resp.status_code == 404


class TestBandSteeringPut:
    def test_writes_under_safe_apply(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["mac"] == MAC
        assert body["enabled"] is True
        assert "operation_id" in body

        assert len(_FakeApDevice.instances) == 1
        dev = _FakeApDevice.instances[0]
        assert dev.safe_apply_calls == 1
        dev.uci.set.assert_called_once_with(
            "droplet", "wifi", {"band_steering": "1"}
        )

    def test_disable_writes_zero(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"enabled": False}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["enabled"] is False
        dev = _FakeApDevice.instances[0]
        dev.uci.set.assert_called_once_with(
            "droplet", "wifi", {"band_steering": "0"}
        )

    def test_no_ap_credential_is_422_with_no_dialout(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "")
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "AP_BAND_STEERING_UNAVAILABLE"
        assert _FakeApDevice.instances == []

    def test_missing_substrate_is_422_and_never_writes(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = None
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "AP_BAND_STEERING_UNAVAILABLE"
        dev = _FakeApDevice.instances[0]
        dev.uci.set.assert_not_called()
        assert dev.safe_apply_calls == 0

    def test_ap_credential_rejection_is_typed_502(self, client, router, ap_credential, monkeypatch):
        class _DeniedApDevice(_FakeApDevice):
            def __init__(self, *a, **kw):
                raise UbusError(6)  # rpcd PERMISSION_DENIED at login

        monkeypatch.setattr(main, "DropletRouter", _DeniedApDevice)
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_AUTH"

    def test_unreachable_ap_is_typed_502(self, client, router, ap_credential):
        # conftest's autouse stub makes main.DropletRouter raise ConnectionLost.
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_UNREACHABLE"

    def test_no_discovered_ip_is_typed_502(self, client, router, ap_credential):
        router.ap.get.return_value = {"mac": MAC}
        router.ap.browse_discovered.return_value = []
        resp = client.put(PATH, json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_UNREACHABLE"

    def test_non_boolean_body_is_422_validation(self, client, router, ap_credential):
        resp = client.put(PATH, json={"enabled": "yes please"}, headers=AUTH)
        assert resp.status_code == 422


class TestBandSteeringMockSurface:
    """ROUTING_MODE=mock parity — the in-memory _MockAp drives the toggle."""

    @pytest.fixture
    def mock_mode_client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        from mock_router import MockRouter

        monkeypatch.setattr(main, "router_instance", MockRouter())
        return TestClient(main.app)

    def test_full_toggle_round_trip(self, mock_mode_client):
        seed = mock_mode_client.post(
            "/aps/_test_seed",
            json={"mac": MAC, "last_ip": AP_IP},
            headers=AUTH,
        )
        assert seed.status_code == 200, seed.text

        # Substrate default: ON.
        read = mock_mode_client.get(PATH, headers=AUTH)
        assert read.status_code == 200, read.text
        assert read.json() == {"supported": True, "enabled": True, "ap_detail": "mock AP"}

        off = mock_mode_client.put(PATH, json={"enabled": False}, headers=AUTH)
        assert off.status_code == 200, off.text
        assert off.json()["enabled"] is False

        read2 = mock_mode_client.get(PATH, headers=AUTH)
        assert read2.json()["enabled"] is False

    def test_unknown_mac_is_404(self, mock_mode_client):
        resp = mock_mode_client.get("/aps/AA:BB:CC:DD:EE:99/band-steering", headers=AUTH)
        assert resp.status_code == 404

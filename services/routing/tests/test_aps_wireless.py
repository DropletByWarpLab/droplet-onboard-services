"""WARP-1712 — the AP's OWN network name + passphrase over its rpcd.

The founder's ask is that the external access point be a controllable part of
the network rather than a device sitting on it: its Wi-Fi name and password
readable and settable from the Network tab, with the AP itself as the single
source of truth. These tests pin the routing service's read/write surface:

  * the READ reflects live uci — per-radio band/channel/width/link/clients
    joined from `wifi-device` + `wifi-iface` + the iwinfo overlay, with the
    passphrase surfaced (the AP mints a per-unit one at first boot);
  * the WRITE targets ONLY the primary 2.4 GHz interface when the AP carries
    the band-steering applier — the applier derives the 5 GHz interface, and
    authoring it here would race it — and every interface on a pre-substrate
    image, where nothing derives anything;
  * validation is a **400 that dials nothing**: an SSID/passphrase hostapd
    would reject must never reach a commit, because a rejected commit leaves
    the AP's radios down;
  * honesty forks: no AP credential → supported:false (GET) / 422 (PUT), an AP
    reporting no wireless sections → the same — never a 5xx;
  * typed 502s (AP_AUTH / AP_UNREACHABLE) for reachability problems on a
    configured AP — same classification as the WARP-1675 approval push.

All against the MagicMock router from conftest — no sockets. The AP-direct
device connection goes through `main.DropletRouter`, which conftest's autouse
fixture already stubs to raise ConnectionLost — tests that want a reachable
AP install `_FakeApDevice` over it.
"""

from __future__ import annotations

import copy
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
PATH = f"/aps/{MAC}/wireless"

# The shipped AP image's wireless config: two radios, two interfaces, the
# 2.4 GHz one (`default_radio0`) being the section the band-steer applier
# reads and this service writes.
DEFAULT_WIRELESS = {
    "radio0": {
        ".type": "wifi-device", "band": "2g", "channel": "auto", "htmode": "HE20",
    },
    "radio1": {
        ".type": "wifi-device", "band": "5g", "channel": "36", "htmode": "HE80",
    },
    "default_radio0": {
        ".type": "wifi-iface", "device": "radio0", "mode": "ap",
        "ssid": "Droplet", "encryption": "psk2+ccmp", "key": "unit-psk-123",
    },
    "default_radio1": {
        ".type": "wifi-iface", "device": "radio1", "mode": "ap",
        "ssid": "Droplet", "encryption": "psk2+ccmp", "key": "unit-psk-123",
    },
}

WIRELESS_STATUS = {
    "radio0": {"up": True, "interfaces": [
        {"section": "default_radio0", "ifname": "phy0-ap0"},
    ]},
    "radio1": {"up": True, "interfaces": [
        {"section": "default_radio1", "ifname": "phy1-ap0"},
    ]},
}

IWINFO = {
    "phy0-ap0": {"channel": 6, "htmode": "HE20"},
    "phy1-ap0": {"channel": 44, "htmode": "HE80"},
}

ASSOCLIST = {
    "phy0-ap0": [{"mac": "11:11:11:11:11:11"}, {"mac": "22:22:22:22:22:22"}],
    "phy1-ap0": [{"mac": "33:33:33:33:33:33"}],
}


class _FakeApDevice:
    """Records the constructor args + uci traffic the wireless path makes.

    Class-level knobs stand in for the AP's own state so a test can describe
    the shape it cares about:
      * `droplet_wifi` — the `droplet.wifi` section; None = a pre-substrate
        image (uci.get raises ubus NOT_FOUND), i.e. no band-steer applier.
      * `wireless_values` — the `wireless` config's sections.
    """

    instances: list["_FakeApDevice"] = []
    droplet_wifi: Optional[dict] = {"band_steering": "1"}
    wireless_values: dict = DEFAULT_WIRELESS

    def __init__(self, host, port=80, username="droplet-ai", password="",
                 auto_login=True, **_kw):
        self.ctor = {"host": host, "port": port, "username": username, "password": password}
        cls = type(self)
        self.uci = MagicMock(name="ap-uci")

        def _uci_get(config, section=None, option=None, **_kwargs):
            if config == "droplet":
                if cls.droplet_wifi is None:
                    raise UbusError(4)  # UBUS_STATUS_NOT_FOUND — no substrate
                return {"values": dict(cls.droplet_wifi)}
            if config == "wireless":
                return {"values": copy.deepcopy(cls.wireless_values)}
            return {"values": {}}

        self.uci.get.side_effect = _uci_get

        self.wireless = MagicMock(name="ap-wireless")
        self.wireless.status.return_value = copy.deepcopy(WIRELESS_STATUS)
        self.wireless.radio_info.side_effect = (
            lambda device=None, **_k: dict(IWINFO.get(device, {}))
        )
        self.wireless.connected_clients.side_effect = (
            lambda device=None, **_k: list(ASSOCLIST.get(device, []))
        )

        self.system = MagicMock(name="ap-system")
        self.system.board_info.return_value = {
            "model": "Zyxel NWA50BE",
            "hostname": "droplet-ap",
            "release": {"description": "OpenWrt 25.12", "version": "25.12"},
        }
        self.system.uptime_seconds.return_value = 93_784

        self.safe_apply_calls = 0
        cls.instances.append(self)

    @contextmanager
    def safe_apply(self, timeout=60):
        self.safe_apply_calls += 1
        yield


@pytest.fixture(autouse=True)
def _reset_fake_ap():
    _FakeApDevice.instances = []
    _FakeApDevice.droplet_wifi = {"band_steering": "1"}
    _FakeApDevice.wireless_values = DEFAULT_WIRELESS


@pytest.fixture
def router(mock_router: MagicMock, monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Connected MagicMock router with a deterministic AP namespace.

    The wireless routes branch to the ROUTING_MODE=mock surface on
    `hasattr(ap, "get_ap_wireless"/"set_ap_wireless")` — a MagicMock
    auto-creates every attribute, so delete both to force the real AP-direct
    path (same reason test_aps_band_steering does).
    """
    mock_router.wireless.status.return_value = {"radio0": {"up": True}}
    mock_router.ap.get.return_value = {"mac": MAC, "last_ip": AP_IP}
    mock_router.ap.browse_discovered.return_value = [{"mac": MAC, "last_ip": AP_IP}]
    del mock_router.ap.get_ap_wireless
    del mock_router.ap.set_ap_wireless
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


def _radio(body: dict, section: str) -> dict:
    return next(r for r in body["radios"] if r["section"] == section)


class TestWirelessGet:
    def test_reflects_live_uci(self, client, router, reachable_ap):
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["supported"] is True
        assert body["ssid"] == "Droplet"
        # The per-unit passphrase is surfaced so nobody has to ssh for it.
        assert body["key"] == "unit-psk-123"
        assert body["encryption"] == "psk2+ccmp"
        assert body["primary_section"] == "default_radio0"
        assert body["band_steering"] is True
        assert AP_IP in body["ap_detail"]

        dev = _FakeApDevice.instances[0]
        assert dev.ctor == {
            "host": AP_IP, "port": 80,
            "username": "droplet-ai", "password": "per-unit-ap-pw",
        }

    def test_joins_radio_and_iface_sections(self, client, router, reachable_ap):
        body = client.get(PATH, headers=AUTH).json()
        assert [r["section"] for r in body["radios"]] == [
            "default_radio0", "default_radio1",
        ]

        two = _radio(body, "default_radio0")
        assert two["radio"] == "radio0"
        assert two["band"] == "2g"          # from the wifi-device section
        assert two["ssid"] == "Droplet"     # from the wifi-iface section
        assert two["channel"] == "auto"
        assert two["htmode"] == "HE20"
        assert two["primary"] is True
        assert two["disabled"] is False

        five = _radio(body, "default_radio1")
        assert five["band"] == "5g"
        assert five["channel"] == "36"
        assert five["primary"] is False

    def test_live_overlay_reports_link_and_clients(self, client, router, reachable_ap):
        body = client.get(PATH, headers=AUTH).json()
        two = _radio(body, "default_radio0")
        assert two["ifname"] == "phy0-ap0"
        assert two["up"] is True
        assert two["live_channel"] == 6
        assert two["live_htmode"] == "HE20"
        assert two["clients"] == 2
        assert _radio(body, "default_radio1")["clients"] == 1

        assert body["device"] == {
            "model": "Zyxel NWA50BE",
            "firmware": "OpenWrt 25.12",
            "hostname": "droplet-ap",
            "uptime_seconds": 93_784,
        }

    def test_disabled_iface_is_reported(self, client, router, reachable_ap):
        values = copy.deepcopy(DEFAULT_WIRELESS)
        values["default_radio1"]["disabled"] = "1"
        _FakeApDevice.wireless_values = values
        body = client.get(PATH, headers=AUTH).json()
        assert _radio(body, "default_radio1")["disabled"] is True
        assert _radio(body, "default_radio0")["disabled"] is False

    def test_five_ghz_name_mirrors_the_applier_when_steering_on(
        self, client, router, reachable_ap,
    ):
        _FakeApDevice.droplet_wifi = {"band_steering": "1"}
        body = client.get(PATH, headers=AUTH).json()
        assert body["five_ghz_ssid"] == "Droplet"

    def test_five_ghz_name_gets_the_suffix_when_steering_off(
        self, client, router, reachable_ap,
    ):
        _FakeApDevice.droplet_wifi = {"band_steering": "0"}
        body = client.get(PATH, headers=AUTH).json()
        assert body["band_steering"] is False
        # What `/etc/init.d/droplet-band-steer` will name it on next reload.
        assert body["five_ghz_ssid"] == "Droplet-5g"

    def test_pre_substrate_image_has_no_derived_name(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = None
        body = client.get(PATH, headers=AUTH).json()
        assert body["supported"] is True
        assert body["band_steering"] is None
        # Nothing on that AP derives anything, so there is nothing to predict.
        assert body["five_ghz_ssid"] is None

    def test_narrower_acl_degrades_to_config_only(
        self, client, router, reachable_ap, monkeypatch,
    ):
        """An AP whose ACL denies iwinfo still renders — live fields go None
        rather than 502-ing a page the config read could have filled."""
        class _NoIwinfo(_FakeApDevice):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                self.wireless.status.side_effect = UbusError(6)
                self.system.board_info.side_effect = UbusError(6)
                self.system.uptime_seconds.side_effect = UbusError(6)

        monkeypatch.setattr(main, "DropletRouter", _NoIwinfo)
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supported"] is True
        assert body["ssid"] == "Droplet"
        two = _radio(body, "default_radio0")
        assert two["clients"] is None
        assert two["up"] is None
        assert body["device"]["model"] is None

    def test_no_wireless_sections_is_unsupported_not_500(self, client, router, reachable_ap):
        _FakeApDevice.wireless_values = {
            "radio0": {".type": "wifi-device", "band": "2g"},
        }
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["supported"] is False
        assert body["radios"] == []
        assert "no wireless interfaces" in body["ap_detail"]

    def test_no_ap_credential_is_unsupported_with_no_dialout(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "")
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "supported": False,
            "ap_detail": "no AP credential configured",
            "radios": [],
        }
        assert _FakeApDevice.instances == []  # never dialed the AP

    def test_ap_credential_rejection_is_typed_502(self, client, router, ap_credential, monkeypatch):
        class _DeniedApDevice(_FakeApDevice):
            def __init__(self, *a, **kw):
                raise UbusError(6)  # rpcd PERMISSION_DENIED at login

        monkeypatch.setattr(main, "DropletRouter", _DeniedApDevice)
        resp = client.get(PATH, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_AUTH"

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
        resp = client.get("/aps/not-a-mac/wireless", headers=AUTH)
        assert resp.status_code == 404


class TestWirelessPut:
    def test_writes_primary_only_under_safe_apply(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"ssid": "Living Room", "key": "hunter2hunter2"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["mac"] == MAC
        assert body["ssid"] == "Living Room"
        assert body["sections_written"] == ["default_radio0"]
        assert "operation_id" in body

        dev = _FakeApDevice.instances[0]
        assert dev.safe_apply_calls == 1
        # The AP's band-steer applier owns default_radio1 — authoring it here
        # would race the applier, so exactly one section is written.
        dev.uci.set.assert_called_once_with(
            "wireless", "default_radio0",
            {"ssid": "Living Room", "key": "hunter2hunter2"},
        )

    def test_ssid_only_write_leaves_the_key_alone(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"ssid": "Renamed"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        dev = _FakeApDevice.instances[0]
        dev.uci.set.assert_called_once_with("wireless", "default_radio0", {"ssid": "Renamed"})

    def test_key_only_write_keeps_the_existing_name(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"key": "newpassphrase"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        dev = _FakeApDevice.instances[0]
        dev.uci.set.assert_called_once_with("wireless", "default_radio0", {"key": "newpassphrase"})
        # The response still reports the network's current name.
        assert resp.json()["ssid"] == "Droplet"

    def test_reports_the_derived_five_ghz_name(self, client, router, reachable_ap):
        _FakeApDevice.droplet_wifi = {"band_steering": "0"}
        resp = client.put(PATH, json={"ssid": "Split"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["five_ghz_ssid"] == "Split-5g"

    def test_pre_substrate_image_writes_every_interface(self, client, router, reachable_ap):
        """No applier on that image — nothing would derive the 5 GHz name, so
        every interface has to be written directly."""
        _FakeApDevice.droplet_wifi = None
        resp = client.put(PATH, json={"ssid": "Legacy", "key": "legacykey123"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["sections_written"] == ["default_radio0", "default_radio1"]
        dev = _FakeApDevice.instances[0]
        assert {c.args[1] for c in dev.uci.set.call_args_list} == {
            "default_radio0", "default_radio1",
        }
        for call in dev.uci.set.call_args_list:
            assert call.args[0] == "wireless"
            assert call.args[2] == {"ssid": "Legacy", "key": "legacykey123"}

    def test_primary_resolved_by_radio_not_section_name(self, client, router, reachable_ap):
        """A renamed section still lands on the radio0 interface."""
        _FakeApDevice.wireless_values = {
            "radio0": {".type": "wifi-device", "band": "2g"},
            "radio1": {".type": "wifi-device", "band": "5g"},
            "home_24": {".type": "wifi-iface", "device": "radio0", "ssid": "Droplet"},
            "home_5": {".type": "wifi-iface", "device": "radio1", "ssid": "Droplet-5g"},
        }
        resp = client.put(PATH, json={"ssid": "Renamed"}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["sections_written"] == ["home_24"]

    # --- validation: 400, and NOTHING is pushed ---

    @pytest.mark.parametrize("body,fragment", [
        ({"ssid": ""}, "1-32 bytes"),
        ({"ssid": "x" * 33}, "1-32 bytes"),
        # 32 CHARACTERS but 34 BYTES — the 802.11 SSID element is 32 octets,
        # so hostapd would refuse this and take the radios down.
        ({"ssid": "é" * 17}, "1-32 bytes"),
        ({"key": "short"}, "8-63 characters"),
        ({"key": "x" * 64}, "8-63 characters"),
    ])
    def test_out_of_range_is_400_and_pushes_nothing(
        self, client, router, reachable_ap, body, fragment,
    ):
        resp = client.put(PATH, json=body, headers=AUTH)
        assert resp.status_code == 400, resp.text
        assert fragment in resp.json()["detail"]
        # The AP was never even connected to.
        assert _FakeApDevice.instances == []

    def test_validation_never_echoes_the_passphrase(self, client, router, reachable_ap):
        resp = client.put(PATH, json={"key": "sekrit"}, headers=AUTH)
        assert resp.status_code == 400
        assert "sekrit" not in resp.text

    def test_empty_body_is_400(self, client, router, reachable_ap):
        resp = client.put(PATH, json={}, headers=AUTH)
        assert resp.status_code == 400, resp.text
        assert "nothing to change" in resp.json()["detail"]
        assert _FakeApDevice.instances == []

    def test_boundary_values_are_accepted(self, client, router, reachable_ap):
        resp = client.put(
            PATH, json={"ssid": "x" * 32, "key": "y" * 63}, headers=AUTH,
        )
        assert resp.status_code == 200, resp.text

    # --- honesty forks + typed errors ---

    def test_no_ap_credential_is_422_with_no_dialout(self, client, router, monkeypatch):
        monkeypatch.setattr(main, "AP_PASSWORD", "")
        monkeypatch.setattr(main, "DropletRouter", _FakeApDevice)
        resp = client.put(PATH, json={"ssid": "Nope"}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "AP_WIRELESS_UNAVAILABLE"
        assert _FakeApDevice.instances == []

    def test_no_wireless_sections_is_422_and_never_writes(self, client, router, reachable_ap):
        _FakeApDevice.wireless_values = {"radio0": {".type": "wifi-device"}}
        resp = client.put(PATH, json={"ssid": "Nope"}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "AP_WIRELESS_UNAVAILABLE"
        dev = _FakeApDevice.instances[0]
        dev.uci.set.assert_not_called()
        assert dev.safe_apply_calls == 0

    def test_ap_credential_rejection_is_typed_502(self, client, router, ap_credential, monkeypatch):
        class _DeniedApDevice(_FakeApDevice):
            def __init__(self, *a, **kw):
                raise UbusError(6)

        monkeypatch.setattr(main, "DropletRouter", _DeniedApDevice)
        resp = client.put(PATH, json={"ssid": "Nope"}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "AP_AUTH"
        assert "ap_openwrt_password" in detail["message"]

    def test_unreachable_ap_is_typed_502(self, client, router, ap_credential):
        # conftest's autouse stub makes main.DropletRouter raise ConnectionLost.
        resp = client.put(PATH, json={"ssid": "Nope"}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"]["code"] == "AP_UNREACHABLE"

    def test_no_discovered_ip_is_typed_502(self, client, router, ap_credential):
        router.ap.get.return_value = {"mac": MAC}
        router.ap.browse_discovered.return_value = []
        resp = client.put(PATH, json={"ssid": "Nope"}, headers=AUTH)
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "AP_UNREACHABLE"
        assert "no discovered address" in detail["message"]

    def test_invalid_mac_is_404(self, client, router):
        resp = client.put("/aps/not-a-mac/wireless", json={"ssid": "x"}, headers=AUTH)
        assert resp.status_code == 404


class TestWirelessMockSurface:
    """ROUTING_MODE=mock parity — the in-memory _MockAp drives the form."""

    @pytest.fixture
    def mock_mode_client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        from mock_router import MockRouter

        monkeypatch.setattr(main, "router_instance", MockRouter())
        return TestClient(main.app)

    def test_round_trip(self, mock_mode_client):
        seed = mock_mode_client.post(
            "/aps/_test_seed", json={"mac": MAC, "last_ip": AP_IP}, headers=AUTH,
        )
        assert seed.status_code == 200, seed.text

        read = mock_mode_client.get(PATH, headers=AUTH)
        assert read.status_code == 200, read.text
        assert read.json()["ssid"] == "Droplet"

        write = mock_mode_client.put(PATH, json={"ssid": "Mock Home"}, headers=AUTH)
        assert write.status_code == 200, write.text
        assert write.json()["sections_written"] == ["default_radio0"]

        assert mock_mode_client.get(PATH, headers=AUTH).json()["ssid"] == "Mock Home"

    def test_mock_derives_the_five_ghz_name_from_steering(self, mock_mode_client):
        mock_mode_client.post(
            "/aps/_test_seed", json={"mac": MAC, "last_ip": AP_IP}, headers=AUTH,
        )
        assert mock_mode_client.get(PATH, headers=AUTH).json()["five_ghz_ssid"] == "Droplet"

        off = mock_mode_client.put(
            f"/aps/{MAC}/band-steering", json={"enabled": False}, headers=AUTH,
        )
        assert off.status_code == 200, off.text
        body = mock_mode_client.get(PATH, headers=AUTH).json()
        assert body["five_ghz_ssid"] == "Droplet-5g"
        assert next(r for r in body["radios"] if r["band"] == "5g")["ssid"] == "Droplet-5g"

    def test_validation_runs_before_the_mock_too(self, mock_mode_client):
        mock_mode_client.post(
            "/aps/_test_seed", json={"mac": MAC, "last_ip": AP_IP}, headers=AUTH,
        )
        resp = mock_mode_client.put(PATH, json={"key": "short"}, headers=AUTH)
        assert resp.status_code == 400

    def test_unknown_mac_is_404(self, mock_mode_client):
        resp = mock_mode_client.get("/aps/AA:BB:CC:DD:EE:99/wireless", headers=AUTH)
        assert resp.status_code == 404

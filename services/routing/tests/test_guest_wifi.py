"""Tests for guest Wi-Fi status + teardown.

Mirrors test_phone_home.py's three layers: SDK behaviour against a MagicMock
router whose `uci` records calls, the REST endpoints through TestClient, and
auth. (Guest *creation* is covered by test_wireless_defaults_configurable.)
"""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import WirelessApi, UbusError

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# 1. SDK behaviour
# ---------------------------------------------------------------------------


class TestWirelessApiGuest:
    def test_status_reports_configured_guest(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "values": {
                "cfg_lan": {"network": "lan", "ssid": "Home"},
                "cfg_guest": {"network": "guest", "ssid": "Guests", "key": "letmein8"},
            }
        }
        assert WirelessApi(router).guest_status() == {
            "configured": True,
            "enabled": True,
            "ssid": "Guests",
            "password": "letmein8",
        }

    def test_status_marks_disabled_iface(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "values": {"cfg_guest": {"network": "guest", "ssid": "G", "key": "k", "disabled": "1"}}
        }
        assert WirelessApi(router).guest_status()["enabled"] is False

    def test_status_unconfigured_when_absent(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"values": {"cfg_lan": {"network": "lan"}}}
        assert WirelessApi(router).guest_status() == {
            "configured": False,
            "enabled": False,
            "ssid": None,
            "password": None,
        }

    def test_status_unconfigured_when_no_wireless(self) -> None:
        router = MagicMock()
        router.uci.get.side_effect = UbusError(-1, "Object not found")
        assert WirelessApi(router).guest_status()["configured"] is False

    def test_remove_deletes_only_the_guest_iface(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "values": {
                "cfg_lan": {"network": "lan"},
                "cfg_guest": {"network": "guest", "ssid": "G"},
            }
        }
        WirelessApi(router).remove_guest_network()
        router.uci.delete.assert_called_once_with("wireless", "cfg_guest")
        router.uci.commit.assert_called_with("wireless")

    def test_remove_is_idempotent_when_absent(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"values": {"cfg_lan": {"network": "lan"}}}
        WirelessApi(router).remove_guest_network()
        router.uci.delete.assert_not_called()


# ---------------------------------------------------------------------------
# 2. REST endpoints
# ---------------------------------------------------------------------------


class TestGuestEndpoints:
    def test_get_dispatches_status(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.wireless.guest_status.return_value = {
            "configured": False, "enabled": False, "ssid": None, "password": None,
        }
        resp = connected_client.get("/wireless/guest", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json()["configured"] is False
        mock_router.wireless.guest_status.assert_called_once()

    def test_delete_dispatches_remove_and_applies(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.delete("/wireless/guest", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok"}
        mock_router.wireless.remove_guest_network.assert_called_once()
        mock_router.apply_changes.assert_called_with("wireless")


# ---------------------------------------------------------------------------
# 3. Auth
# ---------------------------------------------------------------------------


class TestGuestAuth:
    def test_delete_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.delete("/wireless/guest")
        assert resp.status_code == 401

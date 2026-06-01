"""Tests for phone-home egress control (WARP-613, ADR-012).

Three layers, mirroring test_aps.py / test_vpn.py:

1. **SDK behaviour** — `FirewallApi.block_phone_home` / `unblock_phone_home` /
   `set_camera_phone_home` build the right uci rules (and in the right order)
   against a MagicMock router whose `uci` records calls.
2. **REST endpoints** — driven through FastAPI's TestClient against a
   connected MagicMock router; assert the right SDK method is dispatched.
3. **Auth / disconnected** — bearer required; 503 when the router is down.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import FirewallApi

AUTH = {"authorization": "Bearer pytest-fake-token"}
MAC = "AA:BB:CC:DD:EE:FF"
SUFFIX = "AABBCCDDEEFF"


# ---------------------------------------------------------------------------
# 1. SDK behaviour
# ---------------------------------------------------------------------------


class TestFirewallApiPhoneHome:
    def test_block_adds_ntp_accept_before_reject(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"values": {}}  # no existing rules
        FirewallApi(router).block_phone_home(MAC)

        adds = router.uci.add.call_args_list
        assert len(adds) == 2, "expected an NTP-allow rule then a REJECT rule"

        ntp = adds[0].args
        rej = adds[1].args
        assert ntp[0] == "firewall" and ntp[1] == "rule"
        assert ntp[2]["name"] == f"phonehome-ntp-{SUFFIX}"
        assert ntp[2]["proto"] == "udp" and ntp[2]["dest_port"] == "123"
        assert ntp[2]["target"] == "ACCEPT" and ntp[2]["src_mac"] == MAC
        # The REJECT must come AFTER the NTP ACCEPT so fw4 matches NTP first.
        assert rej[2]["name"] == f"phonehome-{SUFFIX}"
        assert rej[2]["target"] == "REJECT"
        assert "dest_port" not in rej[2]
        router.uci.commit.assert_called_with("firewall")
        router.exec_service.assert_called_with("firewall", "reload")

    def test_block_is_idempotent_removes_existing_first(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "values": {
                "cfg01": {"name": f"phonehome-{SUFFIX}"},
                "cfg02": {"name": f"phonehome-ntp-{SUFFIX}"},
            }
        }
        FirewallApi(router).block_phone_home(MAC)
        deleted = {c.args[1] for c in router.uci.delete.call_args_list}
        assert deleted == {"cfg01", "cfg02"}, "stale phone-home rules cleared first"

    def test_unblock_removes_only_phone_home_rules(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "values": {
                "cfg01": {"name": f"phonehome-{SUFFIX}"},
                "cfg02": {"name": f"phonehome-ntp-{SUFFIX}"},
                # A full schedule-block rule for the SAME MAC must survive.
                "cfg03": {"name": f"block-{SUFFIX}", "src_mac": MAC, "target": "REJECT"},
            }
        }
        FirewallApi(router).unblock_phone_home(MAC)
        deleted = {c.args[1] for c in router.uci.delete.call_args_list}
        assert deleted == {"cfg01", "cfg02"}
        assert "cfg03" not in deleted, "must not touch the schedule full-block rule"

    def test_camera_block_drops_forwarding_adds_ntp(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "cameras_to_wan": {".type": "forwarding", "src": "cameras", "dest": "wan"},
        }
        FirewallApi(router).set_camera_phone_home(True)
        deleted = {c.args[1] for c in router.uci.delete.call_args_list}
        assert "cameras_to_wan" in deleted
        added = [c.args for c in router.uci.add.call_args_list]
        assert any(
            a[1] == "rule" and a[2].get("name") == "Allow-Camera-NTP" and a[2]["dest_port"] == "123"
            for a in added
        ), "NTP carve-out added so camera clocks stay correct"

    def test_camera_unblock_restores_forwarding(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {
            "rule_ntp": {".type": "rule", "name": "Allow-Camera-NTP"},
        }  # forwarding absent
        FirewallApi(router).set_camera_phone_home(False)
        added = [c.args for c in router.uci.add.call_args_list]
        assert any(
            a[1] == "forwarding" and a[2] == {"src": "cameras", "dest": "wan"}
            for a in added
        ), "broad cameras→wan forwarding restored"
        deleted = {c.args[1] for c in router.uci.delete.call_args_list}
        assert "rule_ntp" in deleted


# ---------------------------------------------------------------------------
# 2. REST endpoints
# ---------------------------------------------------------------------------


class TestPhoneHomeEndpoints:
    def test_device_block_dispatches_sdk(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/firewall/phone-home/device", json={"mac": MAC, "blocked": True}, headers=AUTH
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "mac": MAC, "blocked": True}
        mock_router.firewall.block_phone_home.assert_called_once_with(MAC)
        mock_router.firewall.unblock_phone_home.assert_not_called()

    def test_device_unblock_dispatches_sdk(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/firewall/phone-home/device", json={"mac": MAC, "blocked": False}, headers=AUTH
        )
        assert resp.status_code == 200, resp.text
        mock_router.firewall.unblock_phone_home.assert_called_once_with(MAC)
        mock_router.firewall.block_phone_home.assert_not_called()

    def test_cameras_block_dispatches_sdk(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        resp = connected_client.post(
            "/firewall/phone-home/cameras", json={"blocked": True}, headers=AUTH
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "scope": "cameras", "blocked": True}
        mock_router.firewall.set_camera_phone_home.assert_called_once_with(True)

    def test_rejects_bad_mac(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/firewall/phone-home/device", json={"mac": "not-a-mac", "blocked": True}, headers=AUTH
        )
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# 3. Auth / disconnected
# ---------------------------------------------------------------------------


class TestPhoneHomeAuth:
    def test_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post(
            "/firewall/phone-home/device", json={"mac": MAC, "blocked": True}
        )
        assert resp.status_code == 401

    def test_503_when_router_down(self, disconnected_client: TestClient) -> None:
        resp = disconnected_client.post(
            "/firewall/phone-home/device", json={"mac": MAC, "blocked": True}, headers=AUTH
        )
        assert resp.status_code == 503

"""Full interface enumeration — GET /network/interfaces/all.

The existing /network/interfaces only returns lan+wan (a hardcoded tuple). The
read table needs ALL configured interfaces (incl. VLANs + WireGuard) with their
proto/device/address/zone/status. This reuses the proven `uci.get("network")`
enumeration primitive (the one /network/vlans uses) and joins zone membership
from the firewall zones — it cannot cut connectivity (read-only).
"""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import NetworkApi, UbusError, UBUS_STATUS_NOT_FOUND

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# 1. SDK enumeration
# ---------------------------------------------------------------------------


class _FakeRouter:
    def __init__(self, network_cfg, statuses, zones):
        self._network_cfg = network_cfg
        self._statuses = statuses
        self._zones = zones
        self.uci = MagicMock()
        self.uci.get.return_value = network_cfg
        self.firewall = MagicMock()
        self.firewall.get_zones.return_value = zones

    def _call(self, obj, method, args=None):
        # network.interface.<name> status
        if obj.startswith("network.interface.") and method == "status":
            name = obj.rsplit(".", 1)[-1]
            status = self._statuses.get(name)
            if status is None:
                raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")
            return status
        raise AssertionError(f"unexpected call {obj}.{method}")


def test_list_all_interfaces_enumerates_and_joins_zone():
    network_cfg = {
        "lan": {".type": "interface", "proto": "static", "device": "br-lan"},
        "wan": {".type": "interface", "proto": "dhcp", "device": "eth1"},
        "cameras": {".type": "interface", "proto": "static", "device": "br-lan.100"},
        # non-interface sections must be skipped
        "@globals[0]": {".type": "globals"},
    }
    statuses = {
        "lan": {"up": True, "device": "br-lan", "proto": "static",
                "ipv4-address": [{"address": "10.0.0.1", "mask": 24}]},
        "wan": {"up": True, "device": "eth1", "proto": "dhcp",
                "ipv4-address": [{"address": "192.168.1.87", "mask": 24}]},
        # cameras isn't a live ubus object on this box → present:false stub
    }
    zones = {
        "values": {
            "cfg01": {"name": "lan", "network": ["lan"]},
            "cfg02": {"name": "wan", "network": ["wan"]},
            "cfg03": {"name": "cameras", "network": ["cameras"]},
        }
    }
    net = NetworkApi(_FakeRouter(network_cfg, statuses, zones))
    rows = net.list_all_interfaces()

    by_name = {r["name"]: r for r in rows}
    assert set(by_name) == {"lan", "wan", "cameras"}
    assert by_name["lan"]["proto"] == "static"
    assert by_name["lan"]["device"] == "br-lan"
    assert by_name["lan"]["address"] == "10.0.0.1/24"
    assert by_name["lan"]["zone"] == "lan"
    assert by_name["lan"]["up"] is True
    assert by_name["lan"]["present"] is True
    # cameras has no live ubus object → explicit present:false (not a fake "down")
    assert by_name["cameras"]["present"] is False
    assert by_name["cameras"]["zone"] == "cameras"


def test_list_all_interfaces_zone_none_when_unmatched():
    network_cfg = {"lan": {".type": "interface", "proto": "static", "device": "br-lan"}}
    statuses = {"lan": {"up": True, "device": "br-lan", "proto": "static", "ipv4-address": []}}
    zones = {"values": {}}  # no zone references lan
    net = NetworkApi(_FakeRouter(network_cfg, statuses, zones))
    rows = net.list_all_interfaces()
    assert rows[0]["zone"] is None


# ---------------------------------------------------------------------------
# 2. REST endpoint
# ---------------------------------------------------------------------------


class TestInterfacesAllEndpoint:
    def test_returns_enumerated_rows(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.network.list_all_interfaces.return_value = [
            {"name": "lan", "device": "br-lan", "proto": "static",
             "address": "10.0.0.1/24", "zone": "lan", "up": True, "present": True},
        ]
        resp = connected_client.get("/network/interfaces/all", headers=AUTH)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["interfaces"][0]["name"] == "lan"
        assert body["interfaces"][0]["zone"] == "lan"

    def test_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.get("/network/interfaces/all")
        assert resp.status_code == 401

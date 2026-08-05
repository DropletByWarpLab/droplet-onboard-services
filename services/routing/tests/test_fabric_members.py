"""WARP-1731 (ADR-035 §5): read-only fabric member inventory.

The LAN now carries THREE Droplet service types over umdns —
`_droplet-ap._tcp`, `_droplet-switch._tcp` (both in the verbatim WARP-1720
wire capture reused below) and `_droplet-router._tcp` (WARP-1728). Two
layers of coverage:

1. **SDK** — `FabricApi.browse_members()` parses every `_droplet-*._tcp`
   record out of a `umdns browse` reply, tolerating the duplicate-key
   shapes the WARP-1720 pairs hook produces (repeated `txt` → list, single
   `txt` → bare string), dropping records without the mandatory `mac=`
   anchor, and carrying role-specific TXT extras (poe_ports/poe_budget).
2. **Endpoint** — `GET /fabric/members` returns the browse results and
   synthesizes the `role=router` member from facts the service already
   holds (system board + the connected host's br-lan MAC) when the
   router's own advert is absent from its own browse — the router browses
   umdns THROUGH itself, so its self-advert may or may not appear.

Observations only: no device writes anywhere on this surface.
"""

from __future__ import annotations

import json

from droplet_openwrt_sdk import (
    FabricApi,
    UbusError,
    _pairs_keep_duplicates,
)

import main
from tests.test_umdns_dup_keys import UMDNS_BROWSE_RAW, _StubRouter


AUTH = {"authorization": "Bearer pytest-fake-token"}


def _decode(raw: str):
    return json.loads(raw, object_pairs_hook=_pairs_keep_duplicates)


# Modeled on the WARP-1728 `_droplet-router._tcp` advert observed live on
# 2026-08-04 (role=router, mac=02:fc:58:e2:4e:02, host droplet-edge) in the
# same repeated-`txt` blobmsg shape as the verbatim WARP-1720 capture. Raw
# string on purpose: a Python dict literal would collapse the duplicate keys.
UMDNS_WITH_ROUTER_RAW = """
{
    "_droplet-switch._tcp": {
        "droplet-switch": {
            "iface": "br-lan",
            "host": "droplet-switch.local",
            "port": 80,
            "txt": "role=switch",
            "txt": "mac=70:49:a2:77:64:1a",
            "txt": "model=Zyxel GS1900-10HP A1 Switch",
            "txt": "version=25.12.5",
            "txt": "poe_ports=8",
            "txt": "poe_budget=77",
            "ipv4": "192.168.9.2"
        }
    },
    "_droplet-router._tcp": {
        "droplet-edge": {
            "iface": "br-lan",
            "host": "droplet-edge.local",
            "port": 80,
            "txt": "role=router",
            "txt": "mac=02:fc:58:e2:4e:02",
            "txt": "model=Raspberry Pi 5 Model B Rev 1.1",
            "txt": "version=25.12.0",
            "ipv4": "192.168.9.1"
        }
    }
}
"""


# ---------------------------------------------------------------------------
# 1. SDK — FabricApi.browse_members()
# ---------------------------------------------------------------------------


class TestFabricBrowseMembers:
    def test_verbatim_capture_yields_ap_and_switch(self) -> None:
        api = FabricApi(_StubRouter(_decode(UMDNS_BROWSE_RAW)))
        members = api.browse_members()
        by_role = {m["role"]: m for m in members}
        assert set(by_role) == {"ap", "switch"}

        ap = by_role["ap"]
        assert ap["mac"] == "80:ea:0b:39:ae:23"
        assert ap["model"].startswith("Qualcomm")
        assert ap["version"] == "25.12.3"
        assert ap["last_ip"] == "192.168.9.180"
        assert ap["hostname"] == "droplet-ap"
        # serial= is blank on this hardware revision — omitted, not "".
        assert "serial" not in ap["extra"]

        switch = by_role["switch"]
        assert switch["mac"] == "70:49:a2:77:64:1a"
        assert switch["model"] == "Zyxel GS1900-10HP A1 Switch"
        assert switch["version"] == "25.12.5"
        assert switch["last_ip"] == "192.168.9.2"
        assert switch["hostname"] == "droplet-switch"

    def test_switch_extra_carries_poe_txt(self) -> None:
        api = FabricApi(_StubRouter(_decode(UMDNS_BROWSE_RAW)))
        members = api.browse_members()
        switch = next(m for m in members if m["role"] == "switch")
        assert switch["extra"] == {"poe_ports": "8", "poe_budget": "77"}
        # The AP advertises no role-specific extras.
        ap = next(m for m in members if m["role"] == "ap")
        assert ap["extra"] == {}

    def test_router_advert_parsed_when_present(self) -> None:
        api = FabricApi(_StubRouter(_decode(UMDNS_WITH_ROUTER_RAW)))
        members = api.browse_members()
        router = next(m for m in members if m["role"] == "router")
        assert router["mac"] == "02:fc:58:e2:4e:02"
        assert router["hostname"] == "droplet-edge"
        assert router["last_ip"] == "192.168.9.1"

    def test_record_without_mac_dropped(self) -> None:
        raw = """
        {
            "_droplet-switch._tcp": {
                "droplet-switch": {
                    "txt": "role=switch",
                    "txt": "model=Zyxel GS1900-10HP A1 Switch",
                    "ipv4": "192.168.9.2"
                }
            }
        }
        """
        api = FabricApi(_StubRouter(_decode(raw)))
        assert api.browse_members() == []

    def test_single_bare_txt_string_parses(self) -> None:
        # One TXT record never repeats, so even with the WARP-1720 hook it
        # decodes to a bare string. Must parse, not drop.
        raw = """
        {
            "_droplet-ap._tcp": {
                "droplet-ap": {
                    "txt": "mac=AA:BB:CC:DD:EE:FF",
                    "ipv4": "192.168.9.181"
                }
            }
        }
        """
        api = FabricApi(_StubRouter(_decode(raw)))
        members = api.browse_members()
        assert len(members) == 1
        assert members[0]["mac"] == "AA:BB:CC:DD:EE:FF"
        # No role= TXT → the service type is the honest fallback.
        assert members[0]["role"] == "ap"

    def test_non_droplet_services_ignored(self) -> None:
        raw = """
        {
            "_http._tcp": {
                "some-printer": {
                    "txt": "mac=11:22:33:44:55:66",
                    "ipv4": "192.168.9.60"
                }
            }
        }
        """
        api = FabricApi(_StubRouter(_decode(raw)))
        assert api.browse_members() == []

    def test_umdns_object_absent_returns_empty(self) -> None:
        class _AbsentRouter:
            def _call(self, obj, method, args=None):
                raise UbusError(4, "Object not found")

        assert FabricApi(_AbsentRouter()).browse_members() == []


# ---------------------------------------------------------------------------
# 2. Endpoint — GET /fabric/members
# ---------------------------------------------------------------------------


_BR_LAN_MAC = "02:fc:58:e2:4e:02"


def _wire_fabric_router(mock_router, browse_result):
    """Point the conftest MagicMock router at a deterministic fabric view."""
    mock_router.fabric.browse_members.return_value = browse_result
    mock_router.network.device_status.return_value = {
        "br-lan": {"macaddr": _BR_LAN_MAC, "up": True},
        "eth0": {"macaddr": "d8:3a:dd:00:00:01", "up": True},
    }


class TestFabricMembersEndpoint:
    def test_synthesizes_router_when_advert_absent(self, connected_client, mock_router) -> None:
        _wire_fabric_router(
            mock_router,
            FabricApi(_StubRouter(_decode(UMDNS_BROWSE_RAW))).browse_members(),
        )
        resp = connected_client.get("/fabric/members", headers=AUTH)
        assert resp.status_code == 200, resp.text
        members = resp.json()["members"]
        assert {m["role"] for m in members} == {"ap", "switch", "router"}

        router = next(m for m in members if m["role"] == "router")
        # Anchor MAC from the wired management bridge (ADR-035 §2).
        assert router["mac"] == _BR_LAN_MAC
        # Board facts (conftest mock_router board_info fixture values).
        assert router["hostname"] == "test-router"
        assert router["model"] == "test"
        assert router["version"] == "SNAPSHOT"
        # The connected host is the one address the service knows for it.
        assert router["last_ip"] == main.OPENWRT_HOST
        assert router["extra"] == {}

    def test_no_duplicate_router_when_advert_present(self, connected_client, mock_router) -> None:
        _wire_fabric_router(
            mock_router,
            FabricApi(_StubRouter(_decode(UMDNS_WITH_ROUTER_RAW))).browse_members(),
        )
        resp = connected_client.get("/fabric/members", headers=AUTH)
        assert resp.status_code == 200, resp.text
        members = resp.json()["members"]
        routers = [m for m in members if m["role"] == "router"]
        assert len(routers) == 1
        # The advert wins — hostname comes from the browse, not board_info.
        assert routers[0]["hostname"] == "droplet-edge"

    def test_synthesis_degrades_on_ubus_fault(self, connected_client, mock_router) -> None:
        mock_router.fabric.browse_members.return_value = FabricApi(
            _StubRouter(_decode(UMDNS_BROWSE_RAW))
        ).browse_members()
        mock_router.network.device_status.side_effect = UbusError(6, "Permission denied")
        resp = connected_client.get("/fabric/members", headers=AUTH)
        # The mDNS-observed members still return; only the synthesized
        # router member is skipped (no anchor fact to key it on).
        assert resp.status_code == 200, resp.text
        assert {m["role"] for m in resp.json()["members"]} == {"ap", "switch"}

    def test_synthesis_dropped_without_anchor_mac(self, connected_client, mock_router) -> None:
        mock_router.fabric.browse_members.return_value = []
        mock_router.network.device_status.return_value = {}
        resp = connected_client.get("/fabric/members", headers=AUTH)
        assert resp.status_code == 200, resp.text
        # No anchor MAC → no member. Same discipline as the mac-less
        # browse-record drop: never invent an identity.
        assert resp.json()["members"] == []

    def test_requires_bearer(self, connected_client) -> None:
        resp = connected_client.get("/fabric/members")
        assert resp.status_code in (401, 403)

    def test_router_disconnected_503(self, disconnected_client) -> None:
        resp = disconnected_client.get("/fabric/members", headers=AUTH)
        assert resp.status_code == 503

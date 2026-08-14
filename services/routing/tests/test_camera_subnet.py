"""NET-13: GET /network/subnets/cameras must distinguish a genuine router
fault from "camera subnet not configured".

Before the fix the endpoint wrapped the whole UCI read in
`except Exception: return {"enabled": False}`, so an auth failure, transport
loss, or any ubus error was indistinguishable from "subnet not set up" — the
dashboard showed "no camera subnet" when the real problem was an unreachable
router or a wrong token. The fix mirrors `interface_exists`:
only ubus NOT_FOUND/NO_DATA means "not configured"; everything else
propagates to `handle_router_error`.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import main
from droplet_openwrt_sdk import ConnectionLost, UbusError


AUTH = {"authorization": "Bearer pytest-fake-token"}

# ubus status codes (see droplet_openwrt_sdk.UBUS_STATUS)
NOT_FOUND = 4
NO_DATA = 5
PERMISSION_DENIED = 6


@pytest.fixture
def client(monkeypatch, mock_router) -> TestClient:
    monkeypatch.setattr(main, "router_instance", mock_router)
    return TestClient(main.app)


def test_not_configured_returns_enabled_false(client, mock_router):
    """A NOT_FOUND on the `cameras` interface section = legitimately not
    configured → 200 {"enabled": False}."""
    mock_router.uci.get.side_effect = UbusError(NOT_FOUND, "section not found")
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False}


def test_no_data_returns_enabled_false(client, mock_router):
    """NO_DATA is also the not-configured signal."""
    mock_router.uci.get.side_effect = UbusError(NO_DATA, "no data")
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False}


def test_empty_section_returns_enabled_false(client, mock_router):
    """An empty/non-dict section also means not set up — no false 'enabled'."""
    mock_router.uci.get.return_value = {}
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == {"enabled": False}


def test_permission_denied_propagates_not_masked(client, mock_router):
    """A non-not-found ubus error (e.g. wrong token → PERMISSION_DENIED) must
    NOT be masked as 'not configured' — it propagates to handle_router_error
    (500), so the dashboard can tell a fault apart from an unconfigured subnet.
    """
    mock_router.uci.get.side_effect = UbusError(PERMISSION_DENIED, "denied")
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 500
    # Must not be the misleading not-configured body.
    assert resp.json() != {"enabled": False}


def test_connection_lost_propagates_as_503(client, mock_router):
    """Router unreachable → 503, never a false {"enabled": False}."""
    mock_router.uci.get.side_effect = ConnectionLost("router unreachable")
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 503
    assert resp.json() != {"enabled": False}


def test_configured_subnet_returns_enabled_true(client, mock_router):
    """Happy path: the cameras section exists → enabled True with details.
    A missing DHCP pool (NOT_FOUND) is benign and must not flip the result.
    """

    def fake_get(config, section=None, **kwargs):
        if config == "network" and section == "cameras":
            return {"ipaddr": "192.168.100.1", "netmask": "255.255.255.0",
                    "proto": "static"}
        if config == "firewall":
            return {"cfg01": {"name": "cameras", ".type": "zone"}}
        if config == "dhcp" and section == "cameras":
            raise UbusError(NOT_FOUND, "no dhcp section")
        return {}

    mock_router.uci.get.side_effect = fake_get
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is True
    assert body["subnet"] == "192.168.100.1"
    assert body["netmask"] == "255.255.255.0"
    assert body["firewall_zone"] == {"name": "cameras", ".type": "zone"}
    # DHCP pool absent (benign NOT_FOUND) → null, not a 500.
    assert body["dhcp_pool"] is None


def test_dhcp_real_fault_propagates(client, mock_router):
    """If the DHCP read fails with a real (non-not-found) error, that must
    propagate too rather than being silently swallowed."""

    def fake_get(config, section=None, **kwargs):
        if config == "network" and section == "cameras":
            return {"ipaddr": "192.168.100.1", "netmask": "255.255.255.0"}
        if config == "firewall":
            return {}
        if config == "dhcp" and section == "cameras":
            raise UbusError(PERMISSION_DENIED, "denied")
        return {}

    mock_router.uci.get.side_effect = fake_get
    resp = client.get("/network/subnets/cameras", headers=AUTH)
    assert resp.status_code == 500
    assert resp.json() != {"enabled": False}


# ---------------------------------------------------------------------------
# POST /network/subnets/cameras/setup — bridge-vlan membership derivation
# ---------------------------------------------------------------------------
#
# The bridge-vlan write used to hardcode "ports": "eth1:t". Port names differ
# per router hardware (Pi lab unit: eth2/eth0 in br-lan; MikroTik RB5009:
# p2..p8), and a bridge-vlan naming an absent port is silently inert — netifd
# accepts it, no camera traffic ever flows, and safe-apply never rolls back
# because connectivity was not harmed. Membership is now derived from the
# live bridge at call time.


def _wire_setup_router(mock_router, members):
    mock_router.network.device_status.return_value = {
        "br-lan": {"up": True, "bridge-members": members},
    }


def _bridge_vlan_writes(mock_router):
    return [c for c in mock_router.uci.add.call_args_list
            if tuple(c.args[:2]) == ("network", "bridge-vlan")]


def test_setup_derives_tagged_ports_from_live_bridge(client, mock_router):
    """RB5009-shaped bridge: every current member lands tagged, in bridge
    order; the absent eth1 appears nowhere."""
    _wire_setup_router(mock_router, ["p2", "p3", "p4", "p5", "p6", "p7", "p8"])
    resp = client.post("/network/subnets/cameras/setup", json={}, headers=AUTH)
    assert resp.status_code == 200, resp.text
    writes = _bridge_vlan_writes(mock_router)
    assert len(writes) == 1
    values = writes[0].args[2]
    assert values["ports"] == [
        "p2:t", "p3:t", "p4:t", "p5:t", "p6:t", "p7:t", "p8:t",
    ]


def test_setup_pi_shaped_bridge_derives_its_own_names(client, mock_router):
    """Pi lab unit shape (eth2 + eth0 in br-lan): same derivation, no
    hardcoded names of any hardware generation."""
    _wire_setup_router(mock_router, ["eth2", "eth0"])
    resp = client.post("/network/subnets/cameras/setup", json={}, headers=AUTH)
    assert resp.status_code == 200, resp.text
    values = _bridge_vlan_writes(mock_router)[0].args[2]
    assert values["ports"] == ["eth2:t", "eth0:t"]


def test_setup_refuses_when_bridge_membership_unknown(client, mock_router):
    """No members visible → 409 BEFORE the safe-apply window opens and before
    any uci write. A refusal is diagnosable; a silently inert VLAN is not."""
    _wire_setup_router(mock_router, [])
    resp = client.post("/network/subnets/cameras/setup", json={}, headers=AUTH)
    assert resp.status_code == 409
    assert mock_router.uci.add.call_count == 0
    assert mock_router.uci.set.call_count == 0
    mock_router.safe_apply.assert_not_called()

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

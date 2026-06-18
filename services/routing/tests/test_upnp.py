"""Tests for UPnP / NAT-PMP control.

Three layers, mirroring test_phone_home.py:

1. **SDK behaviour** — `FirewallApi.upnp_status` reads the real uci state and
   degrades a missing `upnpd` config to ``available=False`` (the secure default);
   `set_upnp` writes both flags + commits.
2. **REST endpoints** — GET reflects state; POST refuses (422) when miniupnpd
   isn't installed, and dispatches when it is.
3. **Auth** — bearer required for the write.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from droplet_openwrt_sdk import FirewallApi, UbusError

AUTH = {"authorization": "Bearer pytest-fake-token"}


# ---------------------------------------------------------------------------
# 1. SDK behaviour
# ---------------------------------------------------------------------------


class TestFirewallApiUpnp:
    def test_status_available_and_enabled(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"value": "1"}
        assert FirewallApi(router).upnp_status() == {"available": True, "enabled": True}

    def test_status_available_but_disabled(self) -> None:
        router = MagicMock()
        router.uci.get.return_value = {"value": "0"}
        assert FirewallApi(router).upnp_status() == {"available": True, "enabled": False}

    def test_status_unavailable_when_config_missing(self) -> None:
        router = MagicMock()
        router.uci.get.side_effect = UbusError(-1, "uci entry not found")
        assert FirewallApi(router).upnp_status() == {"available": False, "enabled": False}

    def test_set_writes_both_flags_and_commits(self) -> None:
        router = MagicMock()
        FirewallApi(router).set_upnp(True)
        cfg, section, values = router.uci.set.call_args.args
        assert cfg == "upnpd" and section == "config"
        assert values == {"enable_upnp": "1", "enable_natpmp": "1"}
        router.uci.commit.assert_called_with("upnpd")

    def test_set_disable_writes_zeros(self) -> None:
        router = MagicMock()
        FirewallApi(router).set_upnp(False)
        _, _, values = router.uci.set.call_args.args
        assert values == {"enable_upnp": "0", "enable_natpmp": "0"}


# ---------------------------------------------------------------------------
# 2. REST endpoints
# ---------------------------------------------------------------------------


class TestUpnpEndpoints:
    def test_get_reflects_state(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.firewall.upnp_status.return_value = {"available": False, "enabled": False}
        resp = connected_client.get("/upnp", headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"available": False, "enabled": False}

    def test_post_422_when_unavailable(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.firewall.upnp_status.return_value = {"available": False, "enabled": False}
        resp = connected_client.post("/upnp", json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "UPNP_UNAVAILABLE"
        mock_router.firewall.set_upnp.assert_not_called()

    def test_post_dispatches_when_available(self, connected_client: TestClient, mock_router: MagicMock) -> None:
        mock_router.firewall.upnp_status.return_value = {"available": True, "enabled": False}
        resp = connected_client.post("/upnp", json={"enabled": True}, headers=AUTH)
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "enabled": True}
        mock_router.firewall.set_upnp.assert_called_once_with(True)


# ---------------------------------------------------------------------------
# 3. Auth
# ---------------------------------------------------------------------------


class TestUpnpAuth:
    def test_write_requires_bearer(self, connected_client: TestClient) -> None:
        resp = connected_client.post("/upnp", json={"enabled": True})
        assert resp.status_code == 401

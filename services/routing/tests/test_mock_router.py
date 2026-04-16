"""WARP-44: verify the mock router returns fixture-shaped data and writes are no-ops."""

from __future__ import annotations

import pytest

from mock_router import MockRouter


@pytest.fixture
def mock():
    return MockRouter()


class TestMockSystem:
    def test_board_info(self, mock):
        board = mock.system.board_info()
        assert "model" in board
        assert "release" in board
        assert board["release"]["distribution"] == "OpenWrt"

    def test_resource_info(self, mock):
        r = mock.system.resource_info()
        assert r["uptime"] > 0
        assert "memory" in r

    def test_system_info_combines_both(self, mock):
        info = mock.system.system_info()
        assert info["board"]["model"] is not None
        assert info["resources"]["uptime"] > 0

    def test_reboot_is_noop(self, mock):
        # Must not raise — mock should never touch the host.
        mock.system.reboot()


class TestMockNetwork:
    def test_lan_status(self, mock):
        lan = mock.network.interface_status("lan")
        assert lan["up"] is True
        assert lan["ipv4-address"][0]["address"].startswith("10.")

    def test_wan_status(self, mock):
        wan = mock.network.interface_status("wan")
        assert wan["up"] is True

    def test_unknown_interface_returns_down_stub(self, mock):
        iface = mock.network.interface_status("eth99")
        assert iface["up"] is False

    def test_all_interfaces(self, mock):
        all_ifaces = mock.network.get_all_interface_statuses()
        assert "lan" in all_ifaces
        assert "wan" in all_ifaces


class TestMockWireless:
    def test_status_has_radios(self, mock):
        status = mock.wireless.status()
        assert "radio0" in status or "radio1" in status

    def test_scan_results_nonempty(self, mock):
        result = mock.wireless.scan()
        assert len(result["results"]) > 0

    def test_connected_clients(self, mock):
        clients = mock.wireless.connected_clients()
        assert len(clients) >= 1
        assert "mac" in clients[0]

    def test_writes_are_noop(self, mock):
        mock.wireless.set_ssid("radio0", "default_radio0", "NewSSID")
        mock.wireless.set_password("default_radio0", "newpassword")
        mock.wireless.set_channel("radio0", 36)


class TestMockDhcp:
    def test_get_leases_shape(self, mock):
        leases = mock.dhcp.get_leases()
        assert "leases" in leases
        assert len(leases["leases"]) >= 1

    def test_active_leases_list(self, mock):
        leases = mock.dhcp.active_leases()
        assert isinstance(leases, list)
        assert leases[0]["hostname"]

    def test_add_static_lease_noop(self, mock):
        mock.dhcp.add_static_lease("Test", "AA:BB:CC:11:22:33", "10.0.0.99")


class TestMockFirewall:
    def test_zones_have_values_wrapper(self, mock):
        zones = mock.firewall.get_zones()
        assert "values" in zones
        assert len(zones["values"]) >= 1

    def test_rules_shape(self, mock):
        rules = mock.firewall.get_rules()
        assert "values" in rules

    def test_redirects_shape(self, mock):
        redirects = mock.firewall.get_redirects()
        assert "values" in redirects

    def test_block_unblock_noop(self, mock):
        mock.firewall.block_device("AA:BB:CC:11:22:33")
        mock.firewall.unblock_device("AA:BB:CC:11:22:33")


class TestMockSafeApply:
    def test_context_manager_yields_without_raising(self, mock):
        with mock.safe_apply(timeout=60) as inner:
            assert inner is mock


class TestLifespanSwapsToMock:
    """Integration-ish: with ROUTING_MODE=mock, main.router_instance should be
    a MockRouter after the app starts up."""

    def test_main_uses_mock_when_routing_mode_is_mock(self, monkeypatch):
        monkeypatch.setenv("ROUTING_MODE", "mock")
        # Reload main with the new env.
        import importlib
        import sys

        if "main" in sys.modules:
            del sys.modules["main"]
        import main  # noqa: F401 — import exercises ROUTING_MODE parsing

        # We can't easily drive lifespan here without a TestClient, but we
        # can at least assert the module picked up the mode.
        assert main.ROUTING_MODE == "mock"

        # Clean up so other tests see the default again.
        monkeypatch.setenv("ROUTING_MODE", "real")
        if "main" in sys.modules:
            del sys.modules["main"]
        importlib.import_module("main")

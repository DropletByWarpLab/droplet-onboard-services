"""DHCP lease enumeration when the router has no odhcpd `dhcp` object.

The Pi edge router (droplet-edge-router) serves DHCPv4 from dnsmasq alone, so
`ubus call dhcp ipv4leases` raises METHOD_NOT_FOUND rather than returning an
empty result. Before this was guarded, a router with *zero* current leases
returned an empty list from luci-rpc, fell through to the native call, and
raised — 500ing the entire device list at exactly the moment the network was
quiet. These tests pin the fallback order and the degradation behaviour.
"""

from unittest.mock import MagicMock

import pytest

from droplet_openwrt_sdk import DHCPApi, UbusError


def _api(call_side_effect):
    router = MagicMock()
    router._call = MagicMock(side_effect=call_side_effect)
    return DHCPApi(router), router


def _method_not_found(*_args, **_kwargs):
    # ubus status 3 = METHOD_NOT_FOUND, what a dnsmasq-only router returns.
    raise UbusError(3, "Method not found")


class TestActiveLeasesV4:
    def test_prefers_luci_rpc_when_it_returns_leases(self) -> None:
        leases = [{"hostname": "droplet-sys", "ipaddr": "192.168.9.195"}]
        api, router = _api(lambda obj, method, *a, **k: {"dhcp_leases": leases})
        assert api.active_leases() == leases
        # The native object must not even be consulted when luci-rpc answered.
        assert router._call.call_count == 1
        assert router._call.call_args_list[0][0][:2] == ("luci-rpc", "getDHCPLeases")

    def test_empty_luci_rpc_plus_missing_dhcp_object_yields_empty_list(self) -> None:
        """The regression this guard exists for — must NOT raise."""

        def side_effect(obj, method, *_a, **_k):
            if obj == "luci-rpc":
                return {"dhcp_leases": []}
            return _method_not_found()

        api, _ = _api(side_effect)
        assert api.active_leases() == []

    def test_falls_back_to_native_object_when_luci_rpc_missing(self) -> None:
        native = [{"hostname": "printer", "ipaddr": "192.168.9.40"}]

        def side_effect(obj, method, *_a, **_k):
            if obj == "luci-rpc":
                raise UbusError(6, "Access denied")
            return {"dhcp_leases": native}

        api, _ = _api(side_effect)
        assert api.active_leases() == native

    def test_both_sources_unavailable_yields_empty_list(self) -> None:
        api, _ = _api(lambda *_a, **_k: _method_not_found())
        assert api.active_leases() == []

    def test_non_ubus_errors_still_propagate(self) -> None:
        """Only UbusError degrades. A transport failure must stay loud."""

        def side_effect(*_a, **_k):
            raise ConnectionError("router unreachable")

        api, _ = _api(side_effect)
        with pytest.raises(ConnectionError):
            api.active_leases()


class TestActiveLeasesV6:
    def test_empty_luci_rpc_plus_missing_dhcp_object_yields_empty_list(self) -> None:
        def side_effect(obj, method, *_a, **_k):
            if obj == "luci-rpc":
                return {"dhcp6_leases": []}
            return _method_not_found()

        api, _ = _api(side_effect)
        assert api.active_leases_v6() == []

    def test_prefers_luci_rpc_v6_bucket(self) -> None:
        leases = [{"duid": "00010001", "ip6addrs": ["fde2:5557:a4ac::2"]}]
        api, _ = _api(lambda *_a, **_k: {"dhcp6_leases": leases})
        assert api.active_leases_v6() == leases


class TestGetLanPool:
    """`uci get` wraps a section in a `values` envelope.

    Reading the top level returned None for every field, so the dashboard's
    DHCP pool card rendered blank on a router with a perfectly good pool.
    Caught against the Pi edge router, whose dhcp.lan carries explicit
    start/limit/leasetime.
    """

    @staticmethod
    def _pool_api(uci_get_returns):
        # get_lan_pool goes through router.uci.get, not router._call.
        router = MagicMock()
        router.uci.get = MagicMock(return_value=uci_get_returns)
        return DHCPApi(router)

    def test_unwraps_the_values_envelope(self) -> None:
        api = self._pool_api({
            "values": {
                ".name": "lan", ".type": "dhcp", "interface": "lan",
                "start": "100", "limit": "150", "leasetime": "12h",
            }
        })
        assert api.get_lan_pool() == {
            "start": "100", "limit": "150", "leasetime": "12h",
        }

    def test_tolerates_a_pre_unwrapped_section(self) -> None:
        api = self._pool_api({"start": "50", "limit": "20", "leasetime": "1h"})
        assert api.get_lan_pool() == {
            "start": "50", "limit": "20", "leasetime": "1h",
        }

    def test_absent_keys_stay_none(self) -> None:
        """OpenWrt omits keys when a default applies — None means 'default'."""
        api = self._pool_api({"values": {".name": "lan", "interface": "lan"}})
        assert api.get_lan_pool() == {"start": None, "limit": None, "leasetime": None}

    def test_non_dict_response_is_survived(self) -> None:
        api = self._pool_api(None)
        assert api.get_lan_pool() == {"start": None, "limit": None, "leasetime": None}

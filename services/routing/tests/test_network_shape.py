"""Network/wireless SDK status must be deployment-shape-agnostic (ADR-011).

Root-caused 2026-05-31 on the 192.168.1.87 single-box: the OpenWrt there has
only `lan` + `loopback` (WAN is handled by the host, not the containerised
OpenWrt) and its radio is `wlp14s0`, not `wlan0`. The SDK hardcoded a batch
query for `network.interface.wan` and an `iwinfo assoclist` for `wlan0`; both
raised ubus NOT_FOUND → 500 on `/network/interfaces` and `/wireless/clients`
→ the dashboard showed the router OFFLINE. These calls must degrade gracefully.
"""

import pytest

from droplet_openwrt_sdk import (
    NetworkApi,
    WirelessApi,
    UbusError,
    UBUS_STATUS_NOT_FOUND,
)

_LAN_STATUS = {"up": True, "available": True, "device": "br-lan", "proto": "static"}


class _FakeRouter:
    """Minimal router exposing the `_call` the SDK APIs use."""

    def __init__(self, responder):
        self._responder = responder
        self.calls: list[tuple[str, str]] = []

    def _call(self, obj: str, method: str, args=None):
        self.calls.append((obj, method))
        return self._responder(obj, method, args)


def test_interface_statuses_tolerate_missing_wan():
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_STATUS)
        if obj == "network.interface.wan":
            raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")
        raise AssertionError(f"unexpected call {obj}.{method}")

    net = NetworkApi(_FakeRouter(responder))
    out = net.get_all_interface_statuses()

    assert out["lan"]["up"] is True
    # wan isn't configured on this box → absent/down stub, not a raised error
    assert out["wan"]["up"] is False
    assert out["wan"]["available"] is False
    assert out["wan"]["data"]["absent"] is True
    # empty collections so the dashboard can map over them without crashing
    assert out["wan"]["ipv4-address"] == []


def test_interface_statuses_reraise_non_not_found():
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_STATUS)
        raise UbusError(6, "Permission denied")  # not NOT_FOUND → must propagate

    net = NetworkApi(_FakeRouter(responder))
    with pytest.raises(UbusError):
        net.get_all_interface_statuses()


def test_connected_clients_empty_when_device_absent():
    def responder(obj, method, args=None):
        # iwinfo assoclist for a device that doesn't exist on this radio
        raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.connected_clients("wlan0") == []

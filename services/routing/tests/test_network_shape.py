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
    interface_stub,
    UBUS_STATUS_NOT_FOUND,
    UBUS_STATUS_INVALID_ARGUMENT,
    UBUS_STATUS_TIMEOUT,
)

UBUS_STATUS_PERMISSION_DENIED = 6

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

    # lan is read live and explicitly present
    assert out["lan"]["up"] is True
    assert out["lan"]["present"] is True
    # wan isn't configured on this box → explicit present:False stub, not a raise.
    # `present` is the canonical signal (not an overloaded up:false + nested flag).
    assert out["wan"]["present"] is False
    assert out["wan"]["up"] is False
    assert out["wan"]["available"] is False
    # empty collections so the dashboard can map over them without crashing
    assert out["wan"]["ipv4-address"] == []


def test_interface_statuses_tolerate_missing_wan_object():
    """The REAL single-box shape (root-caused live on 192.168.1.87): `wan` is a
    whole missing ubus OBJECT, not a configured interface returning a numeric
    NOT_FOUND. The low-level client surfaces that as a top-level JSON-RPC error →
    ``UbusError(-1, "Object not found")`` (code -1, status UNKNOWN(-1)), distinct
    from the numeric ``NOT_FOUND`` (4) the sibling test above exercises.

    The loop must degrade BOTH shapes to a `present:False` stub via
    `_ubus_object_absent`, NOT re-raise the -1 form. Re-raising here is exactly
    what 500-ed `/network/interfaces` (and `/network/summary`) on the box."""
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_STATUS)
        if obj == "network.interface.wan":
            # missing-OBJECT shape: code -1, message "Object not found"
            raise UbusError(-1, "Object not found")
        raise AssertionError(f"unexpected call {obj}.{method}")

    net = NetworkApi(_FakeRouter(responder))
    out = net.get_all_interface_statuses()  # must NOT raise

    # lan is read live and explicitly present
    assert out["lan"]["up"] is True
    assert out["lan"]["present"] is True
    # wan object absent on this box → identical present:False stub as the numeric
    # NOT_FOUND case (full-shape equality, not just the `present` flag).
    assert out["wan"] == interface_stub(present=False)
    assert out["wan"]["present"] is False


def test_interface_statuses_reraise_non_not_found():
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_STATUS)
        raise UbusError(6, "Permission denied")  # not NOT_FOUND → must propagate

    net = NetworkApi(_FakeRouter(responder))
    with pytest.raises(UbusError):
        net.get_all_interface_statuses()


def test_interface_statuses_reraise_unrelated_minus_one():
    """A code -1 UbusError whose message is NOT the object-absent signal
    (e.g. the low-level client's own "Empty result") is a genuine fault, not a
    deployment shape — it must propagate. Guards the degrade path against keying
    on bare code -1 instead of the not-found message class."""
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            return dict(_LAN_STATUS)
        if obj == "network.interface.wan":
            raise UbusError(-1, "Empty result")
        raise AssertionError(f"unexpected call {obj}.{method}")

    net = NetworkApi(_FakeRouter(responder))
    with pytest.raises(UbusError):
        net.get_all_interface_statuses()


def test_connected_clients_empty_when_device_absent():
    def responder(obj, method, args=None):
        # iwinfo assoclist for a device that doesn't exist on this radio
        raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.connected_clients("wlan0") == []


def test_interface_statuses_timeout_degrades_to_down():
    """A transient ubus TIMEOUT reading one interface degrades to a
    present-but-down stub (self-heals next poll) instead of 500-ing the whole
    overview — distinct from an absent interface, which is present:False."""
    def responder(obj, method, args=None):
        if obj == "network.interface.lan":
            raise UbusError(UBUS_STATUS_TIMEOUT, "Command timed out")
        if obj == "network.interface.wan":
            return dict(_LAN_STATUS)
        raise AssertionError(f"unexpected call {obj}.{method}")

    net = NetworkApi(_FakeRouter(responder))
    out = net.get_all_interface_statuses()

    # lan timed out → degraded, but still PRESENT (configured, just unreadable now)
    assert out["lan"]["present"] is True
    assert out["lan"]["up"] is False
    # wan read fine
    assert out["wan"]["present"] is True
    assert out["wan"]["up"] is True


def test_connected_clients_propagates_caller_error_codes():
    """Symmetric negative test for the wireless path: connected_clients swallows
    only an absent radio (NOT_FOUND/NO_DATA). Codes that signal a caller bug —
    INVALID_ARGUMENT (a malformed `device`) and PERMISSION_DENIED — must
    propagate, not masquerade as 'zero clients'. Guards against the swallow set
    silently widening."""
    for code in (UBUS_STATUS_INVALID_ARGUMENT, UBUS_STATUS_PERMISSION_DENIED):
        def responder(obj, method, args=None, _code=code):
            raise UbusError(_code, "caller error")

        wifi = WirelessApi(_FakeRouter(responder))
        with pytest.raises(UbusError):
            wifi.connected_clients("wlan0")

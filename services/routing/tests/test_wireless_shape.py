"""`/wireless/*` must be deployment-shape-agnostic (ADR-011).

Follow-up to #407 (which made `/network/summary` + `/network/interfaces`
shape-agnostic): the standalone `/wireless/*` endpoints were NOT covered.

Root cause, same as the original router-OFFLINE bug on the 192.168.1.87
single-box: the containerised OpenWrt there exposes only
`network.interface.lan` + `loopback`; `network.wireless` is frequently absent
and the radio is `wlp14s0`, not the default `wlan0`. `WirelessApi.status()` was
a raw `_call("network.wireless", "status")` with no degradation → the low-level
client raises `UbusError(-1, "Object not found")` → `handle_router_error` maps
code -1 to HTTP 500 → the orchestrator classifies 5xx as retryable, retries 3×,
then reports the router UNREACHABLE → dashboard "router OFFLINE". `scan()` and
`radio_info()` had the same gap against a missing `iwinfo` device (numeric
NOT_FOUND/NO_DATA) that `connected_clients()` already degraded.

A missing wireless object / radio is data, not a crash: `status()` degrades to
`{}`, `scan()` to `[]`, `radio_info()` to `{}` — mirroring `connected_clients()`
and `get_network_summary`'s wireless section. Genuine faults
(auth/PERMISSION_DENIED, transport `ConnectionLost`, INVALID_ARGUMENT caller
bugs, unrelated ubus errors) still surface.
"""

import pytest

from droplet_openwrt_sdk import (
    WirelessApi,
    UbusError,
    ConnectionLost,
    UBUS_STATUS_NOT_FOUND,
    UBUS_STATUS_NO_DATA,
    UBUS_STATUS_INVALID_ARGUMENT,
)

UBUS_STATUS_PERMISSION_DENIED = 6

# Whole missing ubus OBJECT (no `network.wireless` registered at all): the
# low-level client surfaces a top-level JSON-RPC error as UbusError(-1,
# "Object not found") — the exact 500 root-caused on the single-box.
OBJECT_NOT_FOUND = UbusError(-1, "Object not found")


class _FakeRouter:
    """Minimal router exposing the `_call` the SDK APIs use."""

    def __init__(self, responder):
        self._responder = responder
        self.calls: list[tuple[str, str]] = []

    def _call(self, obj: str, method: str, args=None):
        self.calls.append((obj, method))
        return self._responder(obj, method, args)


# ---------------------------------------------------------------------------
# status() — whole `network.wireless` object absent (the live single-box bug)
# ---------------------------------------------------------------------------
def test_status_degrades_when_wireless_object_absent():
    """`network.wireless` absent → UbusError(-1, "Object not found") → must
    degrade to `{}`, NOT re-raise (re-raising is the 500 that read OFFLINE)."""
    def responder(obj, method, args=None):
        assert obj == "network.wireless"
        raise OBJECT_NOT_FOUND

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.status() == {}


@pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
def test_status_degrades_on_numeric_not_found(code):
    def responder(obj, method, args=None):
        raise UbusError(code, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.status() == {}


def test_status_returns_live_value_when_present():
    canned = {"radio0": {"up": True, "interfaces": []}}

    def responder(obj, method, args=None):
        return dict(canned)

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.status() == canned


def test_status_reraises_permission_denied():
    def responder(obj, method, args=None):
        raise UbusError(UBUS_STATUS_PERMISSION_DENIED, "Access denied")

    wifi = WirelessApi(_FakeRouter(responder))
    with pytest.raises(UbusError):
        wifi.status()


def test_status_reraises_unrelated_minus_one():
    """A code -1 whose message is NOT the object-absent signal (e.g. "Empty
    result") is a genuine fault and must propagate — the degrade keys on the
    not-found class, not on bare code -1."""
    def responder(obj, method, args=None):
        raise UbusError(-1, "Empty result")

    wifi = WirelessApi(_FakeRouter(responder))
    with pytest.raises(UbusError):
        wifi.status()


def test_status_reraises_transport_loss():
    def responder(obj, method, args=None):
        raise ConnectionLost("router down")

    wifi = WirelessApi(_FakeRouter(responder))
    with pytest.raises(ConnectionLost):
        wifi.status()


# ---------------------------------------------------------------------------
# scan() — absent `iwinfo` device degrades to [] (mirrors connected_clients)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
def test_scan_empty_when_device_absent(code):
    def responder(obj, method, args=None):
        raise UbusError(code, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.scan("wlan0") == []


def test_scan_returns_results_when_present():
    def responder(obj, method, args=None):
        return {"results": [{"ssid": "Droplet-AI"}]}

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.scan("wlp14s0") == [{"ssid": "Droplet-AI"}]


def test_scan_propagates_caller_error_codes():
    """INVALID_ARGUMENT (malformed `device`) and PERMISSION_DENIED are caller/
    auth faults — they must propagate, not masquerade as "no networks"."""
    for code in (UBUS_STATUS_INVALID_ARGUMENT, UBUS_STATUS_PERMISSION_DENIED):
        def responder(obj, method, args=None, _code=code):
            raise UbusError(_code, "caller error")

        wifi = WirelessApi(_FakeRouter(responder))
        with pytest.raises(UbusError):
            wifi.scan("wlan0")


# ---------------------------------------------------------------------------
# radio_info() — absent `iwinfo` device degrades to {} (mirrors the above)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
def test_radio_info_empty_when_device_absent(code):
    def responder(obj, method, args=None):
        raise UbusError(code, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.radio_info("wlan0") == {}


def test_radio_info_returns_value_when_present():
    info = {"channel": 36, "txpower": 20, "frequency": 5180}

    def responder(obj, method, args=None):
        return dict(info)

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.radio_info("wlp14s0") == info


def test_radio_info_propagates_caller_error_codes():
    for code in (UBUS_STATUS_INVALID_ARGUMENT, UBUS_STATUS_PERMISSION_DENIED):
        def responder(obj, method, args=None, _code=code):
            raise UbusError(_code, "caller error")

        wifi = WirelessApi(_FakeRouter(responder))
        with pytest.raises(UbusError):
            wifi.radio_info("wlan0")


# ---------------------------------------------------------------------------
# Route-level: the `/wireless/*` reads stay 200 on the minimal single-box
# ---------------------------------------------------------------------------
def test_wireless_status_route_stays_200_with_object_absent(connected_client, mock_router):
    """End-to-end through the FastAPI route: with `network.wireless` absent (the
    live single-box shape), `GET /wireless/status` returns 200 with `{}` — not
    the 500 that made the orchestrator read the router OFFLINE."""
    mock_router.wireless = WirelessApi(_FakeRouter(lambda *a, **k: (_ for _ in ()).throw(OBJECT_NOT_FOUND)))

    resp = connected_client.get(
        "/wireless/status",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {}


def test_wireless_scan_route_stays_200_with_device_absent(connected_client, mock_router):
    """`GET /wireless/scan` returns 200 with `{"results": []}` when the default
    `wlan0` device isn't present (numeric NOT_FOUND), instead of 500."""
    def responder(obj, method, args=None):
        raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")

    mock_router.wireless = WirelessApi(_FakeRouter(responder))

    resp = connected_client.get(
        "/wireless/scan",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"results": []}


def test_wireless_radio_route_stays_200_with_device_absent(connected_client, mock_router):
    """`GET /wireless/radio/{device}` returns 200 with `{}` when the device
    isn't present on this box, instead of 500."""
    def responder(obj, method, args=None):
        raise UbusError(UBUS_STATUS_NO_DATA, "No data")

    mock_router.wireless = WirelessApi(_FakeRouter(responder))

    resp = connected_client.get(
        "/wireless/radio/wlan0",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {}


def test_wireless_status_route_still_500s_on_real_fault(connected_client, mock_router):
    """A genuine ubus fault (PERMISSION_DENIED) must still surface as an error —
    only the "object/device absent" class degrades. Guards the degrade path
    from silently swallowing a real problem behind a 200."""
    def responder(obj, method, args=None):
        raise UbusError(UBUS_STATUS_PERMISSION_DENIED, "Access denied")

    mock_router.wireless = WirelessApi(_FakeRouter(responder))

    resp = connected_client.get(
        "/wireless/status",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 500

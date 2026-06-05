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
    ScanUnsupportedError,
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
# scan() — WARP-816: distinguish "can't scan here" (AP-mode radio) from a
# genuine zero-network scan.
#
# On the single-box the scan radio (`wlp14s0`) is `mode == "Master"` (AP —
# broadcasting the Droplet network). A single-radio card can't station-scan
# while in AP mode: `iw dev wlp14s0 scan` → "Not supported (-95)". But the
# ubus `iwinfo scan` backend SWALLOWS that -95 and returns `{"results": []}`
# with no error (verified live on 192.168.1.87 through the SDK's own HTTP
# transport). So the empty list is NOT a UbusError to catch — the only signal
# that separates "unsupported here" from "scanned, found nothing" is the radio
# OPERATING MODE (`iwinfo info` → `mode`). Master/AP ⇒ unsupported; any
# scannable mode (Client/managed, Mesh, Monitor, …) that returns 0 networks is
# a legitimate empty `[]`.
# ---------------------------------------------------------------------------
def _scan_then_info(scan_results, info):
    """Build a responder that answers `iwinfo scan` then `iwinfo info`."""

    def responder(obj, method, args=None):
        assert obj == "iwinfo"
        if method == "scan":
            return {"results": list(scan_results)}
        if method == "info":
            return dict(info)
        raise AssertionError(f"unexpected iwinfo method {method!r}")

    return responder


def test_scan_raises_unsupported_when_radio_in_ap_mode():
    """Empty scan + `mode == "Master"` (AP) ⇒ the radio physically can't scan
    here. Must raise ScanUnsupportedError, NOT degrade to `[]` (the `[]` is the
    bug that made the dashboard show "no networks" on the single-box)."""
    router = _FakeRouter(_scan_then_info([], {"mode": "Master"}))
    wifi = WirelessApi(router)
    with pytest.raises(ScanUnsupportedError):
        wifi.scan("wlp14s0")
    # It only probes the mode AFTER an empty scan — and does so exactly once.
    assert router.calls == [("iwinfo", "scan"), ("iwinfo", "info")]


@pytest.mark.parametrize("mode", ["Master", "AP", "master", "ap"])
def test_scan_unsupported_mode_match_is_case_insensitive(mode):
    """`iwinfo` reports `"Master"`; guard against a build/driver that reports
    `"AP"` or a different case. Any AP-role spelling ⇒ unsupported."""
    wifi = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": mode})))
    with pytest.raises(ScanUnsupportedError):
        wifi.scan("wlp14s0")


@pytest.mark.parametrize("mode", ["Client", "managed", "Mesh Point", "Monitor", ""])
def test_scan_empty_stays_empty_on_scannable_mode(mode):
    """A radio in a scannable mode (or unknown/blank mode) that genuinely finds
    zero networks must STILL return `[]` (AC: unsupported is DISTINCT from
    empty). Only the AP-role mode maps to unsupported."""
    wifi = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": mode})))
    assert wifi.scan("wlp14s0") == []


def test_scan_returns_results_without_probing_mode():
    """The happy path (non-empty results) must NOT make a second `iwinfo info`
    call — results are returned verbatim. Guards against a needless round-trip
    and proves the mode probe is empty-only."""
    router = _FakeRouter(_scan_then_info([{"ssid": "Droplet-AI"}], {"mode": "Master"}))
    wifi = WirelessApi(router)
    assert wifi.scan("wlp14s0") == [{"ssid": "Droplet-AI"}]
    assert router.calls == [("iwinfo", "scan")]


def test_scan_absent_device_stays_empty_without_probing_mode():
    """The absent-device degrade (NOT_FOUND/NO_DATA → `[]`, ADR-011) is
    untouched and short-circuits BEFORE the mode probe: a device that isn't
    present has no mode to read. Regression guard for the multi-box / wlan0
    shape (a radio the box doesn't have)."""
    calls: list[tuple[str, str]] = []

    def responder(obj, method, args=None):
        calls.append((obj, method))
        raise UbusError(UBUS_STATUS_NOT_FOUND, "Not found")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.scan("wlan0") == []
    assert calls == [("iwinfo", "scan")]  # never reached `info`


def test_scan_empty_stays_empty_when_mode_probe_itself_fails():
    """Defensive: if the empty scan can't be classified because the follow-up
    `iwinfo info` errors (device vanished between calls, transient ubus fault),
    fall back to the historical `[]` rather than inventing an unsupported
    signal. "Couldn't prove it's AP-mode" ⇒ treat as empty, never crash."""

    def responder(obj, method, args=None):
        if method == "scan":
            return {"results": []}
        raise UbusError(UBUS_STATUS_NO_DATA, "gone")

    wifi = WirelessApi(_FakeRouter(responder))
    assert wifi.scan("wlp14s0") == []


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


# ---------------------------------------------------------------------------
# Route-level: WARP-816 — `/wireless/scan` surfaces a TYPED unsupported signal
# (stable `code`, 409) when the radio is in AP mode, and a plain 200 `[]` when
# a scannable radio genuinely finds nothing. The orchestrator maps the code to
# a RouterError so the dashboard renders calm copy instead of "no networks".
# ---------------------------------------------------------------------------
def test_wireless_scan_route_409_with_stable_code_when_ap_mode(connected_client, mock_router):
    """AP-mode radio (empty scan + `mode == "Master"`) → 409 carrying a stable
    `code: "SCAN_UNSUPPORTED"`. NOT a 200 with `[]` (the bug) and NOT a bare 500
    (which the orchestrator would retry + misread as UNREACHABLE)."""
    mock_router.wireless = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": "Master"})))

    resp = connected_client.get(
        "/wireless/scan",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "SCAN_UNSUPPORTED"


def test_wireless_scan_route_200_empty_on_scannable_radio(connected_client, mock_router):
    """Regression guard (AC: unsupported ≠ empty). A scannable radio (mode
    "Client") that finds zero networks still returns 200 `{"results": []}` — the
    normal empty-state, distinct from the AP-mode unsupported signal."""
    mock_router.wireless = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": "Client"})))

    resp = connected_client.get(
        "/wireless/scan",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"results": []}

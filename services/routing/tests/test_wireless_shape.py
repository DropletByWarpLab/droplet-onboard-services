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

WARP-1681 carve-out: for `status()` specifically, INVALID_ARGUMENT is NOT a
caller bug — `status()` sends no arguments. On OpenWrt 25.12 netifd
strict-validates message attributes while the uhttpd session bridge injects
`ubus_rpc_session` into every call, so a sessioned `network.wireless status`
ALWAYS fails INVALID_ARGUMENT (the live Pi edge router, `droplet-edge`).
`status()` falls back to rpcd's `luci-rpc getWirelessDevices` (same netifd
shape, session-native). `scan()`/`radio_info()` keep propagating
INVALID_ARGUMENT — their `device` argument makes it a real caller-bug signal,
and their `iwinfo` backend is rpcd-served (never strict-rejected).
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
# status() — WARP-1681: the Pi edge router (OpenWrt 25.12). netifd
# strict-validates message attributes and the uhttpd session bridge injects
# `ubus_rpc_session` into every authenticated call, so the sessioned
# `network.wireless status` ALWAYS returns INVALID_ARGUMENT even though the
# object exists and the ACL grants it (verified live on droplet-edge — even a
# valid `{"device": "radio0"}` fails remotely while succeeding locally).
# status() must fall back to rpcd's `luci-rpc getWirelessDevices`, which
# returns the identical netifd shape enriched with a per-radio `iwinfo` block
# that must be stripped for shape parity.
# ---------------------------------------------------------------------------
LUCI_RPC_DEVICES = {
    "radio0": {
        "up": True,
        "pending": False,
        "autostart": True,
        "disabled": False,
        "retry_setup_failed": False,
        "config": {"type": "mac80211", "band": "5g", "channel": "34"},
        "interfaces": [],
        "iwinfo": {"phy": "phy0", "hardware": {"name": "Cypress CYW43455"}},
    }
}

NETIFD_SHAPE = {
    "radio0": {
        "up": True,
        "pending": False,
        "autostart": True,
        "disabled": False,
        "retry_setup_failed": False,
        "config": {"type": "mac80211", "band": "5g", "channel": "34"},
        "interfaces": [],
    }
}


def _strict_netifd_router(luci_result=None, luci_error=None):
    """Router whose `network.wireless` strict-rejects every sessioned call and
    whose `luci-rpc getWirelessDevices` answers (or raises `luci_error`) — the
    droplet-edge shape."""

    def responder(obj, method, args=None):
        if obj == "network.wireless":
            raise UbusError(
                UBUS_STATUS_INVALID_ARGUMENT, "ubus error: INVALID_ARGUMENT"
            )
        assert (obj, method) == ("luci-rpc", "getWirelessDevices")
        if luci_error is not None:
            raise luci_error
        return luci_result

    return _FakeRouter(responder)


def test_status_falls_back_to_luci_rpc_on_strict_reject():
    """The live WARP-1681 shape: primary call INVALID_ARGUMENT → one luci-rpc
    round-trip → netifd shape with the `iwinfo` enrichment stripped."""
    router = _strict_netifd_router(luci_result=LUCI_RPC_DEVICES)
    wifi = WirelessApi(router)
    assert wifi.status() == NETIFD_SHAPE
    assert router.calls == [
        ("network.wireless", "status"),
        ("luci-rpc", "getWirelessDevices"),
    ]


def test_status_no_fallback_round_trip_when_primary_succeeds():
    """Tolerant-netifd builds (single-box, legacy multi-box) must not grow a
    second round-trip."""
    canned = {"radio0": {"up": True, "interfaces": []}}
    router = _FakeRouter(lambda obj, method, args=None: dict(canned))
    wifi = WirelessApi(router)
    assert wifi.status() == canned
    assert router.calls == [("network.wireless", "status")]


def test_status_degrades_when_strict_and_luci_rpc_object_absent():
    """Strict netifd AND no rpcd-mod-luci on the build → `{}` (ADR-011).
    status() is argless, so no genuine caller bug hides behind the degrade."""
    router = _strict_netifd_router(luci_error=UbusError(-1, "Object not found"))
    assert WirelessApi(router).status() == {}


@pytest.mark.parametrize("code", [UBUS_STATUS_NOT_FOUND, UBUS_STATUS_NO_DATA])
def test_status_degrades_when_strict_and_luci_rpc_numeric_not_found(code):
    router = _strict_netifd_router(luci_error=UbusError(code, "Not found"))
    assert WirelessApi(router).status() == {}


def test_status_fallback_propagates_real_luci_rpc_fault():
    """A genuine fault from the FALLBACK (e.g. an ACL that grants
    network.wireless but not luci-rpc) must surface — never read as
    radio-less."""
    router = _strict_netifd_router(
        luci_error=UbusError(UBUS_STATUS_PERMISSION_DENIED, "Access denied")
    )
    wifi = WirelessApi(router)
    with pytest.raises(UbusError):
        wifi.status()


def test_status_fallback_propagates_transport_loss():
    """`ConnectionLost` during the fallback round-trip is a transport fault,
    not shape data — it must propagate."""

    def responder(obj, method, args=None):
        if obj == "network.wireless":
            raise UbusError(
                UBUS_STATUS_INVALID_ARGUMENT, "ubus error: INVALID_ARGUMENT"
            )
        raise ConnectionLost("router down")

    wifi = WirelessApi(_FakeRouter(responder))
    with pytest.raises(ConnectionLost):
        wifi.status()


def test_status_fallback_tolerates_non_dict_reply():
    """A luci-rpc reply that isn't a dict (defensive: odd build, empty body
    coerced to null) degrades to `{}` rather than crashing the comprehension."""
    router = _strict_netifd_router(luci_result=None)
    assert WirelessApi(router).status() == {}


def test_status_fallback_strips_iwinfo_from_every_radio():
    """Multi-radio reply: the `iwinfo` block is stripped per-radio; everything
    else survives byte-for-byte."""
    two_radios = {
        "radio0": {"up": True, "interfaces": [], "iwinfo": {"phy": "phy0"}},
        "radio1": {"up": False, "interfaces": [], "iwinfo": {"phy": "phy1"}},
    }
    router = _strict_netifd_router(luci_result=two_radios)
    out = WirelessApi(router).status()
    assert out == {
        "radio0": {"up": True, "interfaces": []},
        "radio1": {"up": False, "interfaces": []},
    }
    assert all("iwinfo" not in radio for radio in out.values())


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


def _null_scan_then_info(info):
    """Responder where `iwinfo scan` replies the literal null shape
    `{"results": null}` (key present, value null) before `iwinfo info`."""

    def responder(obj, method, args=None):
        assert obj == "iwinfo"
        if method == "scan":
            return {"results": None}
        if method == "info":
            return dict(info)
        raise AssertionError(f"unexpected iwinfo method {method!r}")

    return responder


def test_scan_coerces_null_results_to_empty_list():
    """`iwinfo scan` can reply `{"results": null}` (key present, value null).
    `dict.get("results", [])` returns the default ONLY when the key is ABSENT,
    so a present-but-null value would leak `None` and break the `list[dict]`
    contract. The `or []` coalesce must turn it into `[]` — and, like any empty
    result, still trigger the AP-mode probe (here the probe finds Master → the
    "can't scan here" signal, NOT a `None` return)."""
    router = _FakeRouter(_null_scan_then_info({"mode": "Master"}))
    wifi = WirelessApi(router)
    with pytest.raises(ScanUnsupportedError):
        wifi.scan("wlp14s0")
    # null result is treated exactly like `[]`: it probes the mode once.
    assert router.calls == [("iwinfo", "scan"), ("iwinfo", "info")]


def test_scan_null_results_on_scannable_radio_returns_empty_list():
    """A `{"results": null}` reply on a *scannable* radio (mode "Client") must
    coalesce to `[]` — never `None`. Guards the return contract on the happy
    empty-state path, not just the unsupported one."""
    router = _FakeRouter(_null_scan_then_info({"mode": "Client"}))
    wifi = WirelessApi(router)
    out = wifi.scan("wlp14s0")
    assert out == []
    assert out is not None


# ---------------------------------------------------------------------------
# scan() — WARP-816 review (Romain): the probed mode must reach the raised
# error WITHOUT a shared instance/class side-channel. `WirelessApi` is a
# module-level singleton (`get_router().wireless`) and FastAPI runs the sync
# `/wireless/scan` route in a threadpool, so a `self._last_probed_mode`
# write-then-read races: a second concurrent scan could reset it to `None`
# before the first reads it, dropping the `(radio mode: …)` detail. The mode
# is now RETURNED as a local from `_scan_blocked_by_ap_mode` and unpacked at
# the call site — never stashed on `self`.
# ---------------------------------------------------------------------------
def test_scan_unsupported_error_carries_probed_mode():
    """The raised `ScanUnsupportedError` must name the mode it actually saw
    (`"Master"`), and that mode must come from the call's own return value, not
    a shared attribute. Asserting `.mode` (which the pre-fix tests never did) is
    what makes the race observable: a dropped mode surfaces as `mode is None`."""
    router = _FakeRouter(_scan_then_info([], {"mode": "Master"}))
    wifi = WirelessApi(router)
    with pytest.raises(ScanUnsupportedError) as excinfo:
        wifi.scan("wlp14s0")
    assert excinfo.value.mode == "Master"
    # The detail string the dashboard/orchestrator may echo must include it.
    assert "Master" in str(excinfo.value)


def test_scan_blocked_by_ap_mode_returns_blocked_and_mode_tuple():
    """`_scan_blocked_by_ap_mode` returns `(blocked, mode)` as locals — the
    classification AND the mode it read, with no reliance on instance state.
    This is the contract the call site unpacks."""
    wifi = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": "Master"})))
    assert wifi._scan_blocked_by_ap_mode("wlp14s0") == (True, "Master")

    wifi2 = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": "Client"})))
    assert wifi2._scan_blocked_by_ap_mode("wlp14s0") == (False, "Client")


def test_scan_blocked_by_ap_mode_keeps_no_shared_mode_attribute():
    """Regression guard for Romain's finding: the probed mode must NOT be
    parked on a shared `_last_probed_mode` attribute (the singleton side-channel
    that raced across threadpool requests). It lives only in the return value."""
    wifi = WirelessApi(_FakeRouter(_scan_then_info([], {"mode": "Master"})))
    wifi._scan_blocked_by_ap_mode("wlp14s0")
    assert not hasattr(wifi, "_last_probed_mode")
    assert not hasattr(WirelessApi, "_last_probed_mode")


def test_interleaved_probes_do_not_corrupt_each_others_mode():
    """Two probes whose underlying calls interleave must each report THEIR OWN
    mode from THEIR OWN return — proving the result is a local, not a shared
    attribute a concurrent probe could overwrite. Simulates the threadpool race
    deterministically: build B's call result in between starting and reading
    A's, on the same singleton instance."""
    wifi = WirelessApi(_FakeRouter(lambda *a, **k: {}))

    def probe(mode: str):
        return WirelessApi(_FakeRouter(_scan_then_info([], {"mode": mode})))._scan_blocked_by_ap_mode("dev")

    # Resolve A, then B, then assert A's value is intact (a `self` write by B
    # would have clobbered it under the old design).
    blocked_a, mode_a = probe("Master")
    blocked_b, mode_b = probe("Client")
    assert (blocked_a, mode_a) == (True, "Master")
    assert (blocked_b, mode_b) == (False, "Client")


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
    # WARP-816 review: the probed mode must survive end-to-end (it travels in
    # the message detail). A dropped mode — the singleton side-channel race —
    # would leave the `(radio mode: …)` text out of the body.
    assert "Master" in body["message"]


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


def test_wireless_status_route_stays_200_on_strict_netifd(connected_client, mock_router):
    """WARP-1681 end-to-end: the droplet-edge strict-reject (INVALID_ARGUMENT
    on every sessioned `network.wireless status`) serves 200 with the
    luci-rpc-derived netifd shape. This exact call chain was the live 400 that
    made `GET /api/network/status` 503 and the dashboard Network tab read the
    router as broken."""
    mock_router.wireless = WirelessApi(_strict_netifd_router(luci_result=LUCI_RPC_DEVICES))

    resp = connected_client.get(
        "/wireless/status",
        headers={"Authorization": "Bearer pytest-fake-token"},
    )

    assert resp.status_code == 200
    assert resp.json() == NETIFD_SHAPE

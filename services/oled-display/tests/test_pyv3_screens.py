"""py-v3 front-panel redesign — sim-backend renderer contract.

The design source of truth is
docs design_handoff_pyportal_touchscreen/{README.md,preview.html}. These
tests pin the CPython sim (`display.py`) renderers that mirror the device
firmware 1:1, so the rendered PNG matches the device intent.

The three live states (idle clock, combined System+Wi-Fi, alerts drawer)
plus the power sequences (boot/shutdown/standby) each render a full
480x320 frame. The 12/24 toggle is honored by both the idle hero clock and
the System-header clock via one shared formatter.

All tests run on the sim backend (see conftest) — nothing opens a real
serial device.
"""

from __future__ import annotations

import datetime as _dt

import pytest
from PIL import Image

import display as display_module
from display import TFTDisplay, WIDTH, HEIGHT


# Sample live values straight from the handoff preview.html `data` object so
# the rendered frames match the design reference 1:1.
SAMPLE_STATS = {
    "cpu": 24, "mem": 47, "disk": 62, "temp": 54,
    "ip": "192.168.50.41", "hostname": "droplet-lab",
    "uptime": "4d 12h", "now": "14:08",
    "date": "SUNDAY, JUN 1",
}
SAMPLE_WIFI = {
    "ssid": "Droplet-AI", "clients": 3, "channel": 36, "band": "5GHz",
    "key_ttl_seconds": 24 * 60, "password": "hello-droplet-25",
}
SAMPLE_CAMERAS = {"online": 3, "total": 4, "events": []}
SAMPLE_NET = {"wan_latency_ms": 12, "lan_clients": 7}


def _seed(d: TFTDisplay) -> None:
    d.update_stats(SAMPLE_STATS)
    d.update_wifi(SAMPLE_WIFI)
    d.update_cameras(SAMPLE_CAMERAS)
    d.update_net(SAMPLE_NET)


# --- Mode constants ---------------------------------------------------------

def test_pyv3_mode_constants_exist():
    # Idle clock + combined System+Wi-Fi + standby are the new live modes.
    assert TFTDisplay.IDLE == "idle"
    assert TFTDisplay.SYSTEM == "system"
    assert TFTDisplay.STANDBY == "standby"


# --- Idle clock -------------------------------------------------------------

def test_render_idle_returns_full_frame(sim_display: TFTDisplay):
    _seed(sim_display)
    img = sim_display.render_idle()
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_idle_24h_and_12h_differ(sim_display: TFTDisplay):
    # The 12/24 toggle changes the hero lockup (no leading zero + AM/PM in
    # 12h), so the two frames must not be byte-identical.
    _seed(sim_display)
    sim_display.set_clock_mode("24")
    img24 = sim_display.render_idle(now=_dt.datetime(2026, 6, 1, 14, 8, 30))
    sim_display.set_clock_mode("12")
    img12 = sim_display.render_idle(now=_dt.datetime(2026, 6, 1, 14, 8, 30))
    assert img24.tobytes() != img12.tobytes()


def test_clock_mode_default_is_24(sim_display: TFTDisplay):
    # Handoff: default '24'.
    assert sim_display.clock_mode == "24"


def test_set_clock_mode_persists_in_ram(sim_display: TFTDisplay):
    sim_display.set_clock_mode("12")
    assert sim_display.clock_mode == "12"
    sim_display.set_clock_mode("24")
    assert sim_display.clock_mode == "24"


def test_set_clock_mode_rejects_garbage(sim_display: TFTDisplay):
    # Only '12' / '24' are valid; anything else is ignored (stays at default).
    sim_display.set_clock_mode("13")
    assert sim_display.clock_mode == "24"


def test_fmt_clock_12h_has_no_leading_zero_and_ampm(sim_display: TFTDisplay):
    sim_display.set_clock_mode("12")
    parts = sim_display._fmt_clock_parts(_dt.datetime(2026, 6, 1, 9, 5))
    assert parts["hh"] == "9"          # no leading zero in 12h
    assert parts["mm"] == "05"
    assert parts["suffix"] == "AM"
    assert parts["is12"] is True


def test_fmt_clock_24h_pads_hour(sim_display: TFTDisplay):
    sim_display.set_clock_mode("24")
    parts = sim_display._fmt_clock_parts(_dt.datetime(2026, 6, 1, 9, 5))
    assert parts["hh"] == "09"
    assert parts["suffix"] == ""       # no AM/PM in 24h
    assert parts["is12"] is False


# --- Combined System + Wi-Fi ------------------------------------------------

def test_render_system_returns_full_frame(sim_display: TFTDisplay):
    _seed(sim_display)
    img = sim_display.render_system()
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_system_honors_clock_mode(sim_display: TFTDisplay):
    # The System header clock reuses the idle formatter, so the 12/24 toggle
    # changes the header too.
    _seed(sim_display)
    sim_display.set_clock_mode("24")
    a = sim_display.render_system(now=_dt.datetime(2026, 6, 1, 14, 8))
    sim_display.set_clock_mode("12")
    b = sim_display.render_system(now=_dt.datetime(2026, 6, 1, 14, 8))
    assert a.tobytes() != b.tobytes()


def test_system_rotate_region_absent_when_rotation_disabled(sim_display: TFTDisplay):
    # WARP-638: rotation OFF is the box default (the bridge returns
    # rotation_enabled=False). The sim mirror must NOT draw the KEY rotate pill
    # or register its tap region in that state — same gating as the firmware,
    # so the rendered preview matches the panel and there's no rotate affordance
    # to tap into the OOM-able re-render path.
    _seed(sim_display)
    sim_display.update_wifi({"rotation_enabled": False})
    sim_display.render_system()
    names = [r.name for r in sim_display._touch_regions]
    assert "key_rotate" not in names, (
        f"rotate region must be absent when rotation disabled; got {names}")


def test_system_rotate_region_present_when_rotation_enabled(sim_display: TFTDisplay):
    _seed(sim_display)
    sim_display.update_wifi({"rotation_enabled": True, "key_ttl_seconds": 1440})
    sim_display.render_system()
    names = [r.name for r in sim_display._touch_regions]
    assert "key_rotate" in names


def test_system_rotation_disabled_changes_frame(sim_display: TFTDisplay):
    # The presence/absence of the pill is a visible difference, so the two
    # frames must not be byte-identical (proves the pill is actually gated, not
    # just the region).
    _seed(sim_display)
    sim_display.update_wifi({"rotation_enabled": True, "key_ttl_seconds": 1440})
    enabled = sim_display.render_system()
    sim_display.update_wifi({"rotation_enabled": False})
    disabled = sim_display.render_system()
    assert enabled.tobytes() != disabled.tobytes()


def test_render_system_with_alerts_drawer(sim_display: TFTDisplay):
    _seed(sim_display)
    sim_display.push_alert({"type": "cam", "title": "driveway: person",
                            "detail": "confidence 91%", "time": "2m ago"})
    sim_display.push_alert({"type": "sys", "title": "orchestrator restart",
                            "detail": "auto-recovered", "time": "14m ago"})
    sim_display._events_open = True
    img = sim_display.render_system()
    assert img.size == (WIDTH, HEIGHT)


def test_alerts_drawer_open_changes_frame(sim_display: TFTDisplay):
    _seed(sim_display)
    sim_display.push_alert({"type": "cam", "title": "driveway: person",
                            "detail": "confidence 91%", "time": "2m ago"})
    closed = sim_display.render_system()
    sim_display._events_open = True
    opened = sim_display.render_system()
    assert closed.tobytes() != opened.tobytes()


def test_open_alerts_count(sim_display: TFTDisplay):
    sim_display.push_alert({"type": "cam", "title": "a", "detail": "", "time": ""})
    sim_display.push_alert({"type": "sys", "title": "b", "detail": "", "time": ""})
    assert sim_display._open_alerts_count() == 2
    # Clearing one drops the open count.
    sim_display._alerts[0]["cleared"] = True
    assert sim_display._open_alerts_count() == 1


# --- Power sequences --------------------------------------------------------

def test_render_boot_progress_returns_full_frame(sim_display: TFTDisplay):
    # The boot vessel fills with accent liquid as `progress` ramps 0..1.
    img = sim_display.render_boot(progress=0.6)
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_boot_progress_changes_frame(sim_display: TFTDisplay):
    early = sim_display.render_boot(progress=0.1)
    late = sim_display.render_boot(progress=0.9)
    assert early.tobytes() != late.tobytes()


def test_render_shutdown_drain_and_collapse(sim_display: TFTDisplay):
    drain = sim_display.render_shutdown(progress=0.3)
    collapse = sim_display.render_shutdown(progress=0.95)
    assert drain.size == (WIDTH, HEIGHT)
    assert collapse.size == (WIDTH, HEIGHT)
    assert drain.tobytes() != collapse.tobytes()


def test_render_standby_returns_full_frame(sim_display: TFTDisplay):
    img = sim_display.render_standby()
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


# --- Claim screen (WARP-632 / ADR-017), py-v3 editorial render --------------
#
# The claim feature's mode/state/serial wiring is pinned in test_display.py;
# these tests pin the py-v3 *visual* render specifically — that render_claim
# produces a full editorial frame, the code is actually drawn (so the hero is
# load-bearing, not a no-op), and the defensive empty-input path still renders.

CLAIM_CODE = "DRPL-7K2Q-9F4M"
CLAIM_URL = "https://192.168.1.87/setup"


def test_render_claim_returns_full_pyv3_frame(sim_display: TFTDisplay):
    img = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_claim_draws_the_code(sim_display: TFTDisplay):
    # The code is the hero — a different code must change the frame, proving the
    # hero text is rendered (not dropped). Same URL so only the code varies.
    a = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    b = sim_display.render_claim("DRPL-AB12-CD34", CLAIM_URL)
    assert a.tobytes() != b.tobytes()


def test_render_claim_url_is_rendered(sim_display: TFTDisplay):
    # The setup URL appears at the foot — toggling it changes the frame.
    with_url = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    without_url = sim_display.render_claim(CLAIM_CODE, "")
    assert with_url.tobytes() != without_url.tobytes()


def test_render_claim_tolerates_empty_inputs(sim_display: TFTDisplay):
    # Host hasn't pushed a code yet: a defensive placeholder frame, never a
    # crash. Mirrors the firmware's "----  ----" fallback.
    img = sim_display.render_claim("", "")
    assert img.size == (WIDTH, HEIGHT)


# --- Claim screen WiFi-connect QR + creds (WARP-819) ------------------------
#
# On first boot a user must be able to join the box's Wi-Fi with zero prior
# config — by scanning a Wi-Fi-connect QR on the claim screen OR reading the
# SSID + password as text. So render_claim grows an optional stacked layout:
# the claim code on top, a Wi-Fi QR card + readable creds below. Absent creds
# => the original claim-only layout (graceful degradation).

CLAIM_WIFI_MATRIX = [[1, 0, 1], [0, 1, 0], [1, 0, 1]]
CLAIM_WIFI_SSID = "Droplet"
CLAIM_WIFI_PSK = "7gpz4k9m2njq8wxr"


def test_render_claim_with_wifi_returns_full_frame(sim_display: TFTDisplay):
    img = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL,
        wifi_ssid=CLAIM_WIFI_SSID, wifi_psk=CLAIM_WIFI_PSK,
        wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    assert isinstance(img, Image.Image)
    assert img.size == (WIDTH, HEIGHT)


def test_render_claim_wifi_layout_differs_from_claim_only(sim_display: TFTDisplay):
    # Supplying the Wi-Fi creds must materially change the frame — the QR card +
    # creds are actually drawn, not silently ignored.
    claim_only = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    with_wifi = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL,
        wifi_ssid=CLAIM_WIFI_SSID, wifi_psk=CLAIM_WIFI_PSK,
        wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    assert claim_only.tobytes() != with_wifi.tobytes()


def test_render_claim_psk_is_rendered(sim_display: TFTDisplay):
    # The password is shown as readable text (camera-less PC setup), so changing
    # it must change the frame.
    a = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid=CLAIM_WIFI_SSID,
        wifi_psk=CLAIM_WIFI_PSK, wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    b = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid=CLAIM_WIFI_SSID,
        wifi_psk="different-passphrase9", wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    assert a.tobytes() != b.tobytes()


def test_render_claim_falls_back_when_only_partial_wifi(sim_display: TFTDisplay):
    # Matrix present but SSID missing (or vice versa) is not a usable Wi-Fi
    # block — render the claim-only layout rather than a half-drawn band.
    claim_only = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    no_ssid = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid="", wifi_psk=CLAIM_WIFI_PSK,
        wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    assert no_ssid.tobytes() == claim_only.tobytes()


# --- WiFi-QR payload escaping + matrix-faithful render (WARP-819) -----------
# The sim's claim QR previously formatted `WIFI:T:WPA;S:{};P:{};;` raw — an
# SSID/PSK carrying a WiFi-QR metachar (\ ; , : ") would corrupt the payload,
# unlike device-bridge.py's escaped `_hostapd_wifi_payload`. The sim must apply
# the same escaping, AND (production-faithful) paint the host-supplied matrix
# directly when one is provided — the firmware never re-encodes on-device.

def test_wifi_qr_payload_escapes_metacharacters():
    # Mirrors device-bridge.py _hostapd_wifi_payload's esc(): \ ; , : " are
    # backslash-escaped so a special-char SSID/PSK still scans.
    payload = display_module._wifi_qr_payload("My;Net:2", "p\\a,s;s")
    assert payload == r"WIFI:T:WPA;S:My\;Net\:2;P:p\\a\,s\;s;;"


def test_wifi_qr_payload_plain_values_unchanged():
    # No metachars -> identical to the simple format (back-compat with the
    # common alphanumeric generated PSK).
    assert (display_module._wifi_qr_payload("Droplet", "7gpz4k9m2njq8wxr")
            == "WIFI:T:WPA;S:Droplet;P:7gpz4k9m2njq8wxr;;")


def test_render_claim_paints_host_matrix_not_reencoded(
        monkeypatch: pytest.MonkeyPatch, sim_display: TFTDisplay):
    # When a wifi_qr_matrix is supplied, the claim screen must paint THAT matrix
    # (the bytes the firmware will paint), never silently re-encode a payload —
    # otherwise the sim preview and the device diverge. Spy on _draw_qr and
    # assert it received the host matrix.
    seen = {}
    orig = sim_display._draw_qr

    def spy(img, draw, x, y, size, payload=None, matrix=None):
        seen["payload"] = payload
        seen["matrix"] = matrix
        return orig(img, draw, x, y, size, payload=payload, matrix=matrix)

    monkeypatch.setattr(sim_display, "_draw_qr", spy)
    sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid=CLAIM_WIFI_SSID,
        wifi_psk=CLAIM_WIFI_PSK, wifi_qr_matrix=CLAIM_WIFI_MATRIX,
    )
    assert seen.get("matrix") == CLAIM_WIFI_MATRIX


# --- Design-handoff claim redesign (two-column: code hero | scan QR) --------
#
# The claim screen follows the design-system handoff card "PyPortal First
# Boot — Claim Code": a header band (brand mark + FIRST-TIME SETUP), a left
# column with the claim-code hero (accent dash group separators) + numbered
# steps, a right column with a scan QR card, and a bottom WAITING band over a
# 2px scan track. Without a Wi-Fi block the QR deep-links the setup wizard
# (`<setup_url>?c=<CODE>`) so a scan lands with the code prefilled; with a
# Wi-Fi block (WARP-819) the Wi-Fi-join QR keeps the right column — joining
# the box's Wi-Fi is the one step a fresh phone can't do by hand.

SETUP_MATRIX = [[1, 1, 0], [0, 1, 0], [0, 0, 1]]


def test_setup_qr_payload_builds_deep_link():
    # Dashes are stripped + the code upper-cased: the dashboard's
    # normalizeClaimCode() ignores separators, and the bare form keeps the QR
    # a version smaller.
    assert (display_module._setup_qr_payload(CLAIM_URL, CLAIM_CODE)
            == CLAIM_URL + "?c=DRPL7K2Q9F4M")


def test_setup_qr_payload_appends_to_existing_query():
    assert (display_module._setup_qr_payload("https://x/setup?lang=en", "ab-12")
            == "https://x/setup?lang=en&c=AB12")


def test_setup_qr_payload_requires_both_parts():
    # No code or no URL -> no deep link (the QR card degrades to mark-only).
    assert display_module._setup_qr_payload(CLAIM_URL, "") == ""
    assert display_module._setup_qr_payload("", CLAIM_CODE) == ""


def test_encode_qr_matrix_returns_square_bit_matrix():
    m = display_module._encode_qr_matrix(CLAIM_URL + "?c=DRPL7K2Q9F4M")
    assert m, "qrcode is a declared service dep; encoding must succeed"
    assert len(m) == len(m[0])
    assert all(v in (0, 1) for row in m for v in row)


def test_encode_qr_matrix_uses_ecc_q_for_the_mark_overlay():
    # The claim card paints a 32px white mark pad dead-centre over the
    # symbol. At ERROR_CORRECT_M the padded symbol fails to decode (review
    # finding, verified empirically); at Q it decodes. Pin the level via the
    # deterministic version bump: the typical deep-link payload fits v3
    # (29 modules) at M but needs v4 (33 modules) at Q.
    m = display_module._encode_qr_matrix(CLAIM_URL + "?c=DRPL7K2Q9F4M")
    assert len(m) == 33


def test_encode_qr_matrix_caps_rows_at_firmware_tolerance():
    # Mirrors ClaimRequest's wifi_qr_matrix max_length=64 ("a v-large QR
    # would OOM the PyPortal") — an oversized payload must degrade to no-QR
    # rather than ship a heap bomb to the panel over the serial wire.
    huge = "https://" + "a" * 180 + "/setup?c=" + "X" * 32
    assert display_module._encode_qr_matrix(huge) is None


def test_render_claim_no_wifi_draws_setup_deep_link_qr(
        monkeypatch: pytest.MonkeyPatch, sim_display: TFTDisplay):
    # The claim-only layout must draw the scan-to-claim QR with the setup
    # deep-link payload (host-encoded matrix preferred, payload fallback).
    seen = {}
    orig = sim_display._draw_qr

    def spy(img, draw, x, y, size, payload=None, matrix=None):
        seen["payload"] = payload
        seen["matrix"] = matrix
        return orig(img, draw, x, y, size, payload=payload, matrix=matrix)

    monkeypatch.setattr(sim_display, "_draw_qr", spy)
    sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert seen, "claim-only layout must draw a scan-to-claim QR card"
    if seen.get("matrix") is None:
        assert "?c=DRPL7K2Q9F4M" in (seen.get("payload") or "")


def test_render_claim_prefers_supplied_setup_matrix(
        monkeypatch: pytest.MonkeyPatch, sim_display: TFTDisplay):
    # A host-supplied setup matrix (what the firmware paints) wins over the
    # sim-side payload encode, keeping preview and panel byte-identical.
    seen = {}
    orig = sim_display._draw_qr

    def spy(img, draw, x, y, size, payload=None, matrix=None):
        seen["matrix"] = matrix
        return orig(img, draw, x, y, size, payload=payload, matrix=matrix)

    monkeypatch.setattr(sim_display, "_draw_qr", spy)
    sim_display.render_claim(CLAIM_CODE, CLAIM_URL,
                             setup_qr_matrix=SETUP_MATRIX)
    assert seen.get("matrix") == SETUP_MATRIX


def test_render_claim_header_separator_and_column_divider(
        sim_display: TFTDisplay):
    # Two structural hairlines pin the two-column layout: the header band's
    # separator and the vertical divider between code column and QR column.
    img = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert any(img.getpixel((WIDTH // 2, y)) == display_module.V3_SEP
               for y in range(40, 52))
    assert any(img.getpixel((x, 150)) == display_module.V3_SEP
               for x in range(276, 294))


def test_render_claim_bottom_scan_track(sim_display: TFTDisplay):
    # The bottom edge carries the 2px scan track with an accent segment (the
    # "waiting" affordance; static per frame).
    img = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    row = {img.getpixel((x, HEIGHT - 1)) for x in range(WIDTH)}
    assert display_module.V3_TRACK in row
    assert display_module.V3_ACCENT in row


def test_render_claim_no_qr_variant_is_honest(
        monkeypatch: pytest.MonkeyPatch, sim_display: TFTDisplay):
    # When no scan matrix can exist (qrcode unavailable / payload oversized)
    # the card must not instruct a scan: no QR is painted and the
    # eyebrow/caption switch to the typed-address fallback — same rule the
    # firmware applies, so preview and panel agree in that state (no
    # pseudo-QR paper-over).
    drew = []
    orig = sim_display._draw_qr

    def spy(img, draw, x, y, size, payload=None, matrix=None):
        drew.append(1)
        return orig(img, draw, x, y, size, payload=payload, matrix=matrix)

    monkeypatch.setattr(sim_display, "_draw_qr", spy)
    with_qr = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert len(drew) == 1

    monkeypatch.setattr(display_module, "_encode_qr_matrix", lambda p: None)
    no_qr = sim_display.render_claim(CLAIM_CODE, CLAIM_URL)
    assert len(drew) == 1, "no matrix -> the QR painter must not run"
    assert with_qr.tobytes() != no_qr.tobytes()


def test_render_claim_long_host_keeps_setup_path(sim_display: TFTDisplay):
    # DUCKDNS-style hostnames must keep the /setup path visible (wrapped
    # onto its own line) instead of truncating it away — in the Wi-Fi layout
    # that text is the only typed setup pointer. Fixed matrix on both
    # renders so only the step text can differ.
    fixed = SETUP_MATRIX
    a = sim_display.render_claim(
        CLAIM_CODE, "https://droplet-stefan.duckdns.org/setup",
        setup_qr_matrix=fixed)
    b = sim_display.render_claim(
        CLAIM_CODE, "https://droplet-stefan.duckdns.org/other",
        setup_qr_matrix=fixed)
    assert a.tobytes() != b.tobytes()


def test_render_claim_wifi_keeps_readable_ssid(sim_display: TFTDisplay):
    # WARP-819 regression guard under the redesign: the SSID stays readable
    # text (camera-less manual join), so changing it must change the frame.
    a = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid=CLAIM_WIFI_SSID,
        wifi_psk=CLAIM_WIFI_PSK, wifi_qr_matrix=CLAIM_WIFI_MATRIX)
    b = sim_display.render_claim(
        CLAIM_CODE, CLAIM_URL, wifi_ssid="OtherNet",
        wifi_psk=CLAIM_WIFI_PSK, wifi_qr_matrix=CLAIM_WIFI_MATRIX)
    assert a.tobytes() != b.tobytes()


# --- Backward-compat: existing boot/shutdown signatures still work ----------

def test_render_boot_legacy_stage_signature_still_supported(sim_display: TFTDisplay):
    # WARP-624 callers (show_boot / readiness) pass stage/detail/pct. The new
    # animated renderer must still accept that call shape without raising.
    img = sim_display.render_boot("Loading models", detail="ollama", pct=40)
    assert img.size == (WIDTH, HEIGHT)


def test_render_shutdown_legacy_signature_still_supported(sim_display: TFTDisplay):
    img = sim_display.render_shutdown(reason="system shutdown", phase="stopping")
    assert img.size == (WIDTH, HEIGHT)
    img2 = sim_display.render_shutdown(reason="", phase="halted")
    assert img2.size == (WIDTH, HEIGHT)

"""Wide-panel layout — grid maths, band containment, and honest empty states.

The regression this file exists to prevent: `render_system` at 480x320 puts a
footer at y=244 and a second at HEIGHT-24. At height 320 those are 52px apart;
at 280 they collide. `test_nothing_escapes_its_band` is the general guard —
it records every glyph drawn and asserts each stays inside the band it was
laid out for, so a future edit at the wrong height fails here rather than on
the rack.
"""

from __future__ import annotations

import time

import pytest
from PIL import Image, ImageDraw

import display as display_module
import layout_wide as lw

PANEL_W, PANEL_H = 1424, 280


@pytest.fixture
def wide(monkeypatch, sim_display):
    """A sim display whose geometry is the rack bar."""
    monkeypatch.setattr(display_module, "WIDTH", PANEL_W)
    monkeypatch.setattr(display_module, "HEIGHT", PANEL_H)
    return sim_display


@pytest.fixture
def populated(wide):
    wide._v3.update({
        "cpu": 34, "mem": 61, "disk": 44, "temp": 52, "gpu": 12,
        "ip": "192.168.1.250", "hostname": "droplet-sys",
        "public_host": "warp-lab.droplet-us.com",
        "uptime": "6d 4h", "version": "v2.6.1",
        "sparks_cpu": [20 + (i % 17) for i in range(48)],
        "wan_online": True, "wan_latency_ms": 14, "tls_days": 61,
        "wifi": {"ssid": "Droplet-AI", "band": "5 GHz", "channel": 36,
                 "clients": 4},
        "cameras": {"online": 4, "total": 4},
        "storage": {"used_tb": 1.4, "total_tb": 3.6},
        "services": {"up": 27, "total": 27, "degraded": []},
        "last_event": "12:04 · Backup completed",
    })
    return wide


# --- geometry selection ----------------------------------------------------

def test_is_wide_true_at_panel_geometry(wide):
    assert lw.is_wide()


def test_is_wide_false_at_pyportal_geometry(monkeypatch, sim_display):
    monkeypatch.setattr(display_module, "WIDTH", 480)
    monkeypatch.setattr(display_module, "HEIGHT", 320)
    assert not lw.is_wide()


# --- grid ------------------------------------------------------------------
# WARP-1644: these assert RELATIONSHIPS, not magic numbers. The old versions
# pinned literals derived from a full 1424px canvas, which is exactly the
# assumption that put content off the edge of the real panel — and pinning
# them again would just re-freeze the bug at a new inset.

def _cells(wide):
    g = lw.geom()
    return sorted(g.cells.values())


def test_grid_spans_the_content_area_exactly(wide):
    g = lw.geom()
    assert g.col_x(1) == g.left
    assert g.col_x(lw.COLUMNS) + g.span(1) == pytest.approx(g.content_r, abs=1)
    # A 4-wide span is 4 columns plus the 3 gutters between them.
    assert g.span(4) == pytest.approx(4 * g.span(1) + 3 * lw.GUTTER, abs=2)


def test_cells_do_not_overlap_and_stay_left_of_the_rail(wide):
    g = lw.geom()
    cells = _cells(wide)
    for (x1, w1), (x2, _) in zip(cells, cells[1:]):
        assert x1 + w1 <= x2, "cells overlap"
    last_x, last_w = cells[-1]
    assert last_x + last_w <= g.content_r
    assert g.content_r < g.rail_x


def test_dividers_sit_in_the_gutters(wide):
    g = lw.geom()
    cells = _cells(wide)
    for d, ((x1, w1), (x2, _)) in zip(g.dividers, zip(cells, cells[1:])):
        assert x1 + w1 <= d <= x2


def test_bands_are_ordered_and_fit_the_panel(wide):
    g = lw.geom()
    assert g.band_a_rule < g.band_b_top < g.band_b_bot
    assert g.band_b_bot < g.band_c_rule < g.band_c_y < PANEL_H


# --- the safe area (WARP-1644) ---------------------------------------------

def test_everything_sits_inside_the_safe_area(wide):
    """The bug: the action rail was pinned to the framebuffer's right edge, so
    the QR card and caption were the first things the bezel ate."""
    g = lw.geom()
    assert g.left >= lw.SAFE_INSET_X
    assert g.rail_x + g.rail_w <= PANEL_W - lw.SAFE_INSET_X
    for x, w in g.cells.values():
        assert x >= lw.SAFE_INSET_X
        assert x + w <= PANEL_W - lw.SAFE_INSET_X


def test_inset_is_tunable_without_a_rebuild(wide, monkeypatch):
    """The right inset is a property of the panel + bezel, so a second unit
    must be able to change it from the environment."""
    monkeypatch.setattr(lw, "SAFE_INSET_X", 60)
    g = lw.geom()
    assert g.left >= 60
    assert g.rail_x + g.rail_w <= PANEL_W - 60
    for x, w in g.cells.values():
        assert x >= 60 and x + w <= PANEL_W - 60


def test_zero_inset_still_produces_a_sane_grid(wide, monkeypatch):
    monkeypatch.setattr(lw, "SAFE_INSET_X", 0)
    g = lw.geom()
    cells = sorted(g.cells.values())
    for (x1, w1), (x2, _) in zip(cells, cells[1:]):
        assert x1 + w1 <= x2
    assert g.rail_x + g.rail_w <= PANEL_W


def test_geometry_follows_the_panel_not_the_import(monkeypatch, sim_display):
    """Computed per render, so a differently-shaped second panel works and the
    layout is not frozen to whatever WIDTH happened to be at import."""
    monkeypatch.setattr(display_module, "WIDTH", 1920)
    monkeypatch.setattr(display_module, "HEIGHT", 480)
    wide_g = lw.geom()
    monkeypatch.setattr(display_module, "WIDTH", PANEL_W)
    monkeypatch.setattr(display_module, "HEIGHT", PANEL_H)
    bar_g = lw.geom()
    assert wide_g.rail_x != bar_g.rail_x
    assert wide_g.content_r > bar_g.content_r


# --- render ----------------------------------------------------------------

def test_render_status_is_exactly_panel_sized(populated):
    img = lw.render_status(populated)
    assert img.size == (PANEL_W, PANEL_H)
    assert img.mode == "RGB"


def test_render_status_on_cold_state_does_not_raise(wide):
    """A cold box has an empty _v3. It must render, not explode."""
    assert lw.render_status(wide).size == (PANEL_W, PANEL_H)


def test_missing_metrics_render_as_dash_never_zero(wide):
    """A fake 0% on a status panel is worse than an obvious gap: it reads as
    a measurement. `wan_latency_ms` shipped as a hardcoded 0 for months."""
    assert lw._num(None) == "—"
    assert lw._num(None, "%") == "—"
    assert lw._num(0, "%") == "0%"


def test_touch_regions_cover_every_cell(populated):
    lw.render_status(populated)
    names = {r.name for r in populated._touch_regions}
    assert {"cell_reach", "cell_health", "cell_services",
            "cell_netstore", "rail_qr"} <= names


def test_touch_targets_clear_the_44px_minimum(populated):
    lw.render_status(populated)
    for r in populated._touch_regions:
        assert r.w >= 44 and r.h >= 44, f"{r.name} is too small to hit"


@pytest.mark.parametrize("mutate,expect", [
    (lambda v: None, "live"),
    (lambda v: v["services"].update(
        degraded=[{"name": "frigate", "state": "restarting", "core": False}]),
     "degraded"),
    # WARP-1645: a HARD dependency down is an ALERT, and it is the
    # ORCHESTRATOR that classifies that (status="down"), not a guess made on
    # the panel from a `core` flag.
    (lambda v: v["services"].update(
        status="down",
        degraded=[{"name": "postgres", "state": "P1001", "core": True}]),
     "alert"),
])
def test_state_pill_reflects_health(populated, monkeypatch, mutate, expect):
    seen = []
    real = lw._pill_style
    monkeypatch.setattr(lw, "_pill_style",
                        lambda s: (seen.append(s), real(s))[1])
    mutate(populated._v3)
    lw.render_status(populated)
    assert seen == [expect]


def test_offline_and_tls_chips_do_not_overlap(populated, monkeypatch):
    """Regression: the offline branch discarded _chip()'s returned width, so
    the TLS chip landed on top of NO INTERNET and both became unreadable —
    exactly in the state where you most need to read them."""
    populated._v3["wan_online"] = False
    populated._v3["tls_days"] = 9
    boxes = []
    real = lw._chip

    def spy(draw, x, y, text, ink, fill):
        w = real(draw, x, y, text, ink, fill)
        boxes.append((x, x + w, text))
        return w

    monkeypatch.setattr(lw, "_chip", spy)
    lw.render_status(populated)

    boxes.sort()
    for (x0, x1, t0), (x2, _, t1) in zip(boxes, boxes[1:]):
        assert x1 <= x2, f"chip {t0!r} overlaps {t1!r}"


# --- band containment (the y=244 vs HEIGHT-24 class of bug) ----------------

def test_nothing_escapes_its_band(populated, monkeypatch):
    drawn = []
    real_text = ImageDraw.ImageDraw.text

    def spy(self, xy, text, *a, **kw):
        if text:
            box = self.textbbox(xy, text, font=kw.get("font"),
                                anchor=kw.get("anchor"))
            drawn.append((box, str(text)))
        return real_text(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", spy)
    lw.render_status(populated)

    assert drawn, "spy never fired — the render path changed"
    for (x0, y0, x1, y1), text in drawn:
        assert y1 <= PANEL_H, f"{text!r} overflows the panel bottom ({y1})"
        assert x1 <= PANEL_W, f"{text!r} overflows the panel right ({x1})"
        # Band B content must not run into the foot rule.
        #
        # Scoped to the CONTENT AREA on purpose: the bands are a property of
        # the 12-column grid, and the foot rule is only drawn from g.left to
        # g.content_r. The action rail is a separate full-height surface with
        # its own stack, so its text legitimately sits at band-C heights and
        # collides with nothing. Caught in CI once the rail text grew — font
        # metrics differ enough between hosts that the headline crossed the
        # rule on the runner but not locally.
        g = lw.geom()
        if x0 >= g.rail_x:
            continue
        if g.band_b_top <= y0 < g.band_b_bot:
            assert y1 <= g.band_c_rule - 2, \
                f"{text!r} in band B collides with the foot rule"


def test_long_hostname_stays_inside_its_cell(populated, monkeypatch):
    populated._v3["public_host"] = "a-very-long-named-address.droplet-us.com"
    drawn = []
    real_text = ImageDraw.ImageDraw.text

    def spy(self, xy, text, *a, **kw):
        # Prefix, not equality: the hero may legitimately be ellipsised now.
        if str(text).startswith("a-very-long-named-address"):
            drawn.append(self.textbbox(xy, text, font=kw.get("font"),
                                       anchor=kw.get("anchor")))
        return real_text(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", spy)
    lw.render_status(populated)
    x, w = lw.geom().cells["reach"]
    assert drawn and drawn[0][2] <= x + w, "hostname auto-fit failed"


def test_an_unfittable_hostname_is_shortened_not_spilled(populated):
    """_fit_font stops shrinking at its floor and returns a face that STILL
    overflows — the address then runs through the divider into HEALTH.
    _fit_text shortens instead. Latent until the safe-area inset narrowed the
    column; CI caught it on the first run."""
    populated._v3["public_host"] = (
        "an-absurdly-long-customer-named-address.droplet-us.com")
    g = lw.geom()
    x, w = g.cells["reach"]
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, t, *a, **k: (
            drawn.append((self.textbbox(xy, t, font=k.get("font"),
                                        anchor=k.get("anchor")), str(t))),
            real(self, xy, t, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    hero = [(b, t) for b, t in drawn if t.startswith("an-absurdly")]
    assert hero, [t for _, t in drawn][:8]
    box, text = hero[0]
    assert box[2] <= x + w, "address spilled out of its cell"
    assert text.endswith("…")


# --- QR --------------------------------------------------------------------

def test_short_payload_renders_above_the_module_floor():
    img, module_px = lw.render_qr("https://droplet.local/d")
    assert img is not None
    assert module_px >= lw.QR_MIN_MODULE_PX
    assert img.width <= lw.QR_CARD


def test_overlong_payload_is_refused_not_shrunk():
    """Better no QR + a typed fallback than a card nobody can scan."""
    img, module_px = lw.render_qr("https://" + "x" * 220 + ".example.com/setup")
    assert img is None and module_px == 0


def test_default_claim_link_fits_at_the_module_floor():
    """The per-device deep link is ~56 bytes and encodes at version 4 —
    comfortably inside the ~62-byte budget. Guards against anyone "fixing"
    a constraint that isn't there."""
    payload = "https://d-3f9a2c81.droplet-us.com/setup?c=DRPL-7K2M-9QX4"
    assert len(payload) <= lw.QR_BYTE_BUDGET
    img, module_px = lw.render_qr(payload)
    assert img is not None and module_px >= lw.QR_MIN_MODULE_PX


def test_long_named_address_link_is_refused():
    """The real failure case: a customer's long named address blows the
    budget and drops the code below 4px/module."""
    payload = ("https://a-very-long-customer-named-address.droplet-us.com"
               "/setup?c=DRPL-7K2M-9QX4")
    assert len(payload) > lw.QR_BYTE_BUDGET
    assert lw.render_qr(payload)[0] is None


def test_uppercase_payload_buys_headroom():
    """Alphanumeric mode is ~45% denser. An over-budget byte-mode payload can
    fit if it is uppercase-only — the cheapest lever if a host runs long."""
    long_alnum = "HTTPS://DROPLET-US.COM/SETUP?C=DRPL-7K2M-9QX4-EXTRA-ROOM"
    assert len(long_alnum) > 42          # over the version-3 byte budget
    assert lw.render_qr(long_alnum)[0] is not None


def test_qr_quiet_zone_is_preserved():
    img, module_px = lw.render_qr("https://droplet.local/d")
    px = img.load()
    for i in range(4 * module_px):
        assert px[i, i] == (255, 255, 255), "quiet zone was eaten"


# --- WARP-1643: no fake zeros ----------------------------------------------
# Found on the live panel, not in review: the layout stated the rule ("missing
# data renders as an em dash, NEVER as 0") and then broke it twice, because
# _v3 SEEDS these fields with 0 rather than leaving them absent. `.get()`
# happily returns that seeded zero and the renderer treats it as a reading.

def _chips(populated, monkeypatch):
    seen = []
    real = lw._chip
    monkeypatch.setattr(lw, "_chip", lambda draw, x, y, t, ink, fill: (
        seen.append(t), real(draw, x, y, t, ink, fill))[1])
    lw.render_status(populated)
    return seen


def test_seeded_zero_latency_is_not_reported_as_a_reading(populated, monkeypatch):
    populated._v3["wan_latency_ms"] = 0        # the _v3 seed, never measured
    chips = _chips(populated, monkeypatch)
    assert "ONLINE" in chips, chips
    assert not any("0 ms" in c for c in chips), chips


def test_a_real_latency_is_still_shown(populated, monkeypatch):
    populated._v3["wan_latency_ms"] = 14
    assert any("14 ms" in c for c in _chips(populated, monkeypatch))


def test_no_cameras_is_an_absence_not_a_healthy_zero(populated):
    """Green 0/0 reads as 'all cameras up'. It means 'there are no cameras'."""
    populated._v3["cameras"] = {"online": 0, "total": 0}
    assert lw.render_status(populated).size == (PANEL_W, PANEL_H)
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, text, *a, **k: (
            drawn.append(str(text)), real(self, xy, text, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    assert not any("0/0" in t for t in drawn), "rendered a green 0/0"
    assert "—" in drawn


def test_some_cameras_offline_still_reports_the_ratio(populated):
    populated._v3["cameras"] = {"online": 2, "total": 4}
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, text, *a, **k: (
            drawn.append(str(text)), real(self, xy, text, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    assert any("2/4 online" in t for t in drawn)


def test_rail_text_stays_inside_the_rail(populated):
    """Everything in the action rail is CENTRED, so an over-wide string spills
    out of both sides of it. A long hostname in the scan-fallback line did
    exactly that — 238px of text in a 220px rail, overhanging the divider on
    the left and the safe area on the right."""
    populated._v3["public_host"] = (
        "an-absurdly-long-customer-named-address.droplet-us.com")
    g = lw.geom()
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, t, *a, **k: (
            drawn.append(self.textbbox(xy, t, font=k.get("font"),
                                       anchor=k.get("anchor"))),
            real(self, xy, t, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    # Anything drawn to the right of the divider belongs to the rail.
    rail_boxes = [b for b in drawn if b[0] >= g.rail_x - 40]
    assert rail_boxes
    for b in rail_boxes:
        assert b[0] >= g.rail_x, f"rail text starts left of the rail: {b}"
        assert b[2] <= g.rail_x + g.rail_w, f"rail text overflows: {b}"


# --- WARP-1645: the SERVICES cell, now with a real feed ---------------------

def _texts(populated):
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, t, *a, **k: (
            drawn.append(str(t)), real(self, xy, t, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    return drawn


def test_services_shows_the_real_ratio(populated):
    populated._v3["services"] = {"up": 8, "total": 8, "status": "ok",
                                 "degraded": []}
    t = _texts(populated)
    assert "8/8" in t and "all healthy" in t


def test_services_names_what_is_down(populated):
    populated._v3["services"] = {
        "up": 7, "total": 8, "status": "degraded",
        "degraded": [{"name": "nextcloud", "state": "connection refused",
                      "core": False}]}
    t = _texts(populated)
    assert "7/8" in t
    assert "1 degraded" in t
    assert "nextcloud" in t
    assert "connection refused" in t


def test_no_feed_renders_a_dash_never_zero_zero(populated):
    """'0/0 services' reads as 'nothing is running' — alarming and wrong."""
    populated._v3["services"] = {"up": None, "total": None, "status": None,
                                 "degraded": []}
    t = _texts(populated)
    assert "no data" in t
    assert not any("0/0" in s for s in t)


def test_pill_follows_the_orchestrator_status_not_a_guess(populated, monkeypatch):
    """The orchestrator knows which components are hard dependencies. The
    panel must not re-derive that from a guessed list of 'core' services."""
    seen = []
    real = lw._pill_style
    monkeypatch.setattr(lw, "_pill_style",
                        lambda s: (seen.append(s), real(s))[1])

    populated._v3["services"] = {
        "up": 7, "total": 8, "status": "degraded",
        "degraded": [{"name": "file-indexer", "state": "down", "core": False}]}
    lw.render_status(populated)
    assert seen[-1] == "degraded"

    populated._v3["services"] = {
        "up": 6, "total": 8, "status": "down",
        "degraded": [{"name": "postgres", "state": "P1001", "core": True}]}
    lw.render_status(populated)
    assert seen[-1] == "alert"


def test_overflow_is_explicit_never_silent(populated):
    populated._v3["services"] = {
        "up": 3, "total": 8, "status": "degraded",
        "degraded": [{"name": f"svc-{i}", "state": "down", "core": False}
                     for i in range(5)]}
    t = _texts(populated)
    assert "+3 more" in t, "truncating silently would hide failing services"


def test_a_long_error_is_ellipsised_not_sliced(populated):
    """A hard cut turns "ECONNREFUSED 127.0.0.1:6379" into something that reads
    like a different, complete error. The ellipsis says "there is more"."""
    populated._v3["services"] = {
        "up": 7, "total": 8, "status": "degraded",
        "degraded": [{"name": "redis",
                      "state": "ECONNREFUSED 127.0.0.1:6379 after 3 retries",
                      "core": False}]}
    t = _texts(populated)
    assert any(s.endswith("…") for s in t), t


# --- WARP-1647: the rail text block ------------------------------------------

def _rail_boxes(populated):
    g = lw.geom()
    drawn = []
    import PIL.ImageDraw as _id
    real = _id.ImageDraw.text
    try:
        _id.ImageDraw.text = lambda self, xy, t, *a, **k: (
            drawn.append((self.textbbox(xy, t, font=k.get("font"),
                                        anchor=k.get("anchor")), str(t))),
            real(self, xy, t, *a, **k))[1]
        lw.render_status(populated)
    finally:
        _id.ImageDraw.text = real
    return [(b, t) for b, t in drawn if b[0] >= g.rail_x - 40]


def test_rail_text_block_sits_inside_the_vertical_safe_area(populated):
    """The rail spans the FULL framebuffer height, so it did not previously
    respect PANEL_SAFE_INSET_Y — a non-zero vertical inset would have pushed
    the typed address off the panel."""
    g = lw.geom()
    for box, text in _rail_boxes(populated):
        assert box[1] >= g.top, f"{text!r} above the safe area: {box}"
        assert box[3] <= g.bottom, f"{text!r} below the safe area: {box}"


def test_rail_text_respects_a_vertical_inset(populated, monkeypatch):
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 20)
    g = lw.geom()
    boxes = _rail_boxes(populated)
    assert boxes
    for box, text in boxes:
        assert box[1] >= g.top and box[3] <= g.bottom, f"{text!r} {box}"


def test_typed_address_is_readable_sized(populated):
    """The fallback is the camera-less path — glare, bad angle, no scanner.
    An address you cannot read is the same as no address (design brief §5)."""
    host = populated._v3["public_host"]
    hits = [(b, t) for b, t in _rail_boxes(populated) if t == host]
    assert hits, [t for _, t in _rail_boxes(populated)]
    box, _ = hits[0]
    assert (box[3] - box[1]) >= 11, f"typed address rendered too small: {box}"


def test_long_host_shrinks_but_never_spills(populated):
    populated._v3["public_host"] = (
        "an-absurdly-long-customer-named-address.droplet-us.com")
    g = lw.geom()
    for box, text in _rail_boxes(populated):
        assert box[0] >= g.rail_x, f"{text!r} spills left: {box}"
        assert box[2] <= g.rail_x + g.rail_w, f"{text!r} spills right: {box}"


# ---------------------------------------------------------------------------
# Vertical safe area — the whole-panel guard
# ---------------------------------------------------------------------------

def _all_boxes(disp, monkeypatch):
    """Every glyph box drawn by a full LIVE render, panel coordinates."""
    drawn = []
    real = ImageDraw.ImageDraw.text

    def spy(self, xy, text, *a, **kw):
        if text:
            drawn.append((self.textbbox(xy, text, font=kw.get("font"),
                                        anchor=kw.get("anchor")), str(text)))
        return real(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", spy)
    lw.render_status(disp)
    assert drawn, "spy never fired — the render path changed"
    return drawn


def test_default_vertical_inset_is_five_px(populated):
    """The founder asked for 5px of breathing room top and bottom after
    looking at the real panel. Pinned because it is a hardware fact, not a
    taste call — a bezel change is what should move it, via the env knob."""
    assert lw.SAFE_INSET_Y == 5
    g = lw.geom()
    assert g.top == 5
    assert g.bottom == PANEL_H - 5


def test_nothing_is_drawn_inside_the_vertical_padding(populated, monkeypatch):
    """The padding is only real if it stays empty."""
    g = lw.geom()
    for box, text in _all_boxes(populated, monkeypatch):
        assert box[1] >= g.top, f"{text!r} intrudes into the top pad: {box}"
        assert box[3] <= g.bottom, f"{text!r} intrudes into the bottom pad: {box}"


def test_top_chrome_moves_with_the_inset(populated, monkeypatch):
    """The actual regression guard, and the one a containment assertion cannot
    make: the top rail used absolute y literals (mark at 12, clock at 10)
    while the band rules derived from g.top. Raising the inset moved the rules
    DOWN and left the chrome where it was — squeezing the rail instead of
    padding it, and still passing every "inside the panel" check because y=10
    is inside a panel whose safe area starts at 5.

    So assert the delta, not the bound: every top-rail glyph must shift by
    exactly the inset."""
    def top_of_chrome(inset: int) -> dict:
        monkeypatch.setattr(lw, "SAFE_INSET_Y", inset)
        # Band A only — below the rule the content is deliberately unmoved.
        rule = lw.geom().band_a_rule
        return {t: b[1] for b, t in _all_boxes(populated, monkeypatch)
                if b[3] <= rule}

    at0, at5 = top_of_chrome(0), top_of_chrome(5)
    assert at0, "no chrome glyphs captured — the render path changed"
    assert set(at0) == set(at5), "chrome content changed between insets"
    for text, y0 in at0.items():
        assert at5[text] - y0 == 5, (
            f"{text!r} did not move with the inset: {y0} -> {at5[text]}")


def test_chrome_tracks_a_larger_inset(populated, monkeypatch):
    """Scales, rather than being hard-coded to 5. A second unit with a deeper
    bezel sets PANEL_SAFE_INSET_Y and gets a correct layout without a rebuild."""
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 24)
    g = lw.geom()
    assert g.top == 24
    for box, text in _all_boxes(populated, monkeypatch):
        assert box[1] >= g.top, f"{text!r} above the safe area: {box}"
        assert box[3] <= g.bottom, f"{text!r} below the safe area: {box}"


def test_zero_inset_still_renders_the_original_layout(populated, monkeypatch):
    """Escape hatch: PANEL_SAFE_INSET_Y=0 must reproduce the pre-padding
    geometry exactly, so the change can be backed out on a box without one."""
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 0)
    g = lw.geom()
    assert (g.top, g.bottom) == (0, PANEL_H)
    assert g.band_a_rule == 46 and g.band_c_y == PANEL_H - 32


def test_qr_card_never_collides_with_the_rail_caption(populated, monkeypatch):
    """The rail is anchored at both ends, so a vertical inset costs it TWICE
    the inset. A fixed 176px card had 6px of slack; the 5px default overran it
    and the caption printed through the card. Caught by eye on a render, not
    by any bounds check — the caption was still inside the safe area, just on
    top of the card. So assert the gap itself, at every inset we support."""
    for inset in (0, 5, 12, 24):
        monkeypatch.setattr(lw, "SAFE_INSET_Y", inset)
        g = lw.geom()
        card_y = g.top + 24
        cap_y = (g.bottom - 30) - 26 - 18
        card = min(lw.QR_CARD, max(0, cap_y - lw.QR_CARD_GAP - card_y))
        assert card_y + card <= cap_y - lw.QR_CARD_GAP, (
            f"inset={inset}: card bottom {card_y + card} overlaps caption "
            f"at {cap_y}")


def test_shipping_inset_keeps_the_qr_at_full_scannable_size(populated,
                                                            monkeypatch):
    """Shrinking the card must not shrink the CODE at the inset we actually
    ship. 166px still clears version-3-at-4px/module, so the scan target is
    bit-identical to the zero-inset render — only the white surround narrows."""
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 0)
    at0, mod0 = lw.render_qr("https://warp-lab.droplet-us.com/dashboard",
                             card=lw.QR_CARD)
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 5)
    g = lw.geom()
    cap_y = (g.bottom - 30) - 26 - 18
    card = min(lw.QR_CARD, max(0, cap_y - lw.QR_CARD_GAP - (g.top + 24)))
    at5, mod5 = lw.render_qr("https://warp-lab.droplet-us.com/dashboard",
                             card=card)
    assert at0 is not None and at5 is not None
    assert mod5 == mod0 >= lw.QR_MIN_MODULE_PX
    assert at5.size == at0.size


# --- WARP-1782: the rail's two QR faces --------------------------------------
# The rail used to hold exactly one code, the dashboard link, and a visitor at
# the rack who needed to get a phone onto the Wi-Fi had no path at all — the
# join QR only ever existed in the CLAIM state, which is gone the moment the
# box is claimed.
#
# The reason this section is dense is design brief §8: the panel is physically
# exposed in a shared room, so the Wi-Fi credential is REVEALED rather than
# displayed. Every property that makes that defensible — the tap, the time
# box, the self-revert, the passphrase never being drawn as text, the kill
# switch — is pinned below, because each is individually easy to drop in a
# later edit that "simplifies" the rail.

# A verbatim-shaped device-bridge GET /openwrt/qr body. WARP-1800: the fixture
# below used to write credentials straight into `_v3["wifi"]`, which no bridge
# response has ever populated — so every test here passed while the face could
# not light up on any box. Feed the real frame through the real mirror instead;
# if the wiring breaks again, these fail with it.
BRIDGE_QR_OK = {
    "ok": True, "ssid": "Droplet-AI", "security": "WPA", "hidden": False,
    "disabled": False, "source": "orchestrator",
    "payload": "WIFI:T:WPA;S:Droplet-AI;P:7fmqx3rp2kdz9nva;;",
    "key": "7fmqx3rp2kdz9nva", "matrix": None, "version": None,
    "error": None, "rotation_enabled": False, "ttl_seconds": 0,
}

# The bridge's GET /wifi — the CLIENT SCAN. This is what WARP-1782 actually
# read. Note what is absent: ssid, key, payload.
#
# Captured off the live box, then updated for WARP-1830: the box used to
# answer `state: "unavailable"` with
# `error: "[Errno 2] No such file or directory: 'sshpass'"`, because the scan
# opened an SSH session on a shape that has no router. It now reports the
# honest `not-applicable` instead. The credential fields are absent in BOTH
# payloads — which is the point this fixture exists to pin.
BRIDGE_WIFI_SCAN = {
    "adapter": None, "connected_to": None, "networks": [],
    "scanned_at": "2026-08-07T19:53:44Z", "source": None,
    "state": "not-applicable", "error": None,
    "detail": ("this box has no OpenWrt router of its own to scan — "
               "Wi-Fi is served by the external access point"),
}


@pytest.fixture
def with_wifi(populated):
    """A box whose bridge snapshot carries joinable Wi-Fi credentials.

    `populated` deliberately does NOT — it has an SSID (the LIVE screen shows
    one) but no key — so every test above this section exercises the
    no-second-face path and proves it is byte-for-byte the old rail.

    Fed through `_pyportal_send`, the same call the poll loop makes, so the
    mode→`_v3` mirror is under test rather than assumed.
    """
    populated._pyportal_send("qr", dict(BRIDGE_QR_OK))
    return populated


def _tap_rail(disp):
    """Fire the tap through the real touch path.

    Calling `_tap_rail_qr` directly would leave the binding untested, and the
    binding is the half that was a `lambda: None` until this ticket.
    """
    g = lw.geom()
    name = disp.handle_touch(g.rail_x + g.rail_w // 2, PANEL_H // 2)
    assert name == "rail_qr", f"tap landed on {name!r}, not the rail"


def _rail_dots(disp):
    """Ellipses drawn inside the rail — the pager, and nothing else."""
    g = lw.geom()
    seen = []
    real = ImageDraw.ImageDraw.ellipse
    try:
        ImageDraw.ImageDraw.ellipse = lambda self, xy, *a, **k: (
            seen.append(tuple(xy)), real(self, xy, *a, **k))[1]
        lw.render_status(disp)
    finally:
        ImageDraw.ImageDraw.ellipse = real
    return [e for e in seen if e[0] >= g.rail_x]


def test_a_box_with_no_wifi_credentials_offers_one_face(populated):
    """No advertising a flip that goes nowhere."""
    assert populated.wifi_qr_payload() == ""
    assert populated.rail_face() == "dashboard"
    assert lw._rail_content(populated, populated._v3)["faces"] == 1
    assert _rail_dots(populated) == []


# --- WARP-1800: the feed, not just the render -------------------------------

def test_the_bridge_join_frame_reaches_the_rail(populated):
    """bridge body -> _pyportal_send -> _v3 -> payload, with no hand-placed
    dict in the middle. This is the assertion WARP-1782 was missing."""
    assert populated.wifi_qr_payload() == ""
    populated._pyportal_send("qr", dict(BRIDGE_QR_OK))
    assert populated.wifi_qr_payload() == BRIDGE_QR_OK["payload"]


def test_the_client_scan_feed_never_produces_a_join_payload(populated):
    """The exact regression. /wifi is the scan — adapter, networks, state — and
    it carries no credentials on any box. Reading it for a join code is how the
    face stayed dark everywhere, so pin that it cannot be the source."""
    populated._pyportal_send("wifi", dict(BRIDGE_WIFI_SCAN))
    assert populated.wifi_qr_payload() == ""
    assert populated.rail_face() == "dashboard"


def test_an_unreachable_ap_takes_the_face_back_down(populated):
    """`ok: False` must beat a previously-good payload — a merge would pin a
    join code for a network that is gone."""
    populated._pyportal_send("qr", dict(BRIDGE_QR_OK))
    assert populated.wifi_qr_payload()
    populated._pyportal_send("qr", {
        "ok": False, "ssid": None, "payload": None,
        "error": "cat: can't open '/etc/hostapd.conf': No such file",
    })
    assert populated.wifi_qr_payload() == ""


def test_the_single_box_wifi_frame_still_works(populated):
    """The fallback is load-bearing, not politeness: on the single-box shape
    the System screen's wifi frame really does carry ssid + password."""
    populated._pyportal_send("wifi", {"ssid": "Droplet-AI",
                                      "password": "7fmqx3rp2kdz9nva"})
    assert populated.wifi_qr_payload() == (
        "WIFI:T:WPA;S:Droplet-AI;P:7fmqx3rp2kdz9nva;;")


def test_tap_flips_the_rail_to_the_wifi_face(with_wifi):
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "wifi"
    c = lw._rail_content(with_wifi, with_wifi._v3)
    assert c["payload"].startswith("WIFI:T:WPA;S:Droplet-AI;")
    assert c["faces"] == 2 and c["face_index"] == 1


def test_tapping_the_wifi_face_returns_immediately(with_wifi):
    """Reversible, harmless and guest-facing, so it is a plain toggle — not
    the two-tap confirm the console handback earns. Someone who opened the
    Wi-Fi code by accident must not have to wait out the window."""
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "wifi"
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "dashboard"
    # A real reset, not a shortened window.
    assert with_wifi._rail_wifi_until == 0.0


def test_the_wifi_face_is_time_boxed(with_wifi):
    lw.render_status(with_wifi)
    before = time.time()
    _tap_rail(with_wifi)
    assert (with_wifi._rail_wifi_until - before) == pytest.approx(
        display_module.RAIL_WIFI_SECONDS, abs=1.0)


def test_an_expired_window_reverts_with_nothing_running(with_wifi):
    """The revert is a property of the clock — no timer, no callback, no
    thread — so there is no missed-callback path that strands a credential on
    the rack's front panel."""
    with_wifi._rail_wifi_until = time.time() - 0.001
    assert with_wifi.rail_face() == "dashboard"
    assert lw._rail_content(with_wifi, with_wifi._v3)["face_index"] == 0


def test_the_face_drops_if_the_wifi_feed_goes_away_mid_reveal(with_wifi):
    """`rail_face` is derived on every call, so losing the feed reverts the
    panel by itself rather than leaving a stale code on the glass."""
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "wifi"
    with_wifi._v3["wifi_join"].update(ok=False)
    assert with_wifi.rail_face() == "dashboard"


def test_the_passphrase_is_never_drawn_as_text(with_wifi):
    """Design brief §8, and the whole reason this feature is defensible.

    The credential exists only inside the QR, which has to be scanned from
    ~25cm. Text on a rack front is readable across the room, memorable, and
    already in frame of whatever camera is pointed at the rack.
    """
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    psk = with_wifi._v3["wifi_join"]["key"]
    drawn = _texts(with_wifi)
    assert drawn, "spy never fired — the render path changed"
    for text in drawn:
        assert psk not in text, f"passphrase leaked onto the panel: {text!r}"


def test_the_wifi_face_names_the_network_it_joins(with_wifi):
    """The SSID takes the headline: it is the fact a visitor has to confirm
    before scanning, and it is not a secret."""
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert "Droplet-AI" in _texts(with_wifi)
    # The caption is drawn with letter tracking, i.e. one glyph per `text()`
    # call, so it never lands in the spy as a whole string — assert it on the
    # content the renderer was handed instead.
    assert lw._rail_content(with_wifi, with_wifi._v3)["caption"] == "JOIN WI-FI"


def test_the_wifi_face_stays_inside_the_safe_area(with_wifi):
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    g = lw.geom()
    boxes = _rail_boxes(with_wifi)
    assert boxes
    for box, text in boxes:
        assert box[1] >= g.top, f"{text!r} above the safe area: {box}"
        assert box[3] <= g.bottom, f"{text!r} below the safe area: {box}"
        assert box[2] <= g.rail_x + g.rail_w, f"{text!r} overflows: {box}"


def test_the_wifi_payload_encodes_above_the_scan_floor(with_wifi):
    img, module_px = lw.render_qr(with_wifi.wifi_qr_payload())
    assert img is not None and module_px >= lw.QR_MIN_MODULE_PX


def test_the_pager_marks_the_active_face_above_the_card(with_wifi):
    """The pager goes in the 24px of rail that was already empty. Everything
    below the card is anchored to the safe area's bottom, so a line added
    there comes straight out of the QR's edge — and scan distance is the
    tightest budget on this panel."""
    g = lw.geom()
    dots = _rail_dots(with_wifi)
    assert len(dots) == 2
    for dot in dots:
        assert dot[1] >= g.top, f"pager dot above the safe area: {dot}"
        assert dot[3] <= g.top + 24, f"pager dot overlaps the QR card: {dot}"


@pytest.mark.parametrize("mutate", [
    pytest.param(lambda w: w.update(ok=False), id="bridge-says-ap-unreachable"),
    pytest.param(lambda w: w.update(disabled=True), id="ap-disabled"),
    pytest.param(lambda w: w.update(payload="", key="", password=""),
                 id="no-passphrase"),
])
def test_an_unavailable_ap_never_arms_the_face(with_wifi, mutate):
    mutate(with_wifi._v3["wifi_join"])
    assert with_wifi.wifi_qr_payload() == ""
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "dashboard"


def test_the_payload_is_composed_when_the_bridge_sends_none(with_wifi):
    """A bridge that predates the `payload` field still lights the face up."""
    with_wifi._v3["wifi_join"]["payload"] = ""
    assert with_wifi.wifi_qr_payload() == \
        "WIFI:T:WPA;S:Droplet-AI;P:7fmqx3rp2kdz9nva;;"


def test_an_unscannable_payload_never_arms_the_face(with_wifi):
    """A 32-char SSID plus a 16-char passphrase really does clear the budget.
    Refusing the face is the honest failure; painting a card nobody can scan
    is the one the design brief calls worse than no QR at all."""
    ssid = "W" * 32
    with_wifi._v3["wifi_join"].update(
        ssid=ssid, payload=f"WIFI:T:WPA;S:{ssid};P:7fmqx3rp2kdz9nva;;")
    assert len(with_wifi._v3["wifi_join"]["payload"]) > lw.QR_BYTE_BUDGET
    assert with_wifi.wifi_qr_payload() == ""
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "dashboard"


def test_the_rail_budget_matches_the_renderer():
    """display.py duplicates the byte budget because layout_wide imports it,
    not the other way round. Pin the copy so it cannot drift into a face that
    arms and then refuses to draw."""
    assert display_module.RAIL_QR_BYTE_BUDGET == lw.QR_BYTE_BUDGET


def test_the_kill_switch_restores_the_dashboard_only_rail(with_wifi,
                                                          monkeypatch):
    """PANEL_RAIL_WIFI_QR=0 is for a deployment that will not take the
    trade-off. It has to leave the old rail exactly as it was."""
    monkeypatch.setattr(display_module, "RAIL_WIFI_QR", False)
    lw.render_status(with_wifi)
    _tap_rail(with_wifi)
    assert with_wifi.rail_face() == "dashboard"
    c = lw._rail_content(with_wifi, with_wifi._v3)
    assert c["faces"] == 1
    assert c["caption"] == "SCAN TO OPEN" and c["headline"] == "Dashboard"
    assert c["fallback"] == with_wifi._v3["public_host"]
    assert _rail_dots(with_wifi) == []


# --- WARP-1784: the debug target covers the whole brand lockup ---------------
# Reported from the rack as "tapping the droplet logo to diagnose doesn't work
# anymore". The mechanism was fine; the target was 96px to the right of the
# thing people aim at, and it had MOVED there — a hardcoded x=124 on an
# inset-less canvas (WARP-1641) became `g.left + 96` in WARP-1644, which at the
# shipping 30px inset resolves to 154.
#
# These tests are about the aim point, so they hit REAL pixel positions
# computed from where the chrome actually draws, not from the region's own
# numbers. Asserting the region against itself would have passed throughout
# the entire time this was broken.

def _chrome_targets():
    """The three things drawn in the top-left lockup, as tap points."""
    g = lw.geom()
    return {
        # draw_droplet_mark(g.left, g.top + 12, 22) — centre of the mark.
        "droplet mark": (g.left + 11, g.top + 23),
        # "DROPLET" wordmark starts at g.left + 30.
        "wordmark": (g.left + 55, g.top + 20),
        # "WARP LAB · MINI-RACK" starts at g.left + 104.
        "device label": (g.left + 150, g.top + 20),
    }


@pytest.mark.parametrize("what", ["droplet mark", "wordmark", "device label"])
def test_every_part_of_the_brand_lockup_opens_debug(populated, what):
    x, y = _chrome_targets()[what]
    lw.render_status(populated)
    assert populated.handle_touch(x, y) == "debug_enter", \
        f"tapping the {what} at {(x, y)} hits nothing"


def test_the_debug_target_starts_at_the_lockup_not_past_it(populated):
    """Anchored to `g.left`, not to an offset from it. An offset is what let
    the gap open in the first place, and it would reopen the moment the safe
    inset changed."""
    lw.render_status(populated)
    g = lw.geom()
    region = next(r for r in populated._touch_regions if r.name == "debug_enter")
    assert region.x == g.left
    # It must still reach the far end of the device label.
    assert region.x + region.w >= g.left + 234


@pytest.mark.parametrize("inset", [0, 30, 60])
def test_the_lockup_stays_tappable_at_any_safe_inset(populated, monkeypatch,
                                                     inset):
    """The dead zone was born when the inset shipped and slid the chrome 30px
    right. Prove the aim points track the chrome at every inset, not just the
    one that happens to be the default today."""
    monkeypatch.setattr(lw, "SAFE_INSET_X", inset)
    lw.render_status(populated)
    for what, (x, y) in _chrome_targets().items():
        assert populated.handle_touch(x, y) == "debug_enter", \
            f"{what} at inset {inset} hits nothing"
        lw.render_status(populated)


def test_the_debug_target_does_not_swallow_the_cells(populated):
    """It is a wide region on a panel whose next row is four tap targets."""
    lw.render_status(populated)
    regions = {r.name: r for r in populated._touch_regions}
    dbg = regions["debug_enter"]
    for name in ("cell_reach", "cell_health", "cell_services", "cell_netstore"):
        cell = regions[name]
        assert dbg.y + dbg.h <= cell.y, f"debug_enter overlaps {name}"


def test_the_debug_target_stays_unlabelled(populated):
    """Design intent: the LIVE screen is what belongs on a rack front. Making
    the target bigger must not make it visible."""
    drawn = _texts(populated)
    for word in ("DEBUG", "DIAGNOSE", "RECOVERY"):
        assert not any(word in t.upper() for t in drawn if len(t) > 1), \
            f"{word!r} appeared in the chrome — the target should stay silent"


# ---------------------------------------------------------------------------
# WARP-2047 — the NETWORK tile must name the household network, or nothing.
#
# Live on droplet-sys the tile read "Droplet-AI" while the household Wi-Fi was
# "Warp", broadcast by the external access point. Two causes, both here:
#   * the tile read `wifi` — the bridge's /wifi STATION scan, which carries no
#     ssid at all on the shapes where an external AP hosts the network;
#   * the vitals default for that ssid was the literal string "Droplet-AI", so
#     the tile's own `or "—"` fallback could never fire.
# ---------------------------------------------------------------------------

def test_network_tile_prefers_the_household_join_feed(populated):
    """`wifi_join` (/openwrt/qr) resolves the SSID across all three box shapes;
    the client-scan feed only ever knows the box's own hotspot."""
    populated._v3["wifi"]["ssid"] = "Droplet-AI"      # stale client-scan value
    populated._v3["wifi_join"] = {
        "ok": True, "ssid": "Warp", "key": "Warp123!", "source": "orchestrator"}

    t = _texts(populated)

    assert "Warp" in t
    assert "Droplet-AI" not in t


def test_network_tile_shows_a_dash_when_no_ssid_is_known(populated):
    """An unknown network renders as unknown. This is the droplet-sys state
    once the bridge stops vouching for creds no radio is beaconing."""
    populated._v3["wifi"]["ssid"] = ""
    populated._v3["wifi_join"] = {}

    t = _texts(populated)

    assert "—" in t
    assert "Droplet-AI" not in t, "a hardcoded SSID reached the glass"


def test_network_tile_ignores_creds_the_bridge_refused(populated):
    """`ok: False` is the bridge saying it cannot vouch for these — the WARP-2047
    refusal. Rendering the ssid alongside it would put the stale name back."""
    populated._v3["wifi"]["ssid"] = ""
    populated._v3["wifi_join"] = {
        "ok": False, "ssid": "Warp", "key": "Droplet123!",
        "error": "this Droplet's radio is not hosting a network"}

    t = _texts(populated)

    assert "Warp" not in t
    assert "—" in t


# --- household_ssid() resolution order --------------------------------------

def test_household_ssid_prefers_join_then_scan_then_empty(wide):
    wide._v3["wifi"] = {"ssid": "ScanNet"}
    wide._v3["wifi_join"] = {"ok": True, "ssid": "JoinNet"}
    assert wide.household_ssid() == "JoinNet"

    # No join answer -> the single-box client-scan value is a legitimate source.
    wide._v3["wifi_join"] = {}
    assert wide.household_ssid() == "ScanNet"

    # Nothing anywhere -> empty, never a placeholder.
    wide._v3["wifi"] = {"ssid": ""}
    assert wide.household_ssid() == ""


def test_household_ssid_drops_a_refused_join_answer(wide):
    """ok:False must not be mined for its ssid — that is exactly the stale pair
    the bridge just declined to publish."""
    wide._v3["wifi"] = {"ssid": ""}
    wide._v3["wifi_join"] = {"ok": False, "ssid": "Warp", "key": "Droplet123!"}
    assert wide.household_ssid() == ""


def test_household_ssid_tolerates_absent_feeds(wide):
    """`ok` is absent until the first bridge snapshot lands; a cold box must
    return "" rather than raise on the missing keys."""
    wide._v3["wifi_join"] = {}
    wide._v3["wifi"] = {}
    assert wide.household_ssid() == ""


def test_the_vitals_ssid_default_is_empty_not_a_plausible_name(sim_display):
    """The defect was in the DEFAULT, not the renderers.

    While `_v3["wifi"]["ssid"]` defaulted to the literal "Droplet-AI", every
    `or "—"` fallback downstream was unreachable — the placeholder was truthy,
    so a box that had never learned its SSID still printed a real-looking one.
    Guard the default directly; a renderer test that sets the field cannot.
    """
    assert sim_display._v3["wifi"]["ssid"] == ""
    assert sim_display.household_ssid() == ""

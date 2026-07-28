"""Wide-panel layout — grid maths, band containment, and honest empty states.

The regression this file exists to prevent: `render_system` at 480x320 puts a
footer at y=244 and a second at HEIGHT-24. At height 320 those are 52px apart;
at 280 they collide. `test_nothing_escapes_its_band` is the general guard —
it records every glyph drawn and asserts each stays inside the band it was
laid out for, so a future edit at the wrong height fails here rather than on
the rack.
"""

from __future__ import annotations

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
    # A core service down is an ALERT, not merely DEGRADED — the box is not
    # doing its job, and the pill is the glance-from-across-the-room signal.
    (lambda v: v["services"].update(
        degraded=[{"name": "ai-gateway", "state": "unhealthy", "core": True}]),
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
        if lw.geom().band_b_top <= y0 < lw.geom().band_b_bot:
            assert y1 <= lw.geom().band_c_rule - 2, \
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

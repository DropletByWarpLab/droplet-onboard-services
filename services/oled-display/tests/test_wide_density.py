"""Wide-panel vertical scaling and the tall-panel density tier.

The regression this file exists to prevent: every y coordinate in the band-B
cell renderers was authored against ONE panel, the 1424x280 rack bar. The
second unit is 1280x400 (measured off the box - the display service reports
its own framebuffer geometry on /health), and against those literals it
painted nothing across the bottom ~110px of its content band. A third of the
glass, dark, on a screen whose whole job is to be readable across a room.

Two properties are pinned here:

  * the reference panel does not move. `by()` is the identity there, so the
    shipped rack bar renders exactly as it did.
  * a taller panel is USED, not stretched. `test_a_tall_panel_fills_its_band`
    is the guard that would have failed on the pre-change code.

Note for anyone extending this file: `_v3_text` lays TRACKED text out one
glyph per `draw.text` call, so a spy on `ImageDraw.text` never sees an eyebrow
as a whole word. Assert on position for those, not on the string.
"""

from __future__ import annotations

import pytest
from PIL import ImageDraw

import display as display_module
import layout_wide as lw

REF_W, REF_H = 1424, 280          # the shipped rack bar
TALL_W, TALL_H = 1280, 400        # the new box's panel, read off /health


def _panel(monkeypatch, w, h):
    monkeypatch.setattr(display_module, "WIDTH", w)
    monkeypatch.setattr(display_module, "HEIGHT", h)


@pytest.fixture
def ref(monkeypatch, sim_display):
    _panel(monkeypatch, REF_W, REF_H)
    return sim_display


@pytest.fixture
def tall(monkeypatch, sim_display):
    _panel(monkeypatch, TALL_W, TALL_H)
    return sim_display


def _fill(disp):
    disp._v3.update({
        "cpu": 34, "mem": 61, "disk": 44, "temp": 52, "gpu": 12,
        "ip": "192.168.1.200", "hostname": "droplet-sys",
        "public_host": "warp-lab.droplet-us.com",
        "uptime": "6d 4h", "version": "v2.6.1",
        "sparks_cpu": [20 + (i % 17) for i in range(48)],
        "sparks_mem": [55 + (i % 13) for i in range(48)],
        "sparks_disk": [40 + i // 6 for i in range(48)],
        "wan_online": True, "wan_latency_ms": 14, "tls_days": 61,
        "wifi": {"ssid": "Droplet-AI", "band": "5 GHz", "channel": 36,
                 "clients": 4},
        "cameras": {"online": 4, "total": 4},
        "storage": {"used_tb": 1.4, "total_tb": 3.6},
        "services": {"up": 27, "total": 27, "status": "ok", "degraded": []},
        "lan_clients": 11,
        "last_event": "12:04 - Backup completed",
    })
    return disp


DEGRADED_NAMES = ["postgres", "frigate", "nextcloud", "email-indexer",
                  "ollama-manager", "collabora", "routing", "matter"]


def _degraded(disp, n=6):
    disp._v3["services"] = {
        "up": 27 - n, "total": 27, "status": "degraded",
        "degraded": [{"name": DEGRADED_NAMES[i], "state": "unhealthy",
                      "core": i < 2} for i in range(n)],
    }
    return disp


def _spy_text(monkeypatch):
    """Record every glyph run the render draws, with its bounding box."""
    drawn = []
    real = ImageDraw.ImageDraw.text

    def spy(self, xy, text, *a, **kw):
        if text:
            drawn.append((self.textbbox(xy, text, font=kw.get("font"),
                                        anchor=kw.get("anchor")), str(text)))
        return real(self, xy, text, *a, **kw)

    monkeypatch.setattr(ImageDraw.ImageDraw, "text", spy)
    return drawn


def _spy_qr_card(monkeypatch):
    """Record the white QR card the rail draws (a square rounded rect)."""
    cards = []
    real_rrect = display_module._rrect

    def spy(draw, x, y, w, h, r, **kw):
        if kw.get("fill") == display_module.V3_WHITE and w == h:
            cards.append((y, h))
        return real_rrect(draw, x, y, w, h, r, **kw)

    monkeypatch.setattr(display_module, "_rrect", spy)
    return cards


# --- density resolution ----------------------------------------------------

def test_the_shipped_rack_bar_stays_compact(ref):
    g = lw.geom()
    assert g.density == "compact"
    assert not g.is_tall
    assert g.extra_rows == 0


def test_the_new_panel_resolves_tall(tall):
    g = lw.geom()
    assert g.density == "tall"
    assert g.extra_rows >= 3, "1280x400 has room for a three-row band D"
    assert g.extra_top < g.extra_bot <= g.band_b_bot


def test_a_marginal_surplus_does_not_open_a_half_band(monkeypatch,
                                                      sim_display):
    """A 60px surplus is margin, not a band. Half a row reads as a fault."""
    _panel(monkeypatch, 1424, 340)
    assert lw.geom().density == "compact"


def test_density_follows_the_panel_not_the_import(monkeypatch, sim_display):
    _panel(monkeypatch, REF_W, REF_H)
    assert lw.geom().density == "compact"
    _panel(monkeypatch, TALL_W, TALL_H)
    assert lw.geom().density == "tall", (
        "geometry was frozen at import - a second panel shape would be wrong")


# --- by(): the anchor ------------------------------------------------------

def test_by_is_the_identity_on_the_reference_panel(ref):
    g = lw.geom()
    for y in (74, 124, 164, 200, 202):
        assert g.by(y) == y, "the shipped panel must not move"


def test_by_tracks_the_band_on_any_other_geometry(monkeypatch, sim_display):
    _panel(monkeypatch, TALL_W, TALL_H)
    g = lw.geom()
    offset = g.band_b_top - lw.REF_BAND_B_TOP
    assert g.by(74) == 74 + offset


def test_by_moves_with_the_vertical_inset(monkeypatch, sim_display):
    _panel(monkeypatch, REF_W, REF_H)
    base = lw.geom().by(74)
    monkeypatch.setattr(lw, "SAFE_INSET_Y", 20)
    assert lw.geom().by(74) == base + 15, (
        "band B rides the inset, so its content must ride it too")


# --- the actual complaint: a tall panel must be USED -----------------------

def test_a_tall_panel_fills_its_band(tall, monkeypatch):
    """The guard that fails on the pre-change code.

    With the authored literals the deepest band-B glyph sat ~165px below
    band_b_top on every panel, so a 276px band came out 60% used and the rest
    was black. Anything above 80% means the extra height carries content."""
    disp = _fill(tall)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)

    g = lw.geom()
    deepest = max(box[3] for box, _ in drawn
                  if box[0] < g.rail_x
                  and g.band_b_top <= box[1] < g.band_b_bot)
    used = (deepest - g.band_b_top) / g.band_b_h
    assert used >= 0.80, f"band B only {used:.0%} used - the panel is padding"


def test_band_d_never_crosses_the_foot_rule(tall, monkeypatch):
    disp = _degraded(_fill(tall), n=8)
    disp._alerts = [{"title": f"alert number {i}", "time": "12:0%d" % i,
                     "cleared": False} for i in range(6)]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)

    g = lw.geom()
    for (x0, y0, _x1, y1), text in drawn:
        # The rail is a separate full-height surface, and band C's foot line
        # legitimately sits below extra_bot. Only band D is under test.
        if x0 >= g.rail_x or not (g.extra_top <= y0 < g.extra_bot):
            continue
        assert y1 <= g.band_c_rule - 2, (
            f"{text!r} in band D collides with the foot rule")


def test_band_d_stays_inside_its_columns(tall, monkeypatch):
    disp = _degraded(_fill(tall), n=8)
    disp._alerts = [{"title": "a very long alert title that will not fit here"
                              " at any sensible size", "time": "13:58",
                     "cleared": False}]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)

    g = lw.geom()
    for (x0, y0, x1, _y1), text in drawn:
        if x0 >= g.rail_x or not (g.extra_top <= y0 < g.extra_bot):
            continue
        assert x1 <= g.content_r + 1, f"{text!r} escapes the content area"


def test_the_compact_panel_draws_no_band_d(ref, monkeypatch):
    disp = _fill(ref)
    disp._alerts = [{"title": "RAID member kicked out of md0", "time": "13:58",
                     "cleared": False}]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)

    # Band-D eyebrows are TRACKED, so they arrive one glyph per call and a
    # `"ACTIVITY" in labels` check could never fail. Assert on position: on a
    # compact panel nothing may sit between the primary row and the foot.
    g = lw.geom()
    for (x0, y0, _x1, _y1), text in drawn:
        if x0 >= g.rail_x:
            continue
        assert y0 < g.row_bot or y0 >= g.band_c_rule, (
            f"{text!r} sits in a band D this panel has no room for")
    assert not any("RAID member" in t for _, t in drawn)


# --- the services split ----------------------------------------------------

def test_compact_overflow_is_unchanged(ref, monkeypatch):
    disp = _degraded(_fill(ref), n=6)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    assert "+4 more" in {t for _, t in drawn}, (
        "the compact panel shows 2 of 6 and must say the other 4 are hidden")


def test_tall_overflow_counts_only_what_no_block_shows(tall, monkeypatch):
    """2 in the cell + 3 carried into band D = 5 of 6. One is hidden, so the
    panel says "+1 more" - not "+4 more" printed directly above four of them.
    """
    disp = _degraded(_fill(tall), n=6)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    texts = {t for _, t in drawn}
    assert "+1 more" in texts
    assert "+4 more" not in texts
    # Core-first then alphabetical: frigate + postgres take the cell, so the
    # carried three are the alphabetical head of what is left and
    # ollama-manager is the one nothing has room for.
    for name in ("collabora", "email-indexer", "nextcloud"):
        assert name in texts, f"{name} was carried but never drawn"
    assert "ollama-manager" not in texts


def test_no_service_is_listed_twice(tall, monkeypatch):
    disp = _degraded(_fill(tall), n=6)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    names = [t for _, t in drawn if t in set(DEGRADED_NAMES)]
    assert len(names) == len(set(names)), f"duplicated rows: {names}"


def test_an_empty_degraded_list_is_not_a_dead_feed(tall, monkeypatch):
    """Green "None" over a feed that never answered claims a health nobody
    measured - the same species of lie as WARP-1643's fake 0 degrees."""
    disp = _fill(tall)
    disp._v3["services"] = {"up": None, "total": None, "status": None,
                            "degraded": []}
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    assert "None" not in {t for _, t in drawn}


def test_a_healthy_feed_does_say_none(tall, monkeypatch):
    disp = _fill(tall)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    assert "None" in {t for _, t in drawn}


# --- band D content --------------------------------------------------------

def test_alerts_reach_the_glass_without_a_tap(tall, monkeypatch):
    disp = _fill(tall)
    disp._alerts = [{"title": "RAID member kicked out of md0", "time": "13:58",
                     "cleared": False}]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    texts = {t for _, t in drawn}
    assert any("RAID member" in t for t in texts), (
        "the compact panel hides alerts behind a tap; a tall one must not")
    assert "13:58" in texts


def test_open_alerts_sort_above_cleared_ones(tall, monkeypatch):
    disp = _fill(tall)
    disp._alerts = [
        {"title": "cleared one", "time": "09:00", "cleared": True},
        {"title": "still broken", "time": "13:58", "cleared": False},
    ]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    ys = {t: box[1] for box, t in drawn
          if t in ("cleared one", "still broken")}
    assert ys["still broken"] < ys["cleared one"]


def test_lan_client_count_finally_reaches_a_screen(tall, monkeypatch):
    disp = _fill(tall)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    assert "11" in {t for _, t in drawn}, (
        "lan_clients is streamed by the bridge and was rendered nowhere")


def test_a_seeded_zero_client_count_is_not_a_reading(tall, monkeypatch):
    disp = _fill(tall)
    disp._v3["lan_clients"] = 0
    disp._v3["wifi"]["clients"] = 0
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    g = lw.geom()
    x, _w = g.cells["netstore"]
    band_d = [t for box, t in drawn if box[1] >= g.extra_top and box[0] >= x]
    assert "0" not in band_d, "an unmeasured 0 must render as an em dash"


def test_trends_refuse_to_draw_a_line_they_cannot_measure(tall, monkeypatch):
    disp = _fill(tall)
    disp._v3["sparks_mem"] = []
    disp._v3["sparks_disk"] = [61.0]
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    assert [t for _, t in drawn].count("no history yet") == 2


# --- the rail --------------------------------------------------------------

def test_the_rail_block_does_not_split_on_a_tall_panel(tall, monkeypatch):
    """Card down from the top, address up from the bottom is invisible at
    280px and unmissable at 400: 110px of black between a QR and its own
    caption, and the two stop reading as one object."""
    cards = _spy_qr_card(monkeypatch)
    drawn = _spy_text(monkeypatch)
    lw.render_status(_fill(tall))

    assert cards, "the QR card was not drawn"
    card_y, card_h = cards[0]
    # The caption is TRACKED, so there is no "SCAN TO OPEN" run to look for.
    # Take the top of the rail's text stack, which is its first character.
    below = [box[1] for box, _t in drawn
             if box[0] >= lw.geom().rail_x and box[1] >= card_y]
    assert below, "no text under the card"
    gap = min(below) - (card_y + card_h)
    assert 0 <= gap <= lw.QR_CARD_GAP + 4, (
        f"card and caption are {gap}px apart - they read as two objects")


def test_the_rail_stays_centred_not_top_heavy(tall, monkeypatch):
    cards = _spy_qr_card(monkeypatch)
    lw.render_status(_fill(tall))
    card_y, _h = cards[0]
    assert card_y > lw.geom().top + 40, (
        "the card is still pinned to the top of the rail")


def test_the_reference_rail_is_untouched(ref, monkeypatch):
    """The shipped panel's QR must not shrink: 166px at the default inset is
    what WARP-1647 measured as scannable at the rack."""
    cards = _spy_qr_card(monkeypatch)
    lw.render_status(_fill(ref))
    assert cards[0] == (29, 166)


# --- a SHORTER panel must not lose content either --------------------------

def test_a_shorter_panel_keeps_its_content_on_the_glass(monkeypatch,
                                                        sim_display):
    """The literals were authored at one height, so they were equally wrong
    downwards - a 240px panel used to run the metric row off the bottom."""
    _panel(monkeypatch, 1424, 240)
    disp = _fill(sim_display)
    drawn = _spy_text(monkeypatch)
    lw.render_status(disp)
    g = lw.geom()
    assert g.density == "compact"
    for (x0, _y0, _x1, y1), text in drawn:
        if x0 >= g.rail_x:
            continue
        assert y1 <= display_module.HEIGHT, f"{text!r} runs off the panel"


def test_a_panel_too_short_for_the_row_says_so_once(monkeypatch, sim_display,
                                                    caplog):
    """The mirror image of the bug this file exists for, and the worse
    direction: content runs DOWN through the foot rule instead of leaving a
    gap above it. There is no compressed tier, so the layout has to say so."""
    lw._SHORT_PANEL_WARNED.clear()
    lw._GEOM_CACHE.clear()
    _panel(monkeypatch, 1424, 240)
    with caplog.at_level("WARNING", logger="droplet.tft.wide"):
        lw.geom()
        lw._GEOM_CACHE.clear()
        lw.geom()
    warnings = [r for r in caplog.records if "too short" in r.getMessage()]
    assert len(warnings) == 1, "a per-render warning would flood the journal"


def test_the_shipped_panel_does_not_trip_the_short_guard(monkeypatch,
                                                         sim_display, caplog):
    lw._SHORT_PANEL_WARNED.clear()
    lw._GEOM_CACHE.clear()
    _panel(monkeypatch, REF_W, REF_H)
    with caplog.at_level("WARNING", logger="droplet.tft.wide"):
        lw.geom()
    assert not [r for r in caplog.records if "too short" in r.getMessage()]


def test_the_new_panel_does_not_trip_the_short_guard(monkeypatch, sim_display,
                                                     caplog):
    lw._SHORT_PANEL_WARNED.clear()
    lw._GEOM_CACHE.clear()
    _panel(monkeypatch, TALL_W, TALL_H)
    with caplog.at_level("WARNING", logger="droplet.tft.wide"):
        lw.geom()
    assert not [r for r in caplog.records if "too short" in r.getMessage()]

"""The safe area on the 480x320-authored screens — WARP-1702.

WARP-1644 gave `layout_wide` a safe area so content clears the rack panel's
bezel, but only `system` and `debug` route through layout_wide. Every other
screen was still drawn by display.py's 480x320 code, whose margins are literals
measured from x=0 and from WIDTH/HEIGHT — so on the 1424x280 bar the home tile
grid had its mark sliced, "Ask AI" read "sk AI" and the status ribbon was cut
off. The founder photographed exactly that.

Those renderers now draw onto a canvas the size of the safe area and hand it to
`_fit_panel`, which composites it into the panel frame at the inset. The two
things that must stay true, and that this file pins:

  * nothing lands in the margin the bezel eats, and
  * the touch regions move with the pixels — a tap must still hit the tile the
    user is looking at.

The 480x320 path must remain untouched, so that is asserted too.
"""

from __future__ import annotations

import pytest

import display as display_module
import layout_wide as lw

PANEL_W, PANEL_H = 1424, 280

# The screens authored against the raw frame edge — i.e. everything that does
# NOT go through layout_wide. `system` and `debug` are deliberately absent:
# they own their own insetting, and their rail's background panel bleeds to the
# frame edge by design.
LEGACY_SCREENS = (
    "home", "stats", "chat", "devices", "settings", "idle", "message", "claim",
)


@pytest.fixture
def wide(monkeypatch, sim_display):
    """A sim display whose geometry is the rack bar."""
    monkeypatch.setattr(display_module, "WIDTH", PANEL_W)
    monkeypatch.setattr(display_module, "HEIGHT", PANEL_H)
    return sim_display


def _render(disp, name):
    if name == "message":
        return disp.render_message("Title", ["line one", "line two"])
    if name == "claim":
        return disp.render_claim("DRPL-AB12-CD34", "https://droplet-us.com/setup")
    return getattr(disp, "render_" + name)()


def _margin_pixels(img, ix, iy):
    """Every pixel the bezel is expected to eat."""
    px = img.convert("RGB").load()
    for x in range(img.width):
        for y in range(iy):
            yield px[x, y]
        for y in range(img.height - iy, img.height):
            yield px[x, y]
    for y in range(img.height):
        for x in range(ix):
            yield px[x, y]
        for x in range(img.width - ix, img.width):
            yield px[x, y]


# --- the margin ------------------------------------------------------------

@pytest.mark.parametrize("screen", LEGACY_SCREENS)
def test_nothing_is_drawn_in_the_bezel_margin(wide, screen):
    """The strip the bezel covers must be flat fill, never content.

    A single distinct colour is the honest assertion here: the margin is a
    paste border, so any second colour means a glyph, rule or card has leaked
    back into it.
    """
    img = _render(wide, screen)
    assert img.size == (PANEL_W, PANEL_H)
    colours = set(_margin_pixels(img, lw.SAFE_INSET_X, lw.SAFE_INSET_Y))
    assert len(colours) == 1, (
        f"{screen}: {len(colours)} colours in the bezel margin — content is "
        f"running off the glass again"
    )


@pytest.mark.parametrize("screen", LEGACY_SCREENS)
def test_content_still_fills_the_safe_area(wide, screen):
    """Guard against the opposite failure: insetting so hard nothing shows.

    Without this, a renderer that returned a blank canvas would sail through
    the margin test above.
    """
    img = _render(wide, screen).convert("RGB")
    inner = img.crop((lw.SAFE_INSET_X, lw.SAFE_INSET_Y,
                      PANEL_W - lw.SAFE_INSET_X, PANEL_H - lw.SAFE_INSET_Y))
    assert len(inner.getcolors(maxcolors=1 << 16) or []) > 8, (
        f"{screen}: safe area is nearly blank"
    )


# --- touch follows the pixels ---------------------------------------------

def test_home_tile_taps_land_on_the_tiles_they_point_at(wide):
    """Regions are recorded in canvas coords, so they must be translated with
    the paste. If that ever drifts, taps land ~30px off and the panel feels
    broken in a way no screenshot shows."""
    img = wide.render_home().convert("RGB")
    px = img.load()
    regions = {r.name: r for r in wide._touch_regions
               if r.name.startswith("tile_")}
    assert set(regions) == {"tile_chat", "tile_sys", "tile_net", "tile_cfg"}

    for name, r in regions.items():
        cx, cy = r.x + r.w // 2, r.y + r.h // 2
        assert lw.SAFE_INSET_X <= r.x and r.x + r.w <= PANEL_W - lw.SAFE_INSET_X, \
            f"{name} escapes the safe area horizontally"
        assert lw.SAFE_INSET_Y <= r.y and r.y + r.h <= PANEL_H - lw.SAFE_INSET_Y, \
            f"{name} escapes the safe area vertically"
        # The pixel under the middle of the tap target must be tile surface,
        # not the page behind it.
        assert px[cx, cy] == display_module.SURFACE_RAISED, \
            f"{name}: centre of the tap target is not on the tile"


def test_home_tap_dispatches_to_the_right_screen(wide):
    wide.render_home()
    net = next(r for r in wide._touch_regions if r.name == "tile_net")
    assert wide.handle_touch(net.x + net.w // 2, net.y + net.h // 2) == "tile_net"


# --- the wide home layout --------------------------------------------------

def test_home_puts_the_tiles_in_one_row_on_the_bar(wide):
    """Two rows do not fit in 280px: the subtitles were clipped by the tile
    edge and then again by the status ribbon."""
    wide.render_home()
    tiles = [r for r in wide._touch_regions if r.name.startswith("tile_")]
    assert len({r.y for r in tiles}) == 1, "tiles should share one row"
    assert len({r.x for r in tiles}) == 4, "tiles should be in four columns"


def test_home_tiles_clear_the_status_ribbon(wide):
    """The ribbon is drawn at ch-56. A tile that overlaps it is the exact bug
    that clipped 'Tap to chat' and 'Brightness & more'."""
    wide.render_home()
    tiles = [r for r in wide._touch_regions if r.name.startswith("tile_")]
    ribbon_top = PANEL_H - lw.SAFE_INSET_Y - 56
    assert max(r.y + r.h for r in tiles) <= ribbon_top


# --- the 480x320 panel is untouched ---------------------------------------

@pytest.fixture
def narrow(monkeypatch, sim_display):
    monkeypatch.setattr(display_module, "WIDTH", 480)
    monkeypatch.setattr(display_module, "HEIGHT", 320)
    return sim_display


def test_no_inset_on_a_pyportal_panel(narrow):
    assert display_module._safe_inset() == (0, 0)


@pytest.mark.parametrize("screen", LEGACY_SCREENS)
def test_pyportal_frames_are_full_size_and_uncomposited(narrow, screen):
    """`_fit_panel` must be an identity on 480x320 — same object, no paste."""
    img = _render(narrow, screen)
    assert img.size == (480, 320)
    assert narrow._fit_panel(img, display_module.BG_COLOR) is img


def test_pyportal_home_keeps_its_two_by_two_grid(narrow):
    narrow.render_home()
    tiles = [r for r in narrow._touch_regions if r.name.startswith("tile_")]
    assert len({r.y for r in tiles}) == 2
    assert len({r.x for r in tiles}) == 2

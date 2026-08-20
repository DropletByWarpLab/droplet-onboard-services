"""Letterboxing a panel that is neither a rack bar nor a 480x320 TFT.

`setup.sh` writes LCD_WIDTH/LCD_HEIGHT from whatever framebuffer it finds, so
an HDMI monitor plugged into a box BECOMES the panel geometry. That used
to fall through to display.py's `render_system` body, which is
authored against hardcoded 480-wide coordinates: at 1920x1080 it painted 1.59%
of the pixels, with the clock 1500px from the content it labels and a 1010px
divider hairline beside a 230px column.

The answer is not a lower `WIDE_ASPECT_THRESHOLD`. Forcing the bar layout to
fill 1080px of height leaves substantive content ending at y=660, because the
density tier is DATA-bound, not space-bound — `extra_rows` offers 31 rows at
1080px against roughly five rows of content that exists. So the monitor gets
the real bar layout at full width, in a band, centred.

What this file pins, in order of what would hurt most if it broke:

  * the two SHIPPING panels are untouched — `band_height` declines both, so
    nothing here can reach the rack bar
  * the 480x320 TFT is untouched, and it is kept out by a WIDTH floor rather
    than by an aspect test, because that is the real constraint
  * the band is always a shape `is_wide()` would accept, by construction
  * the swapped module geometry is ALWAYS restored, including when the
    renderer raises — a leaked band would mis-render every later frame

Note for anyone extending this file: `_v3_text` lays tracked text out one
glyph per `draw.text` call, and glyph metrics vary by host font. Assert on
structure and geometry here, never on exact ink counts.
"""

from __future__ import annotations

import pytest
from PIL import Image, ImageChops

import display as display_module
import layout_wide as lw


def _ink_mask(img):
    """Greyscale difference from the background — non-background pixels."""
    flat = Image.new("RGB", img.size, display_module.V3_BG)
    return ImageChops.difference(img.convert("RGB"), flat).convert("L")


def _is_blank(img) -> bool:
    return _ink_mask(img).getbbox() is None


def _ink(img) -> int:
    return sum(_ink_mask(img).histogram()[1:])


REF_W, REF_H = 1424, 280          # the shipped rack bar
TALL_W, TALL_H = 1280, 400        # the new box's panel
TFT_W, TFT_H = 480, 320           # the PyPortal Titano
MON_W, MON_H = 1920, 1080         # the bench monitor


def _panel(monkeypatch, w, h):
    monkeypatch.setattr(display_module, "WIDTH", w)
    monkeypatch.setattr(display_module, "HEIGHT", h)


def _fill(disp):
    """Enough live data that the cells draw something."""
    disp._v3.update({
        "cpu": 34, "mem": 61, "disk": 44, "temp": 52, "gpu": 12,
        "ip": "192.168.1.200", "hostname": "droplet-sys",
        "uptime": "6d 4h", "version": "v2.6.1",
        "sparks_cpu": [20 + (i % 17) for i in range(48)],
        "sparks_mem": [55 + (i % 13) for i in range(48)],
        "sparks_disk": [40 + i // 6 for i in range(48)],
        "wan_online": True, "wan_latency_ms": 14,
        "wifi": {"ssid": "Droplet-AI", "band": "5 GHz", "clients": 4},
        "cameras": {"online": 4, "total": 4},
        "storage": {"used_tb": 1.4, "total_tb": 3.6},
        "services": {"up": 27, "total": 27, "status": "ok", "degraded": []},
        "lan_clients": 11,
    })
    return disp


# ---------------------------------------------------------------------------
# The shipping panels must not be reachable from here
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("w,h", [(REF_W, REF_H), (TALL_W, TALL_H)])
def test_real_panels_are_never_letterboxed(w, h):
    """Both units in the field are natively wide. If this fails, the change
    has reached a shipping panel and the rack bar is rendering in a band."""
    assert lw.band_height(w, h) is None


@pytest.mark.parametrize("w,h", [(TFT_W, TFT_H), (800, 600), (640, 480)])
def test_small_panels_keep_their_own_body(w, h):
    assert lw.band_height(w, h) is None


def test_the_floor_is_width_not_aspect():
    """1024x768 and 800x600 are the SAME aspect (1.33). Only the wider one is
    letterboxed — pinning that the constraint is the layout's minimum width,
    not squareness."""
    assert abs((1024 / 768) - (800 / 600)) < 1e-9
    assert lw.band_height(1024, 768) is not None
    assert lw.band_height(800, 600) is None


def test_why_the_width_floor_exists(monkeypatch):
    """The concrete reason for MIN_BAR_WIDTH: below it the bar layout does not
    look cramped, it COLLAPSES. At 480 the fixed 220px rail plus margins leave
    a zero-width netstore cell. This is the measurement the floor encodes, so
    if someone lowers MIN_BAR_WIDTH this is what tells them why not."""
    _panel(monkeypatch, 480, 280)
    assert lw.geom().cells["netstore"][1] == 0
    _panel(monkeypatch, lw.MIN_BAR_WIDTH, 280)
    assert lw.geom().cells["netstore"][1] > 0


# ---------------------------------------------------------------------------
# The band is a shape the layout actually supports
# ---------------------------------------------------------------------------
MONITORS = [(1024, 768), (1280, 1024), (1366, 768), (1600, 900),
            (MON_W, MON_H), (2560, 1440), (1080, 1920)]


@pytest.mark.parametrize("w,h", MONITORS)
def test_band_is_always_wide_by_construction(w, h):
    """Whatever comes back must satisfy is_wide(), so the bar layout is never
    asked to render outside the range it claims to support."""
    band = lw.band_height(w, h)
    assert band is not None
    assert (w / band) >= lw.WIDE_ASPECT_THRESHOLD


@pytest.mark.parametrize("w,h", MONITORS)
def test_band_fits_the_panel(w, h):
    band = lw.band_height(w, h)
    assert lw.BAND_MIN_H <= band <= h


def test_a_1080p_monitor_gets_the_tall_tier(monkeypatch):
    """The point of aiming at 4:1 rather than just clearing 3.0: 1920 lands on
    a 480px band, which opens band D with content rather than a compact strip
    marooned in a large screen."""
    band = lw.band_height(MON_W, MON_H)
    assert band == 480
    _panel(monkeypatch, MON_W, band)
    assert lw.geom().density == "tall"
    assert lw.geom().extra_rows > 0


# ---------------------------------------------------------------------------
# The render
# ---------------------------------------------------------------------------
def test_the_band_is_centred_with_blank_bars(monkeypatch, sim_display):
    """Structure, not ink: the bars are background, the band is not."""
    _panel(monkeypatch, MON_W, MON_H)
    img = _fill(sim_display).render_system().convert("RGB")
    assert img.size == (MON_W, MON_H), "the backend would have to crop this"
    band = lw.band_height(MON_W, MON_H)
    top = (MON_H - band) // 2

    assert _is_blank(img.crop((0, 0, MON_W, top))), "ink above the band"
    assert _is_blank(img.crop((0, top + band, MON_W, MON_H))), "ink below it"
    assert not _is_blank(img.crop((0, top, MON_W, top + band))),         "the band painted nothing"


def test_content_uses_the_monitors_full_width(monkeypatch, sim_display):
    """Width is the one thing a monitor genuinely offers this layout, so the
    band must use it — a 1424-wide island in a 1920 screen would be the bug
    this change exists to avoid.

    Deliberately NOT an ink bounding box. The legacy body anchors its clock at
    `WIDTH - 20` and rules its header separator to the same edge, so a bbox
    reaches the right margin on BOTH paths and proves nothing — that is the
    measurement that made this defect look fine for as long as it did. This
    counts ink in the rightmost eighth instead, where the band puts the action
    rail and the legacy body puts a clock and a hairline."""
    _panel(monkeypatch, MON_W, MON_H)
    right = (MON_W * 7 // 8, 0, MON_W, MON_H)
    boxed = _ink(_fill(sim_display).render_system().crop(right))

    monkeypatch.setattr(lw, "MIN_BAR_WIDTH", MON_W + 1)
    legacy = _ink(_fill(sim_display).render_system().crop(right))

    assert boxed > legacy * 5


def test_letterbox_beats_the_body_it_replaces(monkeypatch, sim_display):
    """The regression guard proper. Raising the width floor above the panel
    forces the old fall-through, so the two paths are compared on the same
    geometry and the same data."""
    _panel(monkeypatch, MON_W, MON_H)
    boxed = _fill(sim_display).render_system().convert("RGB")

    monkeypatch.setattr(lw, "MIN_BAR_WIDTH", MON_W + 1)
    legacy = _fill(sim_display).render_system().convert("RGB")

    assert _ink(boxed) > _ink(legacy) * 1.5


def test_debug_screen_is_letterboxed_not_bounced(monkeypatch, sim_display):
    """render_debug used to bounce every non-wide panel to render_system. On a
    bench monitor the debug screen is the one you actually want."""
    _panel(monkeypatch, MON_W, MON_H)
    disp = _fill(sim_display)
    assert disp.render_debug().size == (MON_W, MON_H)
    assert disp.render_debug().tobytes() != disp.render_system().tobytes()


def test_small_panel_debug_still_bounces(monkeypatch, sim_display):
    _panel(monkeypatch, TFT_W, TFT_H)
    disp = _fill(sim_display)
    assert disp.render_debug().tobytes() == disp.render_system().tobytes()


# ---------------------------------------------------------------------------
# Touch, and the geometry swap
# ---------------------------------------------------------------------------
def test_touch_regions_land_in_panel_coordinates(monkeypatch, sim_display):
    """The regions are recorded in BAND coordinates while the band renders.
    The touch reader reports raw panel coordinates, so an untranslated region
    is a tap target that silently sits in the wrong place — invisible in a
    screenshot, which is why it is pinned here rather than looked at."""
    _panel(monkeypatch, MON_W, MON_H)
    disp = _fill(sim_display)
    disp.render_system()

    band = lw.band_height(MON_W, MON_H)
    top = (MON_H - band) // 2
    assert disp._touch_regions, "no tap targets registered — test proves nothing"
    for r in disp._touch_regions:
        assert r.y >= top, f"{r.name} sits above the band"
        assert r.y + r.h <= top + band, f"{r.name} runs past the band"


def test_module_geometry_is_restored(monkeypatch, sim_display):
    _panel(monkeypatch, MON_W, MON_H)
    _fill(sim_display).render_system()
    assert (display_module.WIDTH, display_module.HEIGHT) == (MON_W, MON_H)


def test_module_geometry_is_restored_even_when_the_render_raises(monkeypatch,
                                                                 sim_display):
    """The `finally` is load-bearing: a leaked band geometry would mis-render
    every subsequent frame on the real panel, long after the failing one."""
    _panel(monkeypatch, MON_W, MON_H)

    def boom(disp, **kwargs):
        raise RuntimeError("renderer blew up mid-band")

    with pytest.raises(RuntimeError):
        lw.render_letterboxed(sim_display, boom)
    assert (display_module.WIDTH, display_module.HEIGHT) == (MON_W, MON_H)


def test_render_letterboxed_declines_a_panel_that_is_not_its_business(
        monkeypatch, sim_display):
    """None is the contract the dispatch sites fall through on."""
    for w, h in [(REF_W, REF_H), (TALL_W, TALL_H), (TFT_W, TFT_H)]:
        _panel(monkeypatch, w, h)
        assert lw.render_letterboxed(
            sim_display, lw.render_status) is None


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
def test_health_reports_the_band(monkeypatch, sim_display):
    _panel(monkeypatch, MON_W, MON_H)
    status = sim_display.get_status()
    # Concrete, not `== lw.band_height(...)`: comparing the field to the call
    # it is computed from would hold however the wiring broke.
    assert status["resolution"] == f"{MON_W}x{MON_H}"
    assert status["letterbox_band"] == 480


@pytest.mark.parametrize("w,h", [(REF_W, REF_H), (TFT_W, TFT_H)])
def test_health_reports_no_band_on_a_panel_that_has_none(monkeypatch,
                                                         sim_display, w, h):
    _panel(monkeypatch, w, h)
    assert sim_display.get_status()["letterbox_band"] is None


# ---------------------------------------------------------------------------
# The debug screen must not lie about the panel it is drawn on
# ---------------------------------------------------------------------------
def test_debug_panel_row_reports_the_monitor_not_the_band(monkeypatch,
                                                          sim_display):
    """Regression on a defect this change INTRODUCED before it was caught: the
    debug screen renders inside the geometry swap, so its PANEL row read the
    band and announced "1920×480" on a 1920x1080 monitor. The one screen whose
    job is to state what the box actually is must not be among the things
    lying to you — and "why is most of my screen black" is exactly the
    question someone opens it to answer."""
    _panel(monkeypatch, MON_W, MON_H)
    seen = []
    real = display_module._v3_text

    def spy(draw, text, x, y, **kwargs):
        seen.append(str(text))
        return real(draw, text, x, y, **kwargs)

    monkeypatch.setattr(display_module, "_v3_text", spy)
    _fill(sim_display).render_debug()

    assert f"{MON_W}×{MON_H} · band 480" in seen, \
        f"PANEL row did not state the true geometry; drew {seen[:12]}"
    assert f"{MON_W}×480" not in seen, "PANEL row reported the band as the panel"


def test_panel_readout_prefers_the_framebuffers_own_geometry(monkeypatch):
    """On the fb backend the framebuffer knows its real size, and that beats
    the module globals. The band is still disclosed alongside it."""
    _panel(monkeypatch, MON_W, 480)
    monkeypatch.setattr(lw, "_TRUE_PANEL", (MON_W, MON_H))
    status = {"panel": {"width": MON_W, "height": MON_H}}
    assert lw._panel_readout(status) == f"{MON_W}×{MON_H} · band 480"


def test_panel_readout_is_unchanged_off_the_letterbox_path(monkeypatch):
    _panel(monkeypatch, REF_W, REF_H)
    assert lw._TRUE_PANEL is None
    assert lw._panel_readout({}) == f"{REF_W}×{REF_H}"


def test_true_panel_is_cleared_after_the_render(monkeypatch, sim_display):
    _panel(monkeypatch, MON_W, MON_H)
    _fill(sim_display).render_system()
    assert lw._TRUE_PANEL is None

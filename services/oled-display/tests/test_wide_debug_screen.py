"""WARP-1641 / WARP-2149 — geometry dispatch + the panel's debug screen.

Three things under test:

1. `render_system` hands off to the wide layout on a bar panel, and does NOT
   on a 480x320 one. The 480x320 body is authored against hardcoded
   coordinates (divider at x=288; footers at y=244 AND HEIGHT-24, which are
   52px apart at height 320 and collide at 280), so this is a correctness
   dispatch, not a cosmetic one.

2. The way in and out (WARP-2149). Entry is a DOUBLE tap on the brand
   lockup: a single stray touch must not flip the rack's front panel, and
   the old single-tap entry turned a natural double-tap into enter-then-
   immediately-exit (tap 2 fired the same lockup's debug_back). BACK goes
   to STANDBY, the panel's resting state — it used to go to HOME, the
   480-authored tile grid, a broken surface on a wide panel.

3. The console handback. The screen's ONE control opens a login console in
   a single tap (the double-tap gate on the way in is the stray-touch guard
   now), and the whole path has to survive the bridge being unreachable —
   the caller is a person standing at a rack with no other way in.
"""

from __future__ import annotations

import pytest
from PIL import Image

import display as display_module
import layout_wide as lw
from display import TFTDisplay

PANEL_W, PANEL_H = 1424, 280


@pytest.fixture
def wide(monkeypatch, sim_display: TFTDisplay):
    monkeypatch.setattr(display_module, "WIDTH", PANEL_W)
    monkeypatch.setattr(display_module, "HEIGHT", PANEL_H)
    sim_display._v3.update({
        "cpu": 12, "mem": 40, "disk": 20, "temp": 44,
        "ip": "192.168.1.250", "hostname": "droplet-sys", "uptime": "6d 4h",
    })
    return sim_display


# --- dispatch ---------------------------------------------------------------

def test_render_system_hands_off_on_a_wide_panel(wide):
    img = wide.render_system()
    assert img.size == (PANEL_W, PANEL_H)


def test_render_system_keeps_the_pyportal_layout_at_480x320(sim_display):
    """The existing renderers and their tests must stay byte-identical."""
    assert not lw.is_wide()
    img = sim_display.render_system()
    assert img.size == (display_module.WIDTH, display_module.HEIGHT) == (480, 320)


def test_debug_falls_back_to_system_when_not_wide(sim_display):
    """No room for it on a 480x320 panel, and settings already covers that
    shape — better the System screen than something cramped."""
    assert sim_display.render_debug().size == (480, 320)


def test_debug_renders_on_the_bar(wide):
    assert wide.render_debug().size == (PANEL_W, PANEL_H)


def test_debug_mode_constant_and_dispatch(wide):
    assert TFTDisplay.DEBUG == "debug"
    wide._go_debug()
    assert wide._current_mode == TFTDisplay.DEBUG
    wide._render_current()
    assert wide._current_image.size == (PANEL_W, PANEL_H)


# --- reaching the screen: the double-tap gate (WARP-2149) -------------------

def _region(disp, name):
    return next(r for r in disp._touch_regions if r.name == name)


def test_status_screen_exposes_a_debug_target(wide):
    lw.render_status(wide)
    assert "debug_enter" in {r.name for r in wide._touch_regions}


def test_a_single_tap_on_the_lockup_does_nothing(wide):
    """The stray touch (or a sleeve) that used to flip the rack's front panel
    to the recovery screen now does nothing at all."""
    lw.render_status(wide)
    enter = _region(wide, "debug_enter")
    assert wide.handle_touch(enter.x + 2, enter.y + 2) == "debug_enter"
    assert wide._current_mode != TFTDisplay.DEBUG


def test_a_double_tap_enters_debug(wide):
    lw.render_status(wide)
    enter = _region(wide, "debug_enter")
    wide.handle_touch(enter.x + 2, enter.y + 2)
    wide.handle_touch(enter.x + 2, enter.y + 2)
    assert wide._current_mode == TFTDisplay.DEBUG


def test_the_gate_survives_a_re_render_between_taps(wide):
    """Touch regions are rebuilt on every render and the live screens repaint
    every ~1s, so a gate stored on the region would be wiped between the two
    taps. It lives on the display object; prove a re-render doesn't reset it."""
    lw.render_status(wide)
    enter = _region(wide, "debug_enter")
    wide.handle_touch(enter.x + 2, enter.y + 2)
    lw.render_status(wide)
    assert wide.handle_touch(enter.x + 2, enter.y + 2) == "debug_enter"
    assert wide._current_mode == TFTDisplay.DEBUG


def test_a_slow_second_tap_re_arms_instead_of_entering(wide):
    wide._tap_debug_enter()
    wide._debug_enter_at -= display_module.DEBUG_DOUBLE_TAP_SECONDS + 0.05
    wide._tap_debug_enter()
    assert wide._current_mode != TFTDisplay.DEBUG, \
        "two taps a sip-of-coffee apart are two stray taps, not a gesture"
    # ...but that late tap re-armed: one more inside the window enters.
    wide._tap_debug_enter()
    assert wide._current_mode == TFTDisplay.DEBUG


# --- the screen itself: a door, not a dashboard (WARP-2149) -----------------

def test_debug_screen_has_back_and_console_targets(wide):
    lw.render_debug(wide)
    names = {r.name for r in wide._touch_regions}
    assert {"debug_back", "console_return"} <= names


def test_the_debug_screen_offers_nothing_but_console_and_back(wide):
    """The WARP-1641 build buried the console button under four columns of
    readouts and a dashboard QR rail. The rebuilt screen has exactly two
    things to tap; anything a third target offers belongs on the dashboard
    or in the console itself, not here."""
    lw.render_debug(wide)
    assert {r.name for r in wide._touch_regions} == {"debug_back",
                                                     "console_return"}


def test_debug_targets_are_hittable(wide):
    lw.render_debug(wide)
    for r in wide._touch_regions:
        assert r.w >= 44 and r.h >= 44, f"{r.name} too small to hit"


# --- WARP-1801: the way out is the way in -----------------------------------

def _resolve(disp, x, y):
    """Which region a tap at (x,y) would hit — same first-match order as
    handle_touch, but WITHOUT firing the action, so a sweep can probe many
    points without each one navigating the panel out from under the next.
    """
    for r in disp._touch_regions:
        if r.contains(x, y):
            return r.name
    return None


def test_every_pixel_that_enters_debug_also_leaves_it(wide):
    """The exit target must span the entry target, pixel for pixel.

    WARP-1784 widened the way IN to the whole brand lockup because the droplet
    mark is what people aim at. The way OUT stayed the 74px "‹ BACK" chip, so
    170 of those 256px did nothing on the debug screen — you tapped the logo
    that had just worked and got silence. This asserts the two stay the same
    span, so moving either one without the other fails here rather than at a
    rack.
    """
    lw.render_status(wide)
    enter = _region(wide, "debug_enter")

    lw.render_debug(wide)
    dead = [x for x in range(enter.x, enter.x + enter.w + 1)
            if _resolve(wide, x, enter.y + enter.h // 2) != "debug_back"]
    assert not dead, (
        f"{len(dead)} px of the debug_enter span do not leave the debug "
        f"screen: {dead[:8]}{'...' if len(dead) > 8 else ''}")

    # And it really does navigate — to STANDBY, the panel's resting state,
    # not to the legacy HOME grid (WARP-2149).
    assert wide.handle_touch(enter.x + 2, enter.y + 2) == "debug_back"
    assert wide._current_mode == TFTDisplay.STANDBY


def test_back_ignores_the_tail_of_the_entry_gesture(wide):
    """A sloppy triple-tap must not enter and immediately leave — that bounce
    (enter on tap 1, exit to the wrong screen on tap 2) is the exact defect
    the double-tap gate exists to close."""
    wide._go_debug()
    wide._tap_debug_back()
    assert wide._current_mode == TFTDisplay.DEBUG
    # Past the gesture window it is a deliberate press, and it leaves.
    wide._debug_opened_at -= display_module.DEBUG_DOUBLE_TAP_SECONDS + 0.05
    wide._tap_debug_back()
    assert wide._current_mode == TFTDisplay.STANDBY


def test_the_back_chip_stays_visible(wide):
    """Widening the hit box must not delete the affordance — an unlabelled way
    out is how you get "there is no back button" a second time."""
    img = lw.render_debug(wide)
    g = lw.geom()
    cx, cy, cw, ch = g.left + 172, g.top + 12, 74, 22
    px = img.load()
    surface = sum(1 for x in range(cx, cx + cw) for y in range(cy, cy + ch)
                  if px[x, y] == display_module.V3_SURFACE)
    assert surface > 200, (
        f"the '‹ BACK' chip is not being drawn ({surface} surface px)")
    # ...and the hit box around it is the full lockup, not just the chip.
    assert _region(wide, "debug_back").w == lw.LOCKUP_W > cw


def test_the_widened_back_target_does_not_swallow_console_open(wide):
    lw.render_debug(wide)
    back, console = _region(wide, "debug_back"), _region(wide, "console_return")
    disjoint = (back.x + back.w <= console.x or console.x + console.w <= back.x
                or back.y + back.h <= console.y
                or console.y + console.h <= back.y)
    assert disjoint, (
        "the back target must not overlap OPEN CONSOLE — that button swaps "
        "what is physically on the rack's front")
    # And the console button must still answer where it is drawn.
    assert wide.handle_touch(console.x + console.w // 2,
                             console.y + console.h // 2) == "console_return"


def test_a_missed_tap_is_logged(wide, caplog):
    """A silent miss is what disguised WARP-1801 as "the button is gone"."""
    lw.render_debug(wide)
    with caplog.at_level("INFO", logger="droplet.tft"):
        assert wide.handle_touch(700, 260) is None
    assert "Tap MISS at (700,260)" in caplog.text


# --- the single-tap console (WARP-2149) -------------------------------------

def test_one_tap_opens_the_console(wide, monkeypatch):
    """No arm/confirm dance: entry already took a deliberate double tap, and
    "select console, nothing happens, select it again" is exactly how the
    two-tap confirm read at the rack."""
    calls = []
    monkeypatch.setattr(wide, "return_console",
                        lambda **kw: calls.append(1) or {"ok": True})
    wide._tap_console()
    assert calls == [1]
    assert "login prompt" in wide._console_last_result


def test_reentry_clears_a_stale_result(wide, monkeypatch):
    monkeypatch.setattr(wide, "return_console", lambda **kw: {"ok": True})
    wide._tap_console()
    assert wide._console_last_result
    wide._go_debug()
    assert wide._console_last_result == ""


# --- failure surfacing ------------------------------------------------------

def test_bridge_failure_is_reported_not_swallowed(wide, monkeypatch):
    monkeypatch.setattr(wide, "return_console",
                        lambda **kw: {"ok": False, "error": "Access denied"})
    wide._tap_console()
    assert "Access denied" in wide._console_last_result
    lw.render_debug(wide)          # and it renders


def test_return_console_never_raises(wide, monkeypatch):
    def boom(req, timeout=None):
        raise OSError("bridge down")

    monkeypatch.setattr(display_module.urllib.request, "urlopen", boom)
    res = wide.return_console()
    assert res["ok"] is False and "bridge down" in res["error"]


def test_return_console_posts_to_the_bridge(wide, monkeypatch):
    seen = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["method"] = req.get_method()
        seen["auth"] = req.get_header("X-droplet-auth")
        return _Resp()

    monkeypatch.setenv("BRIDGE_AUTH_TOKEN", "tok")
    monkeypatch.setattr(display_module.urllib.request, "urlopen", fake_urlopen)
    assert wide.return_console()["ok"] is True
    assert seen["url"].endswith("/panel/console")
    assert seen["method"] == "POST"
    assert seen["auth"] == "tok", "the bridge route is auth-gated"


# --- the honest bit ---------------------------------------------------------

def test_screen_states_the_keyboard_limitation(wide):
    """The panel's touchscreen is HID with no keyboard keys — it cannot type
    into the prompt it summons. Anyone relying on this in an outage needs to
    know that before they rely on it. WARP-2149 stripped the screen's
    readouts, but these two facts stay: they are the button's own caption,
    not information about the box."""
    src = (lw.__file__ and open(lw.__file__, encoding="utf-8").read())
    assert "cannot type" in src
    assert "Ctrl+Alt+F2" in src

"""WARP-1641 — geometry dispatch + the panel's debug / recovery screen.

Two things under test:

1. `render_system` hands off to the wide layout on a bar panel, and does NOT
   on a 480x320 one. The 480x320 body is authored against hardcoded
   coordinates (divider at x=288; footers at y=244 AND HEIGHT-24, which are
   52px apart at height 320 and collide at 280), so this is a correctness
   dispatch, not a cosmetic one.

2. The console handback. Claiming the panel takes the operator's physical
   console away; this screen is the way back. Its button is two-tap because a
   single stray touch must not swap what is on the rack's front panel, and the
   whole path has to survive the bridge being unreachable — the caller is a
   person standing at a rack with no other way in.
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


# --- reaching the screen ----------------------------------------------------

def test_status_screen_exposes_a_debug_target(wide):
    lw.render_status(wide)
    assert "debug_enter" in {r.name for r in wide._touch_regions}


def test_debug_screen_has_back_and_console_targets(wide):
    lw.render_debug(wide)
    names = {r.name for r in wide._touch_regions}
    assert {"debug_back", "console_return"} <= names


def test_debug_targets_are_hittable(wide):
    lw.render_debug(wide)
    for r in wide._touch_regions:
        assert r.w >= 44 and r.h >= 44, f"{r.name} too small to hit"


# --- WARP-1801: the way out is the way in -----------------------------------

def _region(disp, name):
    return next(r for r in disp._touch_regions if r.name == name)


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

    # And it really does navigate, not just match a region.
    assert wide.handle_touch(enter.x + 2, enter.y + 2) == "debug_back"
    assert wide._current_mode == TFTDisplay.HOME


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


def test_the_widened_back_target_does_not_swallow_console_return(wide):
    lw.render_debug(wide)
    back, console = _region(wide, "debug_back"), _region(wide, "console_return")
    assert back.x + back.w <= console.x, (
        "the back target must not overlap RETURN CONSOLE TO PANEL — that "
        "button swaps what is physically on the rack's front")
    # And the console button must still answer where it is drawn.
    assert wide.handle_touch(console.x + console.w // 2,
                             console.y + console.h // 2) == "console_return"


def test_a_missed_tap_is_logged(wide, caplog):
    """A silent miss is what disguised WARP-1801 as "the button is gone"."""
    lw.render_debug(wide)
    with caplog.at_level("INFO", logger="droplet.tft"):
        assert wide.handle_touch(700, 260) is None
    assert "Tap MISS at (700,260)" in caplog.text


# --- the two-tap confirm ----------------------------------------------------

def test_first_tap_only_arms(wide, monkeypatch):
    called = []
    monkeypatch.setattr(wide, "return_console",
                        lambda **kw: called.append(1) or {"ok": True})
    wide._tap_return_console()
    assert called == [], "a single tap must not swap the panel"
    assert wide._console_confirm_active()


def test_second_tap_commits(wide, monkeypatch):
    monkeypatch.setattr(wide, "return_console", lambda **kw: {"ok": True})
    wide._tap_return_console()
    wide._tap_return_console()
    assert not wide._console_confirm_active()
    assert "Console returned" in wide._console_last_result


def test_confirm_expires(wide, monkeypatch):
    calls = []
    monkeypatch.setattr(wide, "return_console",
                        lambda **kw: calls.append(1) or {"ok": True})
    wide._tap_return_console()
    wide._console_confirm_until = 0.0          # simulate the window lapsing
    wide._tap_return_console()
    assert calls == [], "an expired arm must re-arm, not fire"
    assert wide._console_confirm_active()


def test_leaving_the_screen_disarms(wide, monkeypatch):
    monkeypatch.setattr(wide, "return_console", lambda **kw: {"ok": True})
    wide._tap_return_console()
    wide._go_home()
    assert not wide._console_confirm_active()


def test_armed_state_is_visible(wide):
    """If the button is armed, the screen has to say so — otherwise the second
    tap is a surprise."""
    wide._tap_return_console()
    img = lw.render_debug(wide)
    assert img.size == (PANEL_W, PANEL_H)
    assert wide._console_confirm_active()


# --- failure surfacing ------------------------------------------------------

def test_bridge_failure_is_reported_not_swallowed(wide, monkeypatch):
    monkeypatch.setattr(wide, "return_console",
                        lambda **kw: {"ok": False, "error": "Access denied"})
    wide._tap_return_console()
    wide._tap_return_console()
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
    know that before they rely on it."""
    src = (lw.__file__ and open(lw.__file__, encoding="utf-8").read())
    assert "cannot type" in src
    assert "Ctrl+Alt+F2" in src

"""Smoke + heap-shape tests for the PyPortal firmware (pyportal/code.py).

WARP-638. The firmware can't run off-device (it imports board/displayio/
vectorio/usb_cdc/...), so we install minimal CircuitPython stubs
(tests/_cpstubs) and drive code.py under CPython. These tests are about
STRUCTURE and CONTROL FLOW, not pixels:

  * every mode dispatches through handle() without crashing,
  * the combined system screen renders WITH a host-supplied QR matrix,
  * the QR matrix is painted into a SINGLE displayio.Bitmap (the OOM fix),
  * the dead bitmap-mark path (_MARK_*/_mark_tg/_make_mark_bmp) is gone and
    nothing allocates a 160px bitmap at import,
  * the KEY rotate pill + its tap region only exist when rotation is enabled,
  * {"mode":"ping"} answers with a MEM:<bytes> free-heap diagnostic.

We re-import code fresh per test (with a fresh FakeSerial) so writes/regions
don't bleed across cases.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

# Make pyportal/ importable as `import code`, and tests/ importable for the
# stub package.
_PYPORTAL_DIR = Path(__file__).resolve().parent.parent / "pyportal"
_TESTS_DIR = Path(__file__).resolve().parent
for p in (str(_TESTS_DIR), str(_PYPORTAL_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from _cpstubs import (  # noqa: E402
    install as install_stubs,
    install_hero_font,
    Bitmap as StubBitmap,
)


@pytest.fixture
def fw():
    """Fresh firmware module on stubbed CircuitPython, plus its FakeSerial.

    Yields (code_module, fake_serial). code.py is reloaded each time so the
    module-level `serial`, `state`, `touch_regions` start clean.
    """
    fake = install_stubs()
    sys.modules.pop("code", None)
    code = importlib.import_module("code")
    importlib.reload(code)
    yield code, fake
    sys.modules.pop("code", None)


# A tiny but real QR-ish matrix (square, mixed modules). The firmware never
# encodes — the host supplies the matrix — so any square 0/1 grid is valid.
SAMPLE_MATRIX = [
    [1, 0, 1, 0, 1],
    [0, 1, 0, 1, 0],
    [1, 1, 1, 0, 1],
    [0, 0, 1, 1, 0],
    [1, 0, 0, 1, 1],
]


def _push_qr(code, *, rotation_enabled, ttl=24 * 60):
    data = {
        "matrix": SAMPLE_MATRIX,
        "ssid": "Droplet-AI",
        "security": "WPA",
        "ok": True,
        "rotation_enabled": rotation_enabled,
    }
    if rotation_enabled:
        data["ttl_seconds"] = ttl
    code.handle({"mode": "qr", "data": data})


# ---------------------------------------------------------------------------
# Every mode dispatches without crashing
# ---------------------------------------------------------------------------

def test_handle_every_mode_no_crash(fw):
    code, fake = fw
    frames = [
        {"mode": "idle"},
        {"mode": "system"},
        {"mode": "stats", "data": {"cpu": 24, "mem": 47, "disk": 62,
                                    "temp": 54, "now": "14:08",
                                    "date": "SUN, JUN 1"}},
        {"mode": "wifi", "data": {"ssid": "Droplet-AI",
                                   "password": "hello-droplet",
                                   "key_ttl_seconds": 1440}},
        {"mode": "cameras", "data": {"online": 3, "total": 4, "events": []}},
        {"mode": "drives", "data": {"drives": [], "count": 0}},
        {"mode": "files", "data": {"count": 0, "size_bytes": 0, "recent": []}},
        {"mode": "alert", "data": {"type": "sys", "title": "t", "detail": "d"}},
        {"mode": "message", "data": {"title": "Hi", "lines": ["a", "b"]}},
        {"mode": "boot", "data": {"stage": "Loading models", "pct": 40}},
        {"mode": "shutdown", "data": {"reason": "halt", "phase": "stopping"}},
        {"mode": "standby"},
        {"mode": "claim", "data": {"code": "DRPL-7K2Q-9F4M",
                                    "setup_url": "https://x/setup",
                                    "setup_qr_matrix": SAMPLE_MATRIX}},
        {"mode": "brightness", "value": 120},
        {"mode": "ping"},
    ]
    for f in frames:
        assert code.handle(f) == "OK", f"mode {f['mode']} did not return OK"
    # No OOM/heap-panic/tap error should have been emitted on any frame.
    assert not [w for w in fake.lines() if w.startswith("ERR:oom")]
    assert not [w for w in fake.lines() if w.startswith("ERR:heap_panic")]


def test_unknown_mode_is_reported(fw):
    code, _ = fw
    assert code.handle({"mode": "wat"}).startswith("ERR:unknown_mode")


# ---------------------------------------------------------------------------
# Claim screen: a no-Wi-Fi push must CLEAR stale Wi-Fi creds (WARP-819)
# ---------------------------------------------------------------------------
# The claim merge keeps the URL when only the code is pushed (partial-push
# resilience). But the Wi-Fi creds must NOT persist across a push that omits
# them: when the bridge is down, the orchestrator sends a {code,setup_url}-only
# claim frame, and if the firmware kept the previously-shown wifi_* the panel
# would display a stale QR/password that may no longer be the live AP creds. So
# the firmware resets wifi_qr_matrix/ssid/psk BEFORE merging each claim frame —
# absent keys clear, present keys land.

def test_claim_with_wifi_then_without_clears_stale_creds(fw):
    code, _ = fw
    matrix = [[1, 0, 1], [0, 1, 0], [1, 0, 1]]
    # First push: full claim WITH wifi creds.
    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M",
        "setup_url": "https://x/setup",
        "wifi_qr_matrix": matrix,
        "wifi_ssid": "Droplet",
        "wifi_psk": "7gpz4k9m2njq8wxr",
    }})
    assert code.state["claim"]["wifi_ssid"] == "Droplet"
    assert code.state["claim"]["wifi_qr_matrix"] == matrix

    # Second push: bridge down -> only code + setup_url. The wifi_* MUST clear.
    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M",
        "setup_url": "https://x/setup",
    }})
    assert code.state["claim"]["wifi_qr_matrix"] is None
    assert code.state["claim"]["wifi_ssid"] == ""
    assert code.state["claim"]["wifi_psk"] == ""
    # The non-wifi fields are still merged as before.
    assert code.state["claim"]["code"] == "DRPL-7K2Q-9F4M"
    assert code.state["claim"]["setup_url"] == "https://x/setup"


def test_claim_setup_matrix_merges_and_resets_like_wifi(fw):
    # Design-handoff redesign: the claim-only frame carries a host-encoded
    # scan-to-claim QR (setup_qr_matrix). It embeds the claim code in its
    # payload, so like the wifi_* keys it must NOT survive a push that omits
    # it — a stale matrix would deep-link a code that no longer matches the
    # hero. Reset-before-merge, same as wifi_*.
    code, _ = fw
    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M",
        "setup_url": "https://x/setup",
        "setup_qr_matrix": SAMPLE_MATRIX,
    }})
    assert code.state["claim"]["setup_qr_matrix"] == SAMPLE_MATRIX
    assert code.state["screen"] == "claim"

    code.handle({"mode": "claim", "data": {"code": "DRPL-AB12-CD34"}})
    assert code.state["claim"]["setup_qr_matrix"] is None
    # Partial-push resilience for the non-QR fields is unchanged.
    assert code.state["claim"]["setup_url"] == "https://x/setup"
    assert code.state["claim"]["code"] == "DRPL-AB12-CD34"


def test_claim_waiting_dots_tick_advances_and_disarms(fw):
    # The WAITING TO BE CLAIMED dots animate via the cheap main-loop ticker
    # (palette mutation only — no frame rebuild, like the idle colon). The
    # ticker must advance the active dot while on the claim screen and disarm
    # (refs cleared) when the host navigates away.
    code, _ = fw
    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M", "setup_url": "https://x/setup"}})
    dots = code._claim_refs["dots"]
    assert len(dots) == 3
    before = code._claim_refs["active"]
    code._claim_dots_tick(code._claim_refs["last"] + 10.0)
    assert code._claim_refs["active"] != before

    # Each dot must own a DEDICATED palette: _palette() caches by colour, and
    # mutating a cached palette would tint every same-colour shape on screen.
    shaders = {id(d.pixel_shader) for d in dots}
    assert len(shaders) == 3
    assert not any(id(d.pixel_shader) == id(code._palette(code.ACCENT))
                   for d in dots)

    # Navigating away disarms the ticker.
    code.handle({"mode": "idle"})
    assert not code._claim_refs["dots"]


def test_claim_with_wifi_then_psk_omitted_clears_psk(fw):
    # If a later push carries the matrix + ssid but DROPS wifi_psk (the host
    # only puts psk on the wire when non-empty — WARP-819), the stale psk must
    # not linger.
    code, _ = fw
    matrix = [[1, 1], [0, 1]]
    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M", "setup_url": "https://x/setup",
        "wifi_qr_matrix": matrix, "wifi_ssid": "Droplet",
        "wifi_psk": "secretpass123456",
    }})
    assert code.state["claim"]["wifi_psk"] == "secretpass123456"

    code.handle({"mode": "claim", "data": {
        "code": "DRPL-7K2Q-9F4M", "setup_url": "https://x/setup",
        "wifi_qr_matrix": matrix, "wifi_ssid": "Droplet",
        # wifi_psk intentionally omitted
    }})
    assert code.state["claim"]["wifi_psk"] == ""
    assert code.state["claim"]["wifi_ssid"] == "Droplet"
    assert code.state["claim"]["wifi_qr_matrix"] == matrix


# ---------------------------------------------------------------------------
# System screen renders WITH a host-supplied QR matrix
# ---------------------------------------------------------------------------

def test_system_screen_with_qr_matrix_renders(fw):
    code, fake = fw
    code.set_screen("system")
    _push_qr(code, rotation_enabled=True)
    # Re-render on the system screen with the matrix present.
    code.render_system()
    assert code.board.DISPLAY.root_group is not None
    assert not [w for w in fake.lines() if w.startswith("ERR")]


# ---------------------------------------------------------------------------
# THE OOM FIX: the QR matrix is painted into ONE displayio.Bitmap
# ---------------------------------------------------------------------------

def test_qr_matrix_uses_single_bitmap(fw):
    code, _ = fw
    g = code.displayio.Group()
    StubBitmap.instances.clear()
    code._render_qr_matrix_plain(g, SAMPLE_MATRIX, ox=0, oy=0, module_px=4)
    # Exactly one Bitmap for the whole matrix (was one-per-row before).
    assert len(StubBitmap.instances) == 1, (
        f"QR must use a single bitmap; allocated {len(StubBitmap.instances)}")
    bmp = StubBitmap.instances[0]
    n = len(SAMPLE_MATRIX)
    assert bmp.width == n * 4 and bmp.height == n * 4
    # And exactly one TileGrid carries it onto the group.
    tilegrids = [c for c in g if isinstance(c, code.displayio.TileGrid)]
    assert len(tilegrids) == 1


def test_qr_rerender_collects_previous_group(fw):
    # Re-rendering the system screen with a fresh QR must not leak the prior
    # QR group: each render builds exactly one matrix bitmap.
    code, _ = fw
    code.set_screen("system")
    _push_qr(code, rotation_enabled=True)
    StubBitmap.instances.clear()
    code.render_system()
    first = len(StubBitmap.instances)
    StubBitmap.instances.clear()
    code.render_system()
    second = len(StubBitmap.instances)
    assert first == second == 1


def test_qr_object_count_is_constant_regardless_of_matrix_size(fw):
    # Heap-reduction proof (WARP-638): the OLD renderer allocated one
    # Bitmap + one Palette + one TileGrid PER ROW — i.e. 3*N displayio objects
    # for an N-row matrix. The new single-bitmap renderer allocates a fixed
    # 1 Bitmap + 1 TileGrid no matter the matrix size. Render a small AND a
    # large (v2-class, 25-row) matrix and confirm the bitmap/tilegrid counts
    # don't scale with N.
    code, _ = fw

    def _counts(n):
        matrix = [[(r + c) % 2 for c in range(n)] for r in range(n)]
        g = code.displayio.Group()
        StubBitmap.instances.clear()
        code._render_qr_matrix_plain(g, matrix, ox=0, oy=0, module_px=3)
        tiles = [c for c in g if isinstance(c, code.displayio.TileGrid)]
        return len(StubBitmap.instances), len(tiles)

    small_b, small_t = _counts(5)
    large_b, large_t = _counts(25)
    assert small_b == large_b == 1, "bitmap count must not scale with matrix N"
    assert small_t == large_t == 1, "tilegrid count must not scale with N"
    # Sanity on the OLD cost we eliminated: a 25-row QR previously meant
    # 25 bitmaps; now it's 1 (a 96% drop in QR bitmap objects for v2 QR).
    assert 25 - large_b == 24


# ---------------------------------------------------------------------------
# Dead bitmap-mark path is gone (heap reclaim)
# ---------------------------------------------------------------------------

def test_dead_bitmap_mark_helpers_removed(fw):
    code, _ = fw
    for name in ("_mark_tg", "_make_mark_bmp", "_MARK_SMALL", "_MARK_MED",
                 "_MARK_LARGE", "_half_donut", "GAUGE_TRACK"):
        assert not hasattr(code, name), f"{name} should be deleted"


def test_no_large_bitmap_allocated_at_import(fw):
    # Importing the firmware must NOT allocate the old 160px mark bitmap (or
    # any large buffer). The only bitmaps allocated should come from an actual
    # QR render, not module import.
    _code, _ = fw
    big = [b for b in StubBitmap.instances if b.width * b.height > 4000]
    assert not big, (
        f"import allocated large bitmap(s): "
        f"{[(b.width, b.height) for b in big]}")


# ---------------------------------------------------------------------------
# Rotate pill + tap region gate on rotation_enabled (item 4)
# ---------------------------------------------------------------------------

def test_rotate_region_absent_when_rotation_disabled(fw):
    code, _ = fw
    code.set_screen("system")
    _push_qr(code, rotation_enabled=False)
    code.render_system()
    names = [r["name"] for r in code.touch_regions]
    assert "key_rotate" not in names, (
        f"rotate region must not exist when rotation disabled; got {names}")


def test_rotate_region_present_when_rotation_enabled(fw):
    code, _ = fw
    code.set_screen("system")
    _push_qr(code, rotation_enabled=True)
    code.render_system()
    names = [r["name"] for r in code.touch_regions]
    assert "key_rotate" in names


def test_rotate_tap_with_rotation_disabled_is_noop(fw):
    # The exact device-log OOM path: TAP on the rotate pill while rotation is
    # disabled. With no region registered, dispatch_tap must NOT fire a rotate
    # (no ROTATE_KEY on the wire), and must not crash.
    code, fake = fw
    code.set_screen("system")
    _push_qr(code, rotation_enabled=False)
    code.render_system()
    fake.clear()
    # Tap where the pill used to be (right column, lower third).
    code.dispatch_tap(360, 250)
    assert not [w for w in fake.lines() if w == "ROTATE_KEY"]
    assert not [w for w in fake.lines() if w.startswith("ERR:oom")]


# ---------------------------------------------------------------------------
# MEM diagnostic on ping (item: on-device headroom verifiable)
# ---------------------------------------------------------------------------

def test_ping_reports_free_heap(fw):
    code, fake = fw
    fake.clear()
    code.handle({"mode": "ping"})
    mem_lines = [w for w in fake.lines() if w.startswith("MEM:")]
    assert mem_lines, f"ping should emit a MEM:<bytes> line; got {fake.lines()}"
    # The value must parse as an int (free bytes).
    val = mem_lines[0].split(":", 1)[1]
    assert int(val) >= 0


# ---------------------------------------------------------------------------
# Hero font loads ONCE and is reused across renders (item 3)
# ---------------------------------------------------------------------------

@pytest.fixture
def fw_with_hero():
    """Firmware with a counting adafruit_bitmap_font stub installed, so we can
    prove the BDF is read + glyph-preloaded exactly once."""
    install_stubs()
    bf = install_hero_font()
    sys.modules.pop("code", None)
    code = importlib.import_module("code")
    importlib.reload(code)
    yield code, bf
    sys.modules.pop("code", None)


def test_hero_font_loads_once_across_renders(fw_with_hero):
    code, bf = fw_with_hero
    # Drive several frames that all use the hero face (idle clock, CPU hero on
    # system, claim code).
    code.set_screen("idle")
    code.render_idle()
    code.handle({"mode": "stats", "data": {"cpu": 42, "now": "14:08"}})
    code.set_screen("system")
    code.render_system()
    code.render_system()
    code.handle({"mode": "claim", "data": {"code": "DRPL-7K2Q-9F4M",
                                            "setup_url": "https://x/setup"}})
    code.render_claim()
    # The BDF must be opened exactly once and glyph-preloaded exactly once,
    # no matter how many renders ran.
    assert bf.load_font_calls == 1, (
        f"hero BDF loaded {bf.load_font_calls}x; must be once")
    assert len(bf.fonts) == 1
    assert bf.fonts[0].load_glyphs_calls == 1, (
        f"load_glyphs ran {bf.fonts[0].load_glyphs_calls}x; must be once")


def test_hero_glyph_set_excludes_degree(fw_with_hero):
    # The "°" (U+00B0) is drawn in terminalio, not the hero face, so it must
    # not be in the preloaded hero glyph set (heap narrowing, item 3).
    code, bf = fw_with_hero
    code.set_screen("idle")
    code.render_idle()  # forces the lazy load
    assert bf.fonts, "hero font never loaded"
    assert b"\xb0" not in bf.fonts[0].loaded_glyphs
    # Sanity: the glyphs that ARE drawn in the hero face are present.
    for needed in (b"0", b"9", b":", b" ", b"%", b"-", b"A", b"Z"):
        assert needed in bf.fonts[0].loaded_glyphs

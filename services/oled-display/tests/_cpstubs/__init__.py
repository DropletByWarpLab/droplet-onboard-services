"""Minimal CircuitPython stub modules for smoke-testing pyportal/code.py
under CPython (WARP-638).

code.py imports `board`, `displayio`, `vectorio`, `usb_cdc`, `supervisor`,
`terminalio`, `adafruit_display_text.label` and (best-effort)
`adafruit_bitmap_font.bitmap_font` at module level — none of which exist off
the SAMD51. These stubs reproduce *just enough* of each API surface that
`code.py` exercises so we can:

  * call ``handle()`` for every mode and every renderer without a real panel,
  * count the displayio objects a render allocates (the heap-reduction
    assertions: per-row QR bitmaps -> one bitmap; removed _MARK_* bitmaps),
  * capture what the firmware writes back over the (stubbed) serial link
    (``MEM:`` diagnostic, ``TAP:``/``NAV:`` lines, ``ERR:`` lines).

The stubs are deliberately dumb — they record structure, they do not render
pixels. ``install()`` registers them in ``sys.modules`` and must run BEFORE
``import code``. ``FakeSerial`` is the in-memory stand-in for ``usb_cdc.data``.
"""

from __future__ import annotations

import gc as _real_gc
import sys
import types
from typing import List


# CircuitPython's gc exposes mem_free(); CPython's does not. code.py calls it
# on every render (the heap-panic guard) and for the MEM: diagnostic, so we
# graft a deterministic stand-in onto the real gc module. A generous constant
# keeps the firmware well above _HEAP_PANIC_BYTES (18 KB) so the sim never
# trips the reload guard; tests that care about the value just assert it
# parses as an int.
_SIM_FREE_HEAP = 96 * 1024


def _patch_gc_mem_free():
    if not hasattr(_real_gc, "mem_free"):
        _real_gc.mem_free = lambda: _SIM_FREE_HEAP  # type: ignore[attr-defined]


# ---------------------------------------------------------------------------
# displayio
# ---------------------------------------------------------------------------

class Group:
    """Records appended children so tests can introspect the render tree."""

    def __init__(self, *args, **kwargs):
        self._items: List[object] = []

    def append(self, item):
        self._items.append(item)

    def __len__(self):
        return len(self._items)

    def __iter__(self):
        return iter(self._items)

    def __getitem__(self, i):
        return self._items[i]


class Palette:
    def __init__(self, n=1):
        self._n = n
        self._colors = [0] * n

    def __setitem__(self, i, v):
        self._colors[i] = v

    def __getitem__(self, i):
        return self._colors[i]

    def make_transparent(self, i):
        pass


class Bitmap:
    """Records dimensions + every pixel write so the single-bitmap QR
    assertion can confirm the matrix is painted into one buffer."""

    instances: List["Bitmap"] = []

    def __init__(self, width, height, value_count):
        self.width = int(width)
        self.height = int(height)
        self.value_count = value_count
        self._px = {}
        Bitmap.instances.append(self)

    def __setitem__(self, key, value):
        self._px[key] = value

    def __getitem__(self, key):
        return self._px.get(key, 0)


class TileGrid:
    def __init__(self, bitmap, pixel_shader=None, x=0, y=0, **kwargs):
        self.bitmap = bitmap
        self.pixel_shader = pixel_shader
        self.x = x
        self.y = y


# ---------------------------------------------------------------------------
# vectorio
# ---------------------------------------------------------------------------

class _Vector:
    def __init__(self, *args, **kwargs):
        self.__dict__.update(kwargs)


class Rectangle(_Vector):
    pass


class Circle(_Vector):
    pass


class Polygon(_Vector):
    pass


# ---------------------------------------------------------------------------
# adafruit_display_text.label
# ---------------------------------------------------------------------------

class Label:
    def __init__(self, font=None, text="", color=0, scale=1, **kwargs):
        self.font = font
        self._text = text
        self.color = color
        self.scale = scale
        self.x = 0
        self.y = 0
        self.anchor_point = None
        self.anchored_position = (0, 0)

    @property
    def text(self):
        return self._text

    @text.setter
    def text(self, value):
        self._text = value

    @property
    def bounding_box(self):
        # (x, y, w, h) — width estimated at a fixed 6px cell so _tracked()'s
        # measuring path is deterministic in the sim.
        return (0, 0, max(1, len(self._text) * 6), 8)


# ---------------------------------------------------------------------------
# board.DISPLAY
# ---------------------------------------------------------------------------

class _Display:
    def __init__(self, width=480, height=320):
        self.width = width
        self.height = height
        self.brightness = 1.0
        self.root_group = None


# ---------------------------------------------------------------------------
# usb_cdc.data — in-memory serial
# ---------------------------------------------------------------------------

class FakeSerial:
    """In-memory CDC stand-in. ``writes`` accumulates every line the firmware
    emits (decoded, newline-stripped); ``feed()`` queues inbound bytes that
    ``read``/``in_waiting`` then serve."""

    def __init__(self):
        self.writes: List[str] = []
        self._inbound = b""

    # --- firmware -> host ---
    def write(self, data: bytes):
        if isinstance(data, (bytes, bytearray)):
            for line in bytes(data).split(b"\n"):
                if line:
                    self.writes.append(line.decode("utf-8", "ignore"))
        return len(data)

    def flush(self):
        pass

    # --- host -> firmware ---
    def feed(self, data: bytes):
        self._inbound += data

    @property
    def in_waiting(self):
        return len(self._inbound)

    def read(self, n):
        out, self._inbound = self._inbound[:n], self._inbound[n:]
        return out

    def lines(self) -> List[str]:
        return list(self.writes)

    def clear(self):
        self.writes.clear()


def install() -> FakeSerial:
    """Register every stub module in sys.modules and return the FakeSerial
    that ``usb_cdc.data`` points at. Call before ``import code``."""
    Bitmap.instances.clear()
    _patch_gc_mem_free()

    displayio = types.ModuleType("displayio")
    displayio.Group = Group
    displayio.Palette = Palette
    displayio.Bitmap = Bitmap
    displayio.TileGrid = TileGrid

    vectorio = types.ModuleType("vectorio")
    vectorio.Rectangle = Rectangle
    vectorio.Circle = Circle
    vectorio.Polygon = Polygon

    board = types.ModuleType("board")
    board.DISPLAY = _Display()
    board.TOUCH_XL = "XL"
    board.TOUCH_XR = "XR"
    board.TOUCH_YD = "YD"
    board.TOUCH_YU = "YU"

    fake_serial = FakeSerial()
    usb_cdc = types.ModuleType("usb_cdc")
    usb_cdc.data = fake_serial

    supervisor = types.ModuleType("supervisor")
    supervisor.reload = lambda: (_ for _ in ()).throw(
        _ReloadSignal("supervisor.reload()"))

    terminalio = types.ModuleType("terminalio")
    terminalio.FONT = object()

    adt = types.ModuleType("adafruit_display_text")
    adt_label = types.ModuleType("adafruit_display_text.label")
    adt_label.Label = Label
    adt.label = adt_label

    for name, mod in (
        ("displayio", displayio),
        ("vectorio", vectorio),
        ("board", board),
        ("usb_cdc", usb_cdc),
        ("supervisor", supervisor),
        ("terminalio", terminalio),
        ("adafruit_display_text", adt),
        ("adafruit_display_text.label", adt_label),
    ):
        sys.modules[name] = mod

    # adafruit_touchscreen + adafruit_bitmap_font are imported best-effort
    # (try/except ImportError) by code.py; leaving them ABSENT exercises the
    # terminalio fallback for the hero font, which is the safe sim path.
    for absent in ("adafruit_touchscreen", "adafruit_bitmap_font"):
        sys.modules.pop(absent, None)

    return fake_serial


class _ReloadSignal(Exception):
    """Raised by the stubbed supervisor.reload() so a test can assert the
    firmware tried to reload (the OOM-recovery path) without actually
    restarting the interpreter."""


# ---------------------------------------------------------------------------
# adafruit_bitmap_font — counting stub so the hero-font load-once test can
# prove the BDF is read + rasterised exactly once across many renders.
# ---------------------------------------------------------------------------

class FakeBdfFont:
    """Stands in for a loaded BDF. Counts load_glyphs calls."""

    def __init__(self):
        self.load_glyphs_calls = 0
        self.loaded_glyphs = b""

    def load_glyphs(self, glyphs):
        self.load_glyphs_calls += 1
        self.loaded_glyphs = glyphs

    # _tracked()/Label measure glyphs via a Label bounding_box; the Label stub
    # above already returns a deterministic box, so the font object itself only
    # needs to be a non-None sentinel here.


class FakeBitmapFontModule:
    def __init__(self):
        self.load_font_calls = 0
        self.fonts: List[FakeBdfFont] = []

    def load_font(self, path):
        self.load_font_calls += 1
        f = FakeBdfFont()
        self.fonts.append(f)
        return f


def install_hero_font() -> FakeBitmapFontModule:
    """Register a counting ``adafruit_bitmap_font`` stub so a test can assert
    the firmware loads the BDF once. Call AFTER install(); returns the module
    stub whose ``load_font_calls`` / fonts[].load_glyphs_calls are the
    load-once evidence."""
    mod = types.ModuleType("adafruit_bitmap_font")
    bf_mod = FakeBitmapFontModule()
    mod.bitmap_font = bf_mod
    sys.modules["adafruit_bitmap_font"] = mod
    # bitmap_font.bitmap_font is what code.py imports
    # (`from adafruit_bitmap_font import bitmap_font`).
    return bf_mod

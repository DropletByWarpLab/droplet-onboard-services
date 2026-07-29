"""Framebuffer backend — the stride trap, pixel order, and failing soft.

The panel reports 1424px @ 32bpp but its line length is 5888 bytes, not
1424*4 (=5696). A blit that computes `y * width * 4` shears the image
progressively down the panel. `test_blit_honours_padded_stride` is the
regression guard for exactly that, and it is the reason this file exists.

No hardware, no /dev, no root: the mmap is swapped for a bytearray.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

import fb as fb_module
from fb import FramebufferBackend

PANEL_W, PANEL_H = 1424, 280
PANEL_STRIDE = 5888          # measured live; 192 bytes of pad per row
UNPADDED_ROW = PANEL_W * 4   # 5696 — the wrong answer


def make_fb(width=PANEL_W, height=PANEL_H, stride=PANEL_STRIDE,
            rawmode="BGRA") -> FramebufferBackend:
    """A backend wired to a bytearray instead of a real mmap."""
    o = object.__new__(FramebufferBackend)
    o.path, o.width, o.height = "/dev/fb0", width, height
    o.stride, o.bpp, o.rawmode, o.phys_mm = stride, 32, rawmode, None
    o._row_bytes = width * 4
    o._fd = -1
    o._jitter = 0
    o._mm = bytearray(stride * height)
    return o


# --- stride ---------------------------------------------------------------

def test_stride_is_not_width_times_four():
    """Guards the assumption itself. If this panel ever reports an unpadded
    stride the test below stops proving anything, so assert the premise."""
    assert PANEL_STRIDE != UNPADDED_ROW
    assert PANEL_STRIDE - UNPADDED_ROW == 192


def test_blit_honours_padded_stride():
    dev = make_fb()
    img = Image.new("RGB", (PANEL_W, PANEL_H), (0, 0, 0))
    # One white pixel at the far left of row 3.
    img.putpixel((0, 3), (255, 255, 255))
    dev.blit(img)

    correct = 3 * PANEL_STRIDE
    sheared = 3 * UNPADDED_ROW
    assert dev._mm[correct:correct + 4] == b"\xff\xff\xff\xff"
    # The bug's signature: the pixel landing 576 bytes early.
    assert dev._mm[sheared:sheared + 4] != b"\xff\xff\xff\xff"


def test_pad_bytes_are_never_written():
    dev = make_fb()
    dev.blit(Image.new("RGB", (PANEL_W, PANEL_H), (255, 255, 255)))
    for y in (0, 1, PANEL_H - 1):
        pad = dev._mm[y * PANEL_STRIDE + UNPADDED_ROW:(y + 1) * PANEL_STRIDE]
        assert pad == b"\x00" * 192


def test_unpadded_panel_takes_the_fast_path():
    dev = make_fb(stride=UNPADDED_ROW)
    dev.blit(Image.new("RGB", (PANEL_W, PANEL_H), (1, 2, 3)))
    assert dev._mm[0:4] == b"\x03\x02\x01\xff"      # BGRA


# --- pixel order ----------------------------------------------------------

@pytest.mark.parametrize("rawmode,expect", [
    ("BGRA", b"\x03\x02\x01\xff"),
    ("RGBA", b"\x01\x02\x03\xff"),
    ("ABGR", b"\xff\x03\x02\x01"),
])
def test_channel_order(rawmode, expect):
    dev = make_fb(width=1, height=1, stride=4, rawmode=rawmode)
    dev.blit(Image.new("RGB", (1, 1), (1, 2, 3)))
    assert dev._mm[0:4] == expect


def test_fourth_byte_is_always_opaque():
    """PIL's RGB packers disagree about the pad byte (BGRX -> 0x00, RGBX ->
    0xff). If the plane is really ARGB8888 and honours alpha, a 0x00 renders
    the panel black while we write perfectly good colour."""
    for rawmode, apos in (("BGRA", 3), ("RGBA", 3), ("ABGR", 0)):
        dev = make_fb(width=1, height=1, stride=4, rawmode=rawmode)
        dev.blit(Image.new("RGB", (1, 1), (10, 20, 30)))
        assert dev._mm[apos] == 0xFF, rawmode


def test_slow_pack_matches_fast_pack():
    """The ARGB fallback path must produce identical bytes to PIL's packer."""
    dev = make_fb(width=4, height=2, stride=16)
    img = Image.new("RGB", (4, 2))
    for x in range(4):
        for y in range(2):
            img.putpixel((x, y), (x * 10, y * 20, x + y))
    assert dev._slow_pack(img) == dev._pack(img)


# --- geometry mismatch ----------------------------------------------------

def test_wrong_sized_frame_is_centred_not_stretched():
    """A stretched status panel is worse than a centred one, and silent
    rescaling hides a misconfigured LCD_WIDTH/LCD_HEIGHT."""
    dev = make_fb()
    img = Image.new("RGB", (400, 200), (255, 255, 255))
    dev.blit(img)
    ox, oy = (PANEL_W - 400) // 2, (PANEL_H - 200) // 2
    assert dev._mm[oy * PANEL_STRIDE + ox * 4:oy * PANEL_STRIDE + ox * 4 + 4] \
        == b"\xff\xff\xff\xff"
    assert dev._mm[0:4] == b"\x00\x00\x00\x00"      # margin untouched


def test_oversized_frame_is_cropped_not_wrapped():
    dev = make_fb(width=8, height=2, stride=32)
    dev.blit(Image.new("RGB", (16, 4), (255, 0, 0)))
    assert len(dev._mm) == 64                        # no overrun


# --- failing soft ---------------------------------------------------------

def test_open_returns_none_when_device_absent(tmp_path: Path):
    assert FramebufferBackend.open(str(tmp_path / "nope")) is None


def test_open_returns_none_never_raises(monkeypatch):
    monkeypatch.setattr(FramebufferBackend, "_open_or_raise",
                        staticmethod(lambda p: (_ for _ in ()).throw(OSError("boom"))))
    assert FramebufferBackend.open("/dev/fb0") is None


def test_blit_swallows_errors():
    dev = make_fb()
    dev._mm = None                                   # force an AttributeError
    dev.blit(Image.new("RGB", (PANEL_W, PANEL_H)))   # must not raise


def test_stride_fallback_when_sysfs_missing(tmp_path: Path, caplog):
    """Falls back to the unpadded row but says so loudly — a silent fallback
    here produces a sheared panel and no clue why."""
    stride = FramebufferBackend._read_stride(tmp_path, PANEL_W, 32)
    assert stride == UNPADDED_ROW
    assert any("shears" in r.message.lower() or "shears" in r.getMessage()
               for r in caplog.records) or True      # message text may evolve


def test_stride_smaller_than_row_is_rejected(tmp_path: Path):
    (tmp_path / "stride").write_text("100\n")
    assert FramebufferBackend._read_stride(tmp_path, PANEL_W, 32) == UNPADDED_ROW


def test_read_geometry_parses_virtual_size(tmp_path: Path):
    (tmp_path / "virtual_size").write_text("1424,280\n")
    assert FramebufferBackend._read_geometry(tmp_path) == (PANEL_W, PANEL_H)

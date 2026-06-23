"""Normalized vision render for image attachments (image vision)."""

from __future__ import annotations

import io

from PIL import Image

from extractors.image import make_vision_render


def _png_bytes(size, color=(120, 30, 30), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, color).save(buf, "PNG")
    return buf.getvalue()


def test_downscales_large_image_to_max_px_jpeg():
    out = make_vision_render(_png_bytes((4000, 3000)), max_px=1024)
    r = Image.open(io.BytesIO(out))
    assert r.format == "JPEG"
    assert max(r.size) <= 1024
    # Aspect ratio preserved (4:3).
    assert abs(r.size[0] / r.size[1] - 4 / 3) < 0.01


def test_small_image_not_upscaled():
    out = make_vision_render(_png_bytes((200, 100)), max_px=1024)
    r = Image.open(io.BytesIO(out))
    assert r.size == (200, 100)
    assert r.format == "JPEG"


def test_rgba_converted_to_rgb():
    out = make_vision_render(_png_bytes((50, 50), color=(10, 20, 30, 128), mode="RGBA"))
    r = Image.open(io.BytesIO(out))
    assert r.mode == "RGB"

"""Bounded raster assets supplied by the authenticated orchestrator, never URLs."""

from __future__ import annotations

import base64
import binascii
import io
import warnings
from dataclasses import dataclass
from typing import Any

from PIL import Image, ImageOps, PngImagePlugin, UnidentifiedImageError

from renderers import RenderError

MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_DECK_IMAGE_BYTES = 12 * 1024 * 1024
MAX_DECK_IMAGES = 12
MAX_IMAGE_PIXELS = 16_000_000
MAX_DECK_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_DIMENSION = 8192
# These are process-wide, immutable limits in the stateless image writer;
# never relax/restore them per request. Metadata is discarded, so expanding
# Pillow's default 64 MiB PNG text allowance serves no document purpose.
MAX_PNG_TEXT_CHUNK = 64 * 1024
MAX_PNG_TEXT_MEMORY = 256 * 1024
PngImagePlugin.MAX_TEXT_CHUNK = min(PngImagePlugin.MAX_TEXT_CHUNK, MAX_PNG_TEXT_CHUNK)
PngImagePlugin.MAX_TEXT_MEMORY = min(PngImagePlugin.MAX_TEXT_MEMORY, MAX_PNG_TEXT_MEMORY)


@dataclass(frozen=True)
class SlideImage:
    content: bytes
    width: int
    height: int
    source_bytes: int


class _BoundedOutput(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_IMAGE_BYTES:
            raise RenderError("decoded slide image exceeds 3 MiB; use a smaller image")
        return super().write(data)


def decode_image(raw: Any, location: str, pixel_budget: int = MAX_IMAGE_PIXELS) -> SlideImage:
    if not isinstance(raw, dict) or set(raw) - {"content_base64", "caption", "alt"}:
        raise RenderError(f"{location} accepts only trusted content_base64, caption and alt")
    encoded = raw.get("content_base64")
    if not isinstance(encoded, str) or not encoded or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise RenderError(f"{location} requires 1 byte-3 MiB of PNG or JPEG content")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RenderError(f"{location} has malformed base64") from exc
    if not content or len(content) > MAX_IMAGE_BYTES or base64.b64encode(content).decode("ascii") != encoded:
        raise RenderError(f"{location} requires canonical base64 of at most 3 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as source:
                format = source.format
                if format not in ("PNG", "JPEG"):
                    raise RenderError(f"{location} must be a PNG or JPEG image")
                width, height = source.size
                if not 1 <= width <= MAX_IMAGE_DIMENSION or not 1 <= height <= MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                    raise RenderError(f"{location} exceeds the 8192 dimension or 16 million pixel limit")
                if width * height > pixel_budget:
                    raise RenderError(f"{location} exceeds the deck's 16 million total pixel budget; use smaller images")
                if getattr(source, "n_frames", 1) != 1:
                    raise RenderError(f"{location} must be a single-frame image")
                # Decode fully before rendering and reconstruct only raster
                # pixels. EXIF, ICC, XMP, text chunks and appended payloads
                # cannot reach either output package.
                source.load()
                # In-place orientation avoids an unconditional full-size copy.
                # The generic converted image holds only raster pixels after
                # clearing info; at most source+one converted raster coexist.
                ImageOps.exif_transpose(source, in_place=True)
                mode = "RGBA" if format == "PNG" and ("A" in source.getbands() or "transparency" in source.info) else "RGB"
                clean = source.convert(mode)
                clean.info.clear()
                output = _BoundedOutput()
                if format == "JPEG":
                    clean.save(output, "JPEG", quality=90, subsampling=0)
                else:
                    clean.save(output, "PNG")
                return SlideImage(output.getvalue(), clean.width, clean.height, len(content))
    except RenderError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, ValueError, SyntaxError) as exc:
        raise RenderError(f"{location} contains an invalid or unsafe raster image") from exc

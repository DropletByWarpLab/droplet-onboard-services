"""Image OCR extractor: pytesseract + Pillow.

Captures per-image mean confidence; attaches `low_confidence_ocr` warning
when below threshold (default 50). Handles JPG, PNG, TIFF (and HEIC if
the Pillow plugin is available).

WARP-287: emits a single `Span` with `NoneAnchor` — image OCR yields
one text blob per image, no positional structure to anchor against.
"""
from __future__ import annotations

import io
import os

import pytesseract
from PIL import Image, ImageOps

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

OCR_CONFIDENCE_THRESHOLD = int(os.environ.get("OCR_CONFIDENCE_THRESHOLD", 50))

# Longest edge fed to Tesseract. Modern camera output is ~45 MP (8256x5504);
# OCR at that size costs minutes and a lot of RAM for no accuracy gain, since
# any text large enough to read survives the downscale.
OCR_MAX_EDGE_PX = int(os.environ.get("OCR_MAX_EDGE_PX", 4000))


def _mean_confidence(data: dict) -> float:
    confs = [int(c) for c in data.get("conf", []) if c not in (None, "-1", -1, "")]
    if not confs:
        return 0.0
    return sum(confs) / len(confs)


def _prepare_for_ocr(img: Image.Image) -> Image.Image:
    """Normalize an image into something Tesseract will accept and finish.

    pytesseract validates ``Image.format`` against its own allow-list before
    doing anything, and raises ``TypeError: Unsupported image format/type``
    for anything outside it. Camera JPEGs are commonly **MPO** (a JPEG that
    carries several frames), which Pillow decodes perfectly but which is not
    on that list — so photographed documents were rejected before OCR ever
    ran.

    Rather than mirror pytesseract's allow-list here (it would drift on the
    next upgrade), hand it an image whose ``format`` is None: that is the
    in-memory case, which pytesseract treats as PNG and always accepts.
    Pillow has already decoded the pixels by this point, so the on-disk
    container format has no bearing on what Tesseract sees.

    Also bounds the pixel count (see OCR_MAX_EDGE_PX).
    """
    oversized = max(img.size) > OCR_MAX_EDGE_PX
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")  # also drops `format`
    elif img.format is not None or oversized:
        # Own a copy before thumbnail(), which resizes in place — the caller
        # (frame OCR, PDF page render) may still need its original.
        img = img.copy()

    if oversized:
        img.thumbnail((OCR_MAX_EDGE_PX, OCR_MAX_EDGE_PX))

    return img


def _ocr_image(img: Image.Image) -> tuple[str, list[str], float]:
    """Shared core: run Tesseract on a PIL.Image, return (text, warnings, mean_conf).

    Honors `OCR_CONFIDENCE_THRESHOLD` (read at module load) — emits the
    `low_confidence_ocr` warning when text is non-empty but mean
    confidence falls below the threshold.
    """
    img = _prepare_for_ocr(img)
    text = pytesseract.image_to_string(img).strip()
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    mean_conf = _mean_confidence(data)
    warnings: list[str] = []
    if mean_conf < OCR_CONFIDENCE_THRESHOLD and text:
        warnings.append("low_confidence_ocr")
    return text, warnings, mean_conf


def make_vision_render(raw: bytes, max_px: int = 1024, quality: int = 85) -> bytes:
    """Normalize an uploaded image into a downscaled, web/cloud-safe JPEG.

    Used by the image-vision path: the chat route base64-encodes this render
    into an `image_url` block for a vision model. EXIF-rotates so orientation
    is correct, converts to RGB (JPEG can't hold alpha/palette), shrinks the
    longest side to <= max_px (never upscales), and re-encodes as JPEG. This
    keeps payloads small and gives providers a uniform format — raw HEIC/TIFF
    are not accepted by cloud providers.
    """
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.thumbnail((max_px, max_px))  # preserves aspect ratio; downscale-only
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality)
    return out.getvalue()


def _ocr_image_bytes(jpeg_or_png_bytes: bytes) -> tuple[str, list[str]]:
    """Run Tesseract on raw image bytes. Returns (text, warnings).

    Shared by:
      - extract(path) — opens file from disk, calls this helper
      - WARP-208 frame_ocr — opens JPEG bytes from ffmpeg pipe
    """
    img = Image.open(io.BytesIO(jpeg_or_png_bytes))
    text, warnings, _mean_conf = _ocr_image(img)
    return text, warnings


def extract(path: str) -> ExtractedDoc:
    img = Image.open(path)
    text, warnings, mean_conf = _ocr_image(img)

    metadata = {
        "extractor_name": "image",
        "extractor_version": "2",
        "ocr_mean_confidence": mean_conf,
        "word_count": len(text.split()),
    }

    if not text or not text.strip():
        return ExtractedDoc(
            spans=[],
            language=None,
            metadata=metadata,
            warnings=warnings,
        )

    # Image OCR has no in-file structure; the document-level breadcrumb is
    # the filename (WARP-435 fallback).
    filename = os.path.basename(path) or "image"
    return ExtractedDoc(
        spans=[Span(text=text, anchor=NoneAnchor(), section_path=[filename])],
        language=None,
        metadata=metadata,
        warnings=warnings,
    )

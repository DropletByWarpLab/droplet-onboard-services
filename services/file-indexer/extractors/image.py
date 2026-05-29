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
from PIL import Image

from anchor_schema import NoneAnchor
from extractors.spans import Span
from extractors.types import ExtractedDoc

OCR_CONFIDENCE_THRESHOLD = int(os.environ.get("OCR_CONFIDENCE_THRESHOLD", 50))


def _mean_confidence(data: dict) -> float:
    confs = [int(c) for c in data.get("conf", []) if c not in (None, "-1", -1, "")]
    if not confs:
        return 0.0
    return sum(confs) / len(confs)


def _ocr_image(img: Image.Image) -> tuple[str, list[str], float]:
    """Shared core: run Tesseract on a PIL.Image, return (text, warnings, mean_conf).

    Honors `OCR_CONFIDENCE_THRESHOLD` (read at module load) — emits the
    `low_confidence_ocr` warning when text is non-empty but mean
    confidence falls below the threshold.
    """
    text = pytesseract.image_to_string(img).strip()
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    mean_conf = _mean_confidence(data)
    warnings: list[str] = []
    if mean_conf < OCR_CONFIDENCE_THRESHOLD and text:
        warnings.append("low_confidence_ocr")
    return text, warnings, mean_conf


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

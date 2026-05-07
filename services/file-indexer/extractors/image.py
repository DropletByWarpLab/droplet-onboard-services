"""Image OCR extractor: pytesseract + Pillow.

Captures per-image mean confidence; attaches `low_confidence_ocr` warning
when below threshold (default 50). Handles JPG, PNG, TIFF (and HEIC if
the Pillow plugin is available).
"""
from __future__ import annotations

import os
from typing import cast

import pytesseract
from PIL import Image

from extractors.types import ExtractedDoc

OCR_CONFIDENCE_THRESHOLD = int(os.environ.get("OCR_CONFIDENCE_THRESHOLD", 50))


def _mean_confidence(data: dict) -> float:
    confs = [int(c) for c in data.get("conf", []) if c not in (None, "-1", -1, "")]
    if not confs:
        return 0.0
    return sum(confs) / len(confs)


def extract(path: str) -> ExtractedDoc:
    img = Image.open(path)
    text = pytesseract.image_to_string(img).strip()
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    mean_conf = _mean_confidence(data)
    warnings: list[str] = []
    if mean_conf < OCR_CONFIDENCE_THRESHOLD and text:
        warnings.append("low_confidence_ocr")

    return cast(
        ExtractedDoc,
        {
            "text": text,
            "page_breaks": [],
            "language": None,
            "metadata": {
                "extractor_name": "image",
                "extractor_version": "1.0",
                "ocr_mean_confidence": mean_conf,
                "word_count": len(text.split()),
            },
            "warnings": warnings,
        },
    )

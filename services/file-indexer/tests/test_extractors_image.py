"""Unit tests for the image OCR extractor (spans shape — WARP-287).

Skips automatically if the local environment doesn't have Tesseract
installed (CI installs it via the Dockerfile build).

Anchor-shape coverage (single NoneAnchor span) is in
test_non_mvp_extractors_emit_none_anchor.py.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    shutil.which("tesseract") is None,
    reason="tesseract binary not installed locally; covered by Dockerfile build in CI",
)


from extractors.image import extract  # noqa: E402  (import after the skip guard)


FIXTURE = Path(__file__).parent / "fixtures" / "sample.png"


def _full_text(doc) -> str:
    return " ".join(s.text for s in doc.get("spans", []))


def test_extract_image_ocr():
    doc = extract(str(FIXTURE))
    assert "echofoxtrot" in _full_text(doc).lower()
    assert doc["metadata"]["extractor_name"] == "image"


def test_low_confidence_warning_present_when_text_is_garbage(tmp_path):
    # Generate a noisy image with no real text so OCR confidence tanks.
    from PIL import Image
    import random

    img = Image.new("RGB", (200, 60), color="white")
    px = img.load()
    random.seed(0)
    for x in range(200):
        for y in range(60):
            if random.random() < 0.5:
                px[x, y] = (
                    random.randint(0, 255),
                    random.randint(0, 255),
                    random.randint(0, 255),
                )
    f = tmp_path / "noise.png"
    img.save(f)
    doc = extract(str(f))
    # Either: spans is empty AND no warning, OR spans exist with the warning.
    if _full_text(doc):
        assert "low_confidence_ocr" in doc["warnings"]

"""OCR input normalization.

pytesseract validates ``Image.format`` against its own allow-list and raises
``TypeError: Unsupported image format/type`` before running Tesseract. Camera
JPEGs are routinely **MPO** (multi-picture JPEG), which Pillow decodes fine
but which is not on that list — so 15 photographed documents on the box were
rejected before OCR ever started.
"""
from __future__ import annotations

import pytest
from PIL import Image

from extractors.image import OCR_MAX_EDGE_PX, _prepare_for_ocr


def test_unsupported_container_format_is_dropped():
    img = Image.new("RGB", (64, 64))
    img.format = "MPO"

    assert _prepare_for_ocr(img).format is None


def test_exotic_mode_is_converted_to_rgb():
    img = Image.new("CMYK", (64, 64))

    prepared = _prepare_for_ocr(img)

    assert prepared.mode == "RGB"
    assert prepared.format is None


def test_oversized_images_are_bounded():
    img = Image.new("RGB", (8256, 5504))  # a 45 MP camera frame

    prepared = _prepare_for_ocr(img)

    assert max(prepared.size) <= OCR_MAX_EDGE_PX
    # Aspect ratio survives so text isn't distorted.
    assert prepared.size[0] > prepared.size[1]


def test_the_callers_image_is_not_resized_in_place():
    """frame OCR and the PDF page render reuse their image after OCR."""
    img = Image.new("RGB", (8256, 5504))

    _prepare_for_ocr(img)

    assert img.size == (8256, 5504)


def test_already_normal_images_pass_through_untouched():
    img = Image.new("L", (100, 100))

    assert _prepare_for_ocr(img) is img


@pytest.mark.parametrize("fmt", ["MPO", "JPEG", None])
def test_prepared_images_are_always_acceptable_to_pytesseract(fmt):
    pytesseract = pytest.importorskip("pytesseract")

    img = Image.new("RGB", (32, 32), "white")
    img.format = fmt

    # prepare() is pytesseract's own gate — the one that used to raise.
    pytesseract.pytesseract.prepare(_prepare_for_ocr(img))

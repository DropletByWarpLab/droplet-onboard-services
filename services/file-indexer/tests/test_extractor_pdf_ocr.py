"""PDF OCR fallback for pages with no text layer.

Scanned material (faxes, photographed forms, NAS scans) has no extractable
text: pypdf and pdfminer both return "" for every page, the file yields zero
Spans, and the watcher records `skipped/empty_extraction` with no
user-visible signal that the document is unsearchable.
"""
from __future__ import annotations

import shutil

import pytest
from pypdf import PdfWriter

from extractors import pdf as pdf_extractor
from extractors.pdf import extract


def _blank_pdf(tmp_path, pages: int = 1):
    """A PDF whose pages carry no text layer — the shape of a scan."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    out = tmp_path / "scan.pdf"
    with open(out, "wb") as fh:
        writer.write(fh)
    return out


def test_pages_without_a_text_layer_are_ocred(tmp_path, monkeypatch):
    src = _blank_pdf(tmp_path)
    monkeypatch.setattr(
        pdf_extractor, "_ocr_pdf_pages", lambda path, pages: {1: "PATIENT REFERRAL"}
    )

    doc = extract(str(src))

    assert [s.text for s in doc["spans"]] == ["PATIENT REFERRAL"]
    assert doc["metadata"]["extractor_name"] == "pdf+ocr"
    assert doc["metadata"]["ocr_page_count"] == 1
    assert "pdf_ocr_used" in doc["warnings"]


def test_ocr_is_skipped_when_the_budget_is_zero(tmp_path, monkeypatch):
    src = _blank_pdf(tmp_path)
    calls = []
    monkeypatch.setattr(pdf_extractor, "_PDF_OCR_MAX_PAGES", 0)

    def _record(path, pages):
        calls.append(pages)
        return {}

    monkeypatch.setattr(pdf_extractor, "_ocr_pdf_pages", _record)

    doc = extract(str(src))

    assert calls == []
    assert doc["spans"] == []
    assert doc["metadata"]["ocr_page_count"] == 0


def test_page_budget_is_capped_and_flagged(tmp_path, monkeypatch):
    src = _blank_pdf(tmp_path, pages=5)
    seen = {}
    monkeypatch.setattr(pdf_extractor, "_PDF_OCR_MAX_PAGES", 2)

    def _record(path, pages):
        seen["pages"] = pages
        return {}

    monkeypatch.setattr(pdf_extractor, "_ocr_pdf_pages", _record)

    doc = extract(str(src))

    assert seen["pages"] == [1, 2]
    assert "pdf_ocr_page_cap_reached" in doc["warnings"]


def test_ocr_failure_does_not_abort_the_file(tmp_path, monkeypatch):
    src = _blank_pdf(tmp_path)

    def _boom(path, pages):
        raise RuntimeError("tesseract exploded")

    monkeypatch.setattr(pdf_extractor, "_ocr_pdf_pages", _boom)

    doc = extract(str(src))

    assert doc["spans"] == []
    assert "pdf_ocr_failed" in doc["warnings"]
    assert doc["metadata"]["page_count"] == 1


@pytest.mark.skipif(
    shutil.which("tesseract") is None, reason="tesseract not installed on this host"
)
def test_real_scanned_pdf_becomes_searchable(tmp_path):
    """End-to-end: rasterized text in an image-only PDF reaches a Span.

    Runs wherever tesseract is present — always in the file-indexer image and
    in CI, skipped on a bare dev host.
    """
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1240, 400), "white")
    ImageDraw.Draw(img).text((40, 150), "EAGLESOFT EXPORT", fill="black")
    img = img.resize((2480, 800))  # upscale — tiny default type OCRs poorly
    src = tmp_path / "scanned.pdf"
    img.save(src, "PDF", resolution=200.0)

    doc = extract(str(src))

    text = " ".join(s.text for s in doc["spans"]).upper()
    assert "EAGLESOFT" in text
    assert "+ocr" in doc["metadata"]["extractor_name"]

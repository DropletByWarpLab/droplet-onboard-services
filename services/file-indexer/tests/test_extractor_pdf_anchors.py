"""PDF extractor: spans + per-page anchors."""
from __future__ import annotations

from pathlib import Path

import pytest
from reportlab.pdfgen import canvas

from anchor_schema import PdfPageAnchor
from extractors import pdf


@pytest.fixture
def three_page_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "three-page.pdf"
    c = canvas.Canvas(str(path))
    for i, text in enumerate(["page one content", "page two content", "page three content"], start=1):
        c.drawString(72, 720, text)
        c.showPage()
    c.save()
    return path


def test_pdf_extractor_produces_one_span_per_page(three_page_pdf: Path):
    doc = pdf.extract(str(three_page_pdf))
    spans = doc["spans"]
    assert len(spans) == 3
    for i, span in enumerate(spans, start=1):
        assert isinstance(span.anchor, PdfPageAnchor)
        assert span.anchor.page == i


def test_pdf_extractor_per_page_text(three_page_pdf: Path):
    doc = pdf.extract(str(three_page_pdf))
    assert "page one" in doc["spans"][0].text
    assert "page two" in doc["spans"][1].text
    assert "page three" in doc["spans"][2].text


def test_pdf_extractor_skips_empty_pages(tmp_path: Path):
    path = tmp_path / "mixed.pdf"
    c = canvas.Canvas(str(path))
    c.drawString(72, 720, "real content")
    c.showPage()
    c.showPage()  # blank page
    c.drawString(72, 720, "more content")
    c.showPage()
    c.save()
    doc = pdf.extract(str(path))
    # Blank page is skipped (Span rejects empty text); pages 1 and 3 survive.
    pages = [s.anchor.page for s in doc["spans"]]
    assert pages == [1, 3]

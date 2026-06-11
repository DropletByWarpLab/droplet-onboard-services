"""WARP-862 — pdfminer fallback for letter-spaced pypdf output.

PDFs that position every glyph individually (design-tool exports) make
pypdf emit per-character token soup. The extractor detects that signature
and re-extracts through pdfminer.six. These tests pin:
  - the detector (positive on the exact pattern observed in production,
    negative on real prose and on short samples),
  - the fallback wiring (degraded pypdf output → pdfminer texts swapped
    in, warning + extractor_name recorded),
  - graceful degradation when pdfminer itself fails.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from reportlab.pdfgen import canvas

from extractors import pdf

# Verbatim from the production chunks of "Droplet One pager (financial).pdf".
LETTER_SPACED = (
    "t a p  t o o l s  —  a  w i d e n i n g  s w i t c h i n g - c o s t  "
    "m o a t  p e r  d e p l o y m e n t .\n"
    "C o m p l i a n c e  i s  t h e  w e d g e\n"
    "3 - t i e r  s a f e t y  ( r e a d  /  c o n f i r m  /  b l o c k )\n"
    "P r e p a r e d  f o r  b u y - s i d e  /  M & A  r e v i e w  ·  2 0 2 6"
)

PROSE = (
    "An on-prem AI appliance that replaces the router, switch, cameras, "
    "file server, smart-home hub and the cloud AI subscription with one "
    "rack-mounted unit — every file, email, camera and device addressable "
    "from a single chat surface that never leaves the building."
)


@pytest.fixture
def normal_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "normal.pdf"
    c = canvas.Canvas(str(path))
    c.drawString(72, 720, "perfectly ordinary searchable sentence content")
    c.showPage()
    c.save()
    return path


class TestLooksLetterSpaced:
    def test_positive_on_the_production_pattern(self):
        assert pdf._looks_letter_spaced(LETTER_SPACED) is True

    def test_negative_on_real_prose(self):
        assert pdf._looks_letter_spaced(PROSE) is False

    def test_negative_on_short_samples(self):
        # A page holding only "Q 4" (or any tiny fragment) must not trip
        # the fallback — below the token floor the heuristic abstains.
        assert pdf._looks_letter_spaced("Q 4") is False
        assert pdf._looks_letter_spaced("R O I  u p") is False

    def test_negative_on_numeric_tables(self):
        # Number-heavy content has few alphabetic tokens; only alpha
        # tokens count toward the ratio, and short alpha sets abstain.
        table = "2026 2027 2028 2029 " * 10 + "revenue margin units"
        assert pdf._looks_letter_spaced(table) is False


class TestPdfminerFallback:
    def test_degraded_pypdf_output_swaps_to_pdfminer(self, normal_pdf: Path):
        with (
            patch("extractors.pdf._pdfminer_page_texts") as miner,
            patch("pypdf._page.PageObject.extract_text", return_value=LETTER_SPACED),
        ):
            miner.return_value = [PROSE]
            doc = pdf.extract(str(normal_pdf))

        assert doc["metadata"]["extractor_name"] == "pdf+pdfminer"
        assert "pypdf_letter_spaced_used_pdfminer" in doc["warnings"]
        assert doc["spans"][0].text == PROSE

    def test_clean_pypdf_output_never_calls_pdfminer(self, normal_pdf: Path):
        with patch("extractors.pdf._pdfminer_page_texts") as miner:
            doc = pdf.extract(str(normal_pdf))
        miner.assert_not_called()
        assert doc["metadata"]["extractor_name"] == "pdf"
        assert "ordinary searchable" in doc["spans"][0].text

    def test_pdfminer_failure_keeps_pypdf_output(self, normal_pdf: Path):
        with (
            patch("extractors.pdf._pdfminer_page_texts", side_effect=RuntimeError("boom")),
            patch("pypdf._page.PageObject.extract_text", return_value=LETTER_SPACED),
        ):
            doc = pdf.extract(str(normal_pdf))

        # Degraded but present beats absent — the pypdf text stays, the
        # failure is recorded, and the extractor name stays honest.
        assert doc["metadata"]["extractor_name"] == "pdf"
        assert "pdfminer_fallback_failed" in doc["warnings"]
        assert doc["spans"][0].text == LETTER_SPACED

    def test_pdfminer_empty_pages_keep_pypdf_text(self, normal_pdf: Path):
        # A page pdfminer returns nothing for keeps its pypdf text rather
        # than vanishing from the index.
        with (
            patch("extractors.pdf._pdfminer_page_texts", return_value=[""]),
            patch("pypdf._page.PageObject.extract_text", return_value=LETTER_SPACED),
        ):
            doc = pdf.extract(str(normal_pdf))
        assert doc["spans"][0].text == LETTER_SPACED
        assert doc["metadata"]["extractor_name"] == "pdf+pdfminer"

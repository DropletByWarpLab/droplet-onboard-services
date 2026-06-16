"""Unit tests for the PDF extractor (spans shape — WARP-287).

Per-page anchor coverage lives in test_extractor_pdf_anchors.py. This
file keeps the corner-cases: well-formed sample fixture + corrupt-PDF
guard.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors.pdf import extract


FIXTURE = Path(__file__).parent / "fixtures" / "sample.pdf"


def test_extract_two_page_pdf():
    assert FIXTURE.exists(), f"missing fixture {FIXTURE}"
    doc = extract(str(FIXTURE))
    spans = doc["spans"]
    full_text = " ".join(s.text for s in spans)
    assert "Hello from page one" in full_text
    assert "alphahotel" in full_text
    assert doc["metadata"]["extractor_name"] == "pdf"
    assert doc["metadata"]["page_count"] == 2
    # One span per non-empty page so citations can deep-link.
    assert len(spans) == 2


def test_extract_corrupt_pdf_raises_caught_in_dispatch(tmp_path):
    f = tmp_path / "corrupt.pdf"
    f.write_bytes(b"%PDF-not-actually")
    # extract() raising is OK — registry.dispatch swallows.
    with pytest.raises(Exception):
        extract(str(f))

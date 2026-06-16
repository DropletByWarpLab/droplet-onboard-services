"""Unit tests for the DOCX extractor (spans shape — WARP-287).

Anchor-shape coverage (single NoneAnchor span) lives in
test_non_mvp_extractors_emit_none_anchor.py. This file pins the
fixture-content + metadata assertions.
"""
from __future__ import annotations

from pathlib import Path

from extractors.docx import extract


FIXTURE = Path(__file__).parent / "fixtures" / "sample.docx"


def test_extract_docx():
    doc = extract(str(FIXTURE))
    full = " ".join(s.text for s in doc["spans"])
    assert "Test Document" in full
    assert "bravoindigo" in full
    assert doc["metadata"]["extractor_name"] == "docx"
    assert doc["metadata"]["word_count"] >= 5

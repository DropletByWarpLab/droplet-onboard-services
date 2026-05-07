"""Unit tests for the DOCX extractor."""
from __future__ import annotations

from pathlib import Path

from extractors.docx import extract


FIXTURE = Path(__file__).parent / "fixtures" / "sample.docx"


def test_extract_docx():
    doc = extract(str(FIXTURE))
    assert "Test Document" in doc["text"]
    assert "bravoindigo" in doc["text"]
    assert doc["metadata"]["extractor_name"] == "docx"
    assert doc["metadata"]["word_count"] >= 5

"""Unit tests for the PDF extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors.pdf import extract


FIXTURE = Path(__file__).parent / "fixtures" / "sample.pdf"


def test_extract_two_page_pdf():
    assert FIXTURE.exists(), f"missing fixture {FIXTURE}"
    doc = extract(str(FIXTURE))
    assert "Hello from page one" in doc["text"]
    assert "alphahotel" in doc["text"]
    assert doc["metadata"]["extractor_name"] == "pdf"
    assert doc["metadata"]["page_count"] == 2
    # Page breaks recorded so citations can deep-link.
    assert len(doc["page_breaks"]) == 2  # one entry per page boundary


def test_extract_corrupt_pdf_raises_caught_in_dispatch(tmp_path):
    f = tmp_path / "corrupt.pdf"
    f.write_bytes(b"%PDF-not-actually")
    # extract() raising is OK — registry.dispatch swallows.
    with pytest.raises(Exception):
        extract(str(f))

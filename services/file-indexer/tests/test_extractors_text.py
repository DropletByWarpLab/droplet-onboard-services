"""Unit tests for the text/HTML/CSV extractor (spans shape — WARP-287).

Anchor-shape coverage (single NoneAnchor span) lives in
test_non_mvp_extractors_emit_none_anchor.py. This file keeps the
content-level corner-cases: HTML boilerplate stripping, CSV passthrough,
unicode decode fallback.
"""
from __future__ import annotations

from extractors.text import extract


def _full_text(doc) -> str:
    return " ".join(s.text for s in doc["spans"])


def test_plain_text(tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("Hello world.\nSecond line.\n", encoding="utf-8")
    doc = extract(str(f))
    full = _full_text(doc)
    assert "Hello world" in full
    assert "Second line" in full
    assert doc["metadata"]["extractor_name"] == "text"
    assert doc["metadata"]["word_count"] >= 4


def test_html_strips_boilerplate(tmp_path):
    f = tmp_path / "page.html"
    f.write_text(
        "<html><head><script>var x=1;</script></head><body>"
        "<nav>Skip me</nav>"
        "<article><h1>Real Title</h1><p>Real content here.</p></article>"
        "</body></html>",
        encoding="utf-8",
    )
    doc = extract(str(f))
    full = _full_text(doc)
    assert "Real Title" in full
    assert "Real content here" in full
    # Boilerplate should be stripped.
    assert "var x" not in full


def test_csv_passthrough(tmp_path):
    f = tmp_path / "data.csv"
    f.write_text("col1,col2\nA,1\nB,2\n", encoding="utf-8")
    doc = extract(str(f))
    full = _full_text(doc)
    assert "col1,col2" in full
    assert "A,1" in full


def test_unicode_decode_fallback(tmp_path):
    f = tmp_path / "weird.txt"
    f.write_bytes(b"\xff\xfe\x00\x00plain ASCII tail")
    # Should not raise; should fall back to errors='replace'.
    doc = extract(str(f))
    assert "plain ASCII tail" in _full_text(doc)

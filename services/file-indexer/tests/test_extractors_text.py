"""Unit tests for the text/HTML/CSV extractor."""
from __future__ import annotations

from extractors.text import extract


def test_plain_text(tmp_path):
    f = tmp_path / "doc.txt"
    f.write_text("Hello world.\nSecond line.\n", encoding="utf-8")
    doc = extract(str(f))
    assert "Hello world" in doc["text"]
    assert "Second line" in doc["text"]
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
    assert "Real Title" in doc["text"]
    assert "Real content here" in doc["text"]
    # Boilerplate should be stripped.
    assert "var x" not in doc["text"]


def test_csv_passthrough(tmp_path):
    f = tmp_path / "data.csv"
    f.write_text("col1,col2\nA,1\nB,2\n", encoding="utf-8")
    doc = extract(str(f))
    assert "col1,col2" in doc["text"]
    assert "A,1" in doc["text"]


def test_unicode_decode_fallback(tmp_path):
    f = tmp_path / "weird.txt"
    f.write_bytes(b"\xff\xfe\x00\x00plain ASCII tail")
    # Should not raise; should fall back to errors='replace'.
    doc = extract(str(f))
    assert "plain ASCII tail" in doc["text"]

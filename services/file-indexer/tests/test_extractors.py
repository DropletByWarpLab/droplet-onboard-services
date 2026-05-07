"""Tests for the extractor registry's dispatch + size-cap behavior.

Per-extractor tests live in their own files (test_extractors_pdf.py, etc.).
"""
from __future__ import annotations

import os

from extractors.registry import dispatch, MAX_INDEX_BYTES


def test_dispatch_unknown_mime_returns_none(tmp_path):
    f = tmp_path / "data.unknown-binary"
    f.write_bytes(b"\x00\x01\x02")
    result = dispatch(str(f), "application/x-unknown")
    assert result is None


def test_dispatch_oversized_skips(tmp_path, monkeypatch):
    f = tmp_path / "huge.txt"
    f.write_text("x")
    # Pretend the file is huge by patching os.path.getsize.
    monkeypatch.setattr(os.path, "getsize", lambda p: MAX_INDEX_BYTES + 1)
    result = dispatch(str(f), "text/plain")
    assert result is None


def test_dispatch_text_returns_extracted_doc(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("hello world\n")
    result = dispatch(str(f), "text/plain")
    assert result is not None
    assert "hello world" in result["text"]
    assert result["metadata"]["extractor_name"] == "text"

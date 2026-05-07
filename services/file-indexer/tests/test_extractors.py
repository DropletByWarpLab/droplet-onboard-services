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


# ── WARP-197 audio dispatch ─────────────────────────────────────────────


def test_audio_mime_dispatches_to_audio_handler():
    """The registry knows every audio MIME routes to audio.extract.

    WARP-199 unified the dispatch path: instead of a `_HANDLERS` dict,
    `registry._route(mime)` does lazy try/except imports and returns the
    target extractor's `extract` function directly. We assert that
    every MIME in `audio.SUPPORTED_MIMES` resolves to `audio.extract`.
    """
    from extractors import audio, registry

    for mime in audio.SUPPORTED_MIMES:
        handler = registry._route(mime)
        assert handler is not None, f"_route({mime!r}) returned None"
        assert handler is audio.extract, f"_route({mime!r}) is not audio.extract"


def test_audio_cap_is_500mb():
    """Per-MIME byte cap: audio is 500 MB, docs stay at the 50 MB default."""
    from extractors import registry

    assert registry._cap_for_mime("audio/wav") == 500 * 1024 * 1024
    assert registry._cap_for_mime("audio/mpeg") == 500 * 1024 * 1024
    assert registry._cap_for_mime("audio/x-wav") == 500 * 1024 * 1024
    assert registry._cap_for_mime("text/plain") == 50 * 1024 * 1024
    assert registry._cap_for_mime("application/pdf") == 50 * 1024 * 1024


def test_audio_oversized_file_skipped(tmp_path, monkeypatch):
    """Audio over the 500 MB cap is skipped, just like docs over 50 MB."""
    from extractors import registry

    f = tmp_path / "huge.wav"
    f.write_bytes(b"RIFF\x00")
    monkeypatch.setattr(
        os.path, "getsize", lambda p: registry.AUDIO_MAX_BYTES + 1
    )
    result = dispatch(str(f), "audio/wav")
    assert result is None

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
    """The registry knows audio/wav routes to the audio extractor."""
    from extractors import audio, registry

    handler = registry._route("audio/wav")
    assert handler is not None
    # The handler is a one-arg adapter that closes over the MIME and calls
    # audio.extract(path, mime). We can't assert `is audio.extract` because
    # of the adapter, but we can assert the audio MIME has *some* handler
    # registered in _HANDLERS, and that the SUPPORTED_MIMES set lines up.
    assert "audio/wav" in registry._HANDLERS
    assert "audio/mpeg" in registry._HANDLERS
    for m in audio.SUPPORTED_MIMES:
        assert m in registry._HANDLERS


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

"""Unit tests for the video extractor (WARP-198).

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.2

The video extractor follows a subtitles-first / audio-fallback strategy:

  - If the file contains a text-based subtitle stream (srt/ass/ssa/
    mov_text/webvtt), we extract that stream as SRT and parse it. The
    resulting `metadata.subtitle_source == "embedded"`.
  - Otherwise, we strip the audio track to a 16 kHz mono WAV and
    delegate to the WARP-197 audio extractor (faster-whisper). The
    resulting `metadata.subtitle_source == "asr_transcript"`.

We don't assert specific transcription content for the audio-fallback
case because the fixture audio is a WAV that may not transcribe to a
deterministic phrase across whisper model versions / hardware.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import audio, video

FIXTURES = Path(__file__).parent / "fixtures"

# When `faster-whisper` isn't installed in the dev env, the audio
# extractor's `WhisperModel` is None — calling it without a mock would
# raise. Skip the audio-fallback assertion in that case (the live
# integration test under RUN_RAG_INTEGRATION=1 covers the real path).
_WHISPER_AVAILABLE = audio.WhisperModel is not None


def test_with_srt_uses_subtitle_stream():
    """When the file has a text-based subtitle stream, that's the source of truth."""
    result = video.extract(FIXTURES / "with-srt.mp4", mime="video/mp4")
    assert result is not None
    assert result["metadata"]["subtitle_source"] == "embedded"
    assert "budget meeting kickoff" in result["text"].lower()


def test_no_srt_falls_back_to_audio(monkeypatch):
    """When no subtitle stream exists, fall back to the audio extractor (WARP-197).

    We monkeypatch the audio extractor when faster-whisper isn't
    installed so the unit-test surface stays runnable on dev boxes
    without the ~150 MB CTranslate2 wheel.
    """
    if not _WHISPER_AVAILABLE:
        # Stand in a fake audio.extract that returns a minimal ExtractedDoc.
        def _fake_audio_extract(path, mime):
            assert mime == "audio/wav"
            return {
                "text": "fake transcript",
                "page_breaks": [],
                "language": "en",
                "metadata": {"duration_sec": 1.0, "extractor_name": "audio"},
                "warnings": [],
            }

        monkeypatch.setattr(video.audio, "extract", _fake_audio_extract)

    result = video.extract(FIXTURES / "no-srt.mp4", mime="video/mp4")
    assert result is not None
    assert result["metadata"]["subtitle_source"] == "asr_transcript"
    # Don't assert specific transcription content — the fixture audio may
    # be a tone or a short PCM clip whose transcription isn't stable.
    assert "text" in result


def test_returns_none_for_unsupported_mime():
    """Defensive: extractor refuses MIMEs it doesn't claim."""
    result = video.extract(FIXTURES / "with-srt.mp4", mime="audio/wav")
    assert result is None


def test_video_metadata_includes_subtitle_source_for_chain_consumers(monkeypatch):
    """WARP-214: subtitle_source must be reachable as ExtractedDoc.metadata['subtitle_source']
    so the chunker can propagate it to FileContentChunk.metadata.subtitle_source.

    Asserts the persistence-shape stability that the dashboard's
    SourceChannelBadge reads from /api/files/knowledge/{recent,search}.
    """
    if not _WHISPER_AVAILABLE:
        def _fake_audio_extract(path, mime):
            return {
                "text": "fake transcript",
                "page_breaks": [],
                "language": "en",
                "metadata": {"duration_sec": 1.0, "extractor_name": "audio"},
                "warnings": [],
            }

        monkeypatch.setattr(video.audio, "extract", _fake_audio_extract)

    result_with = video.extract(FIXTURES / "with-srt.mp4", mime="video/mp4")
    assert result_with is not None
    assert result_with["metadata"]["subtitle_source"] == "embedded"

    result_without = video.extract(FIXTURES / "no-srt.mp4", mime="video/mp4")
    assert result_without is not None
    assert result_without["metadata"]["subtitle_source"] == "asr_transcript"

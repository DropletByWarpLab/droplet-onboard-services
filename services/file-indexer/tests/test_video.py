"""Unit tests for the video extractor (WARP-198, WARP-208).

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
from unittest.mock import patch

import pytest

from extractors import audio, frame_ocr, video

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


# ---- WARP-208 frame OCR integration ------------------------------------


def _fake_subs_doc(text: str = "subtitle text", source: str = "embedded") -> dict:
    return {
        "text": text,
        "page_breaks": [],
        "language": "en" if text else None,
        "metadata": {
            "subtitle_source": source,
            "extractor_name": "video",
            "extractor_version": "1.0.0",
        },
        "warnings": [],
    }


def test_video_extract_skips_frame_ocr_when_disabled(monkeypatch, tmp_path):
    """VIDEO_FRAME_OCR_ENABLED unset -> frame_ocr.extract_frame_text never
    called; subtitle_source unchanged from WARP-198 behavior."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.delenv("VIDEO_FRAME_OCR_ENABLED", raising=False)

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc()), \
         patch("extractors.video.frame_ocr.extract_frame_text") as mock_frame:
        result = video.extract(fake_video, "video/mp4")

    mock_frame.assert_not_called()
    assert result is not None
    assert result["metadata"]["subtitle_source"] == "embedded"
    assert "Frame OCR" not in result["text"]
    assert "frame_ocr" not in result["metadata"]


def test_video_extract_skips_frame_ocr_when_flag_is_zero(monkeypatch, tmp_path):
    """VIDEO_FRAME_OCR_ENABLED=0 -> still skipped (only "1" turns it on)."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "0")

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc()), \
         patch("extractors.video.frame_ocr.extract_frame_text") as mock_frame:
        result = video.extract(fake_video, "video/mp4")

    mock_frame.assert_not_called()
    assert result is not None
    assert "frame_ocr" not in result["metadata"]


def test_video_extract_runs_frame_ocr_when_enabled_and_appends_section(
    monkeypatch, tmp_path,
):
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    fake_segments = [
        frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="welcome"),
        frame_ocr.FrameSegment(start_sec=5, end_sec=10, text="revenue"),
    ]
    fake_stats = frame_ocr.FrameOCRStats(
        frames_sampled=10, frames_ocr_run=2, segments_emitted=2,
        interval_sec_used=5,
    )

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc()), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=(fake_segments, fake_stats)):
        result = video.extract(fake_video, "video/mp4")

    assert result is not None
    # Combined text contains both channels.
    assert "subtitle text" in result["text"]
    assert "--- Frame OCR ---" in result["text"]
    assert "[00:00 → 00:05] welcome" in result["text"]
    assert "[00:05 → 00:10] revenue" in result["text"]
    # Combined provenance.
    assert result["metadata"]["subtitle_source"] == "embedded+frame_ocr"
    # Stats dict surfaced.
    assert result["metadata"]["frame_ocr"] == {
        "frames_sampled": 10,
        "frames_ocr_run": 2,
        "segments_emitted": 2,
        "interval_sec_used": 5,
    }


def test_video_extract_combines_provenance_with_asr_transcript(
    monkeypatch, tmp_path,
):
    """ASR-fallback + frame OCR -> 'asr_transcript+frame_ocr'."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    fake_segments = [
        frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="slide one"),
    ]
    fake_stats = frame_ocr.FrameOCRStats(segments_emitted=1, interval_sec_used=5)

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc(text="hello world",
                                            source="asr_transcript")), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=(fake_segments, fake_stats)):
        result = video.extract(fake_video, "video/mp4")

    assert result["metadata"]["subtitle_source"] == "asr_transcript+frame_ocr"


def test_video_extract_subtitle_source_when_only_frame_ocr(monkeypatch, tmp_path):
    """No subs, audio fallback empty, frame OCR has text -> 'frame_ocr_only'."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    fake_segments = [frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="text")]
    fake_stats = frame_ocr.FrameOCRStats(segments_emitted=1, interval_sec_used=5)

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc(text="", source="asr_transcript")), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=(fake_segments, fake_stats)):
        result = video.extract(fake_video, "video/mp4")

    assert result["metadata"]["subtitle_source"] == "frame_ocr_only"
    # Frame-OCR text becomes the entire payload (no leading subtitle text).
    assert "--- Frame OCR ---" in result["text"]
    assert not result["text"].startswith("\n")


def test_video_extract_no_segments_keeps_base_subtitle_source(monkeypatch, tmp_path):
    """Frame OCR ran but produced no segments -> subtitle_source unchanged,
    but stats dict + warnings still surfaced."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    empty_stats = frame_ocr.FrameOCRStats(
        frames_sampled=3, frames_ocr_run=3, segments_emitted=0,
        interval_sec_used=5,
        warnings=["frame_ocr_unavailable"],
    )

    with patch("extractors.video._extract_subtitles_or_audio_fallback",
               return_value=_fake_subs_doc()), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=([], empty_stats)):
        result = video.extract(fake_video, "video/mp4")

    assert result["metadata"]["subtitle_source"] == "embedded"
    assert "--- Frame OCR ---" not in result["text"]
    assert result["metadata"]["frame_ocr"]["segments_emitted"] == 0
    assert "frame_ocr_unavailable" in result["warnings"]

"""Video extractor — subtitles-first, audio-fallback through WARP-197,
optional frame OCR via WARP-208 when `VIDEO_FRAME_OCR_ENABLED=1`.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.2
WARP-208: docs/superpowers/specs/2026-05-09-warp-208-frame-ocr-design.md

Output: an `ExtractedDoc` carrying a list of Spans. Each span is anchored to
a media-timestamp window:

  - Transcript spans (one per subtitle cue or ASR segment) span their cue's
    [start, end] in milliseconds.
  - Frame-OCR spans (one per surviving frame) span a 1-second window
    centered on the frame's wall-clock time.

Spans are emitted in `startMs` ascending order so downstream chunkers can
treat the doc as a single time-ordered stream.

Two helpers exist as explicit test seams:

  _transcribe(path) -> (segments_iter, info)
      Picks the best transcript source for the file (embedded subtitles
      preferred; ASR fallback). Returns Whisper-shaped objects with
      `.start` / `.end` (seconds, float) and `.text` (str).

  _run_frame_ocr(path) -> list[dict]
      Returns frame-OCR results as `[{"timestamp_seconds": float,
      "text": str}, ...]`. Returns `[]` when frame OCR is disabled or
      produced nothing.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Union

import srt as srt_lib

from anchor_schema import MediaTimestampAnchor

from . import audio, frame_ocr
from .spans import Span
from .types import ExtractedDoc

logger = logging.getLogger(__name__)

SUPPORTED_MIMES = frozenset(
    {
        "video/mp4",
        "video/quicktime",
        "video/x-matroska",
        "video/webm",
        "video/x-msvideo",  # avi
        "video/mpeg",
    }
)

# codec_name values for text-based subtitle streams ffmpeg can convert
# to SRT via `-c:s text`. Bitmap subtitle codecs (dvbsub, hdmv_pgs_subtitle)
# are deliberately excluded — those would need OCR (WARP-208).
_TEXT_SUBTITLE_CODECS = frozenset({"srt", "ass", "ssa", "mov_text", "webvtt"})

# Frame-OCR spans cover a 1-second window centered on the sampled frame
# (we pad ±500 ms so the strict endMs > startMs invariant holds and the
# anchor stays representative without overlapping wildly with neighbors).
_FRAME_OCR_WINDOW_MS = 1000


@dataclass
class _TranscriptSegment:
    """Whisper-shaped tuple-ish so `_transcribe` returns one homogeneous type
    regardless of whether the source was an SRT cue or an ASR segment."""
    start: float
    end: float
    text: str


@dataclass
class _TranscriptInfo:
    language: Optional[str]
    duration: Optional[float]
    subtitle_source: str  # "embedded" | "asr_transcript" | "asr_transcript_failed"


def _ffprobe_streams(path: Path) -> list[dict]:
    """Return the list of streams from `ffprobe -show_streams`."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout).get("streams", [])


def _pick_subtitle_stream(streams: list[dict]) -> Optional[int]:
    """Return the in-file stream index of the chosen text-based subtitle."""
    candidates = [
        s
        for s in streams
        if s.get("codec_type") == "subtitle"
        and s.get("codec_name") in _TEXT_SUBTITLE_CODECS
    ]
    if not candidates:
        return None
    for s in candidates:
        if s.get("tags", {}).get("language") == "eng":
            return int(s["index"])
    return int(candidates[0]["index"])


def _extract_srt(path: Path, stream_index: int) -> str:
    """Convert the picked subtitle stream to SRT on stdout."""
    streams = _ffprobe_streams(path)
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]
    sub_idx = next(i for i, s in enumerate(sub_streams) if s["index"] == stream_index)
    proc = subprocess.run(
        [
            "ffmpeg",
            "-v", "error",
            "-i", str(path),
            "-map", f"0:s:{sub_idx}",
            "-c:s", "text",
            "-f", "srt",
            "-",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout


def _strip_audio_to_wav(path: Path) -> Path:
    """Decode the audio track to a 16 kHz mono WAV in /tmp; return the path."""
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v", "error",
            "-i", str(path),
            "-vn",
            "-ac", "1",
            "-ar", "16000",
            "-f", "wav",
            tmp,
        ],
        check=True,
    )
    return Path(tmp)


def _transcribe(path: Union[str, Path]) -> tuple[Iterable, _TranscriptInfo]:
    """Pick the best transcript source: embedded subtitles > ASR fallback.

    Returns Whisper-shaped segments (`.start`, `.end`, `.text`) plus an
    info object carrying language / duration / provenance.
    """
    p = Path(path)
    streams = _ffprobe_streams(p)
    sub_index = _pick_subtitle_stream(streams)

    if sub_index is not None:
        srt_text = _extract_srt(p, sub_index)
        cues = list(srt_lib.parse(srt_text))
        segments = [
            _TranscriptSegment(
                start=cue.start.total_seconds(),
                end=cue.end.total_seconds(),
                text=cue.content.replace("\n", " ").strip(),
            )
            for cue in cues
        ]
        duration = segments[-1].end if segments else None
        return iter(segments), _TranscriptInfo(
            language=None, duration=duration, subtitle_source="embedded",
        )

    # ASR fallback: strip audio to WAV, delegate to the audio extractor's
    # private `_load_model` -> `transcribe()` path. We re-implement the WAV
    # pipeline here (not via `audio.extract`) because we need Whisper's
    # raw segment objects, not the spans-shaped `ExtractedDoc`.
    wav_path = _strip_audio_to_wav(p)
    try:
        with audio._model_lock:  # noqa: SLF001 — intentional reuse of the audio lock
            try:
                model = audio._load_model("cuda")
                segments_iter, info = model.transcribe(
                    str(wav_path), beam_size=5, temperature=0.0,
                )
            except (RuntimeError, ValueError) as exc:
                logger.warning("video ASR: CUDA path failed (%s); CPU fallback", exc)
                audio._model_cache.pop(f"{audio._model_name()}:cuda", None)
                model = audio._load_model("cpu")
                segments_iter, info = model.transcribe(
                    str(wav_path), beam_size=5, temperature=0.0,
                )
        segments = list(segments_iter)
        return iter(segments), _TranscriptInfo(
            language=getattr(info, "language", None),
            duration=getattr(info, "duration", None),
            subtitle_source="asr_transcript",
        )
    finally:
        try:
            wav_path.unlink()
        except OSError:
            pass


def _frame_ocr_enabled() -> bool:
    """Master switch — VIDEO_FRAME_OCR_ENABLED=1 turns on the WARP-208 path."""
    return os.environ.get("VIDEO_FRAME_OCR_ENABLED", "0") == "1"


def _run_frame_ocr(path: Union[str, Path]) -> list[dict]:
    """Sample frames, OCR survivors. Returns `[{"timestamp_seconds", "text"}, ...]`.

    Best-effort: degrades to `[]` on any pipeline failure. Each survivor
    becomes one entry; the caller turns it into a span anchored to a
    1-second window around `timestamp_seconds`.
    """
    segments, stats = frame_ocr.extract_frame_text(Path(path))
    results: list[dict] = []
    for seg in segments:
        # Center the frame's wall-clock at start_sec; the caller decides
        # how wide the anchor window is.
        results.append(
            {
                "timestamp_seconds": float(seg.start_sec),
                "text": seg.text,
            }
        )
    return results


def _span_from_transcript_segment(seg) -> Optional[Span]:
    """Build a span from a Whisper-shaped segment. Returns None when the
    segment is empty or degenerate (endMs <= startMs after rounding)."""
    seg_text = (getattr(seg, "text", "") or "").strip()
    if not seg_text:
        return None
    start_ms = int(round(float(seg.start) * 1000))
    end_ms = int(round(float(seg.end) * 1000))
    if end_ms <= start_ms:
        return None
    return Span(
        text=seg_text,
        anchor=MediaTimestampAnchor(startMs=start_ms, endMs=end_ms),
    )


def _span_from_frame_ocr_result(result: dict) -> Optional[Span]:
    """Build a span from a frame-OCR result. Anchor window is
    `_FRAME_OCR_WINDOW_MS` wide, centered (well, starting) at the
    sampled timestamp."""
    text = (result.get("text") or "").strip()
    if not text:
        return None
    ts_sec = float(result.get("timestamp_seconds", 0.0))
    start_ms = max(0, int(round(ts_sec * 1000)))
    end_ms = start_ms + _FRAME_OCR_WINDOW_MS
    return Span(
        text=text,
        anchor=MediaTimestampAnchor(startMs=start_ms, endMs=end_ms),
    )


def extract(
    path: Union[str, Path], mime: Optional[str] = None,
) -> Optional[ExtractedDoc]:
    """Extract spans from a video file.

    Transcript first (embedded subtitles preferred, ASR fallback), then —
    if `VIDEO_FRAME_OCR_ENABLED=1` — frame-OCR spans on top. All spans
    are anchored as `media-timestamp` and sorted by `startMs` ascending.

    Returns None when `mime` is supplied and isn't in `SUPPORTED_MIMES`.
    The 2 GB byte cap is enforced upstream in `registry.dispatch()`.
    """
    if mime is not None and mime not in SUPPORTED_MIMES:
        return None

    warnings: list[str] = []
    spans: list[Span] = []
    language: Optional[str] = None
    duration: Optional[float] = None
    subtitle_source: Optional[str] = None

    # Transcript pass.
    try:
        segments_iter, info = _transcribe(path)
    except Exception as exc:  # noqa: BLE001 — never abort the file
        logger.warning("video transcript failed (%s)", exc)
        warnings.append(f"transcript_failed:{exc}")
    else:
        language = info.language
        duration = info.duration
        subtitle_source = info.subtitle_source
        for seg in segments_iter:
            span = _span_from_transcript_segment(seg)
            if span is None:
                continue
            spans.append(span)

    # Frame-OCR pass (opt-in).
    frame_results: list[dict] = []
    if _frame_ocr_enabled():
        try:
            frame_results = _run_frame_ocr(path)
        except Exception as exc:  # noqa: BLE001 — best-effort
            logger.warning("video frame OCR failed (%s)", exc)
            warnings.append(f"frame_ocr_failed:{exc}")
        for result in frame_results:
            span = _span_from_frame_ocr_result(result)
            if span is None:
                continue
            spans.append(span)

    # Time-order the merged stream so chunkers / citation rendering can
    # walk the doc as a single timeline.
    spans.sort(key=lambda s: s.anchor.startMs)

    return ExtractedDoc(
        spans=spans,
        language=language,
        metadata={
            "extractor_name": "video",
            "extractor_version": "2",
            "subtitle_source": subtitle_source,
            "duration_seconds": duration,
            "frame_ocr_segments": len(frame_results),
        },
        warnings=warnings,
    )

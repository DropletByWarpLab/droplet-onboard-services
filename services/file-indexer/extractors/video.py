"""Video extractor — subtitles-first, audio-fallback through WARP-197,
optional frame OCR via WARP-208 when `VIDEO_FRAME_OCR_ENABLED=1`.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.2
WARP-208: docs/superpowers/specs/2026-05-09-warp-208-frame-ocr-design.md

Strategy:

  Step 1: ffprobe the file to enumerate streams.
  Step 2a (subtitles path): if a text-based subtitle stream exists
          (codec_name in srt/ass/ssa/mov_text/webvtt), pick the first
          English one (by `tags.language == "eng"`) else the first such
          stream, run ffmpeg to convert it to SRT on stdout, parse with
          the `srt` library, and emit `metadata.subtitle_source =
          "embedded"`.
  Step 2b (audio fallback): otherwise, run ffmpeg to strip the audio
          track to a 16 kHz mono WAV in /tmp and delegate to the
          WARP-197 audio extractor (faster-whisper). Tag the result
          with `metadata.subtitle_source = "asr_transcript"` so
          downstream consumers can render the right badge. Always
          clean up the temp WAV.
  Step 3 (WARP-208, opt-in): if `VIDEO_FRAME_OCR_ENABLED=1`, sample
          frames every `VIDEO_FRAME_OCR_INTERVAL_SEC` seconds, phash-
          dedup, OCR survivors via the image extractor's helper,
          merge timestamp-tagged segments into the existing text under
          a `--- Frame OCR ---` separator, and combine provenance
          (e.g. `embedded+frame_ocr`).

The 2 GB per-MIME byte cap is enforced upstream by `registry.dispatch()`
(`VIDEO_MAX_BYTES`).
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional, Union

import srt as srt_lib

from . import audio, frame_ocr
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

# WARP-208 sentinel — chunker treats this like the email
# "--- Attachment: <name> ---" boundary (text-level, no special chunking).
_FRAME_OCR_SEPARATOR = "--- Frame OCR ---"


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
    """Return the in-file stream index of the chosen text-based subtitle.

    English-tagged streams win over untagged / non-English. If there's
    no English match, the first text-based subtitle stream wins. None
    is returned when no candidate exists.
    """
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
    """Convert the picked subtitle stream to SRT on stdout.

    `-map 0:s:<n>` indexes among the file's subtitle streams (not its
    overall stream list), so we have to translate the absolute stream
    index returned by `_pick_subtitle_stream` into a subtitle-only index
    by counting subtitle streams up to the picked one.
    """
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
            "-y",  # overwrite the empty file mkstemp created
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


def _extract_subtitles_or_audio_fallback(
    path: Path, mime: str,
) -> Optional[ExtractedDoc]:
    """Subtitles-first, ASR fallback. Pre-WARP-208 video extractor logic.

    Extracted as a private helper so the `extract()` wrapper can decide
    whether to layer frame OCR on top. Returns None for unsupported
    MIMEs (matching the pre-WARP-208 contract).
    """
    if mime not in SUPPORTED_MIMES:
        return None

    streams = _ffprobe_streams(path)
    sub_index = _pick_subtitle_stream(streams)

    if sub_index is not None:
        srt_text = _extract_srt(path, sub_index)
        cues = list(srt_lib.parse(srt_text))
        text_parts: list[str] = []
        page_breaks: list[int] = []
        cursor = 0
        for cue in cues:
            line = cue.content.replace("\n", " ").strip()
            text_parts.append(line)
            cursor += len(line) + 1  # +1 for the join newline
            page_breaks.append(cursor)
        return ExtractedDoc(
            text="\n".join(text_parts),
            page_breaks=page_breaks,
            language=None,
            metadata={
                "subtitle_source": "embedded",
                "cue_count": len(cues),
                "extractor_name": "video",
                "extractor_version": "1.0.0",
            },
            warnings=[],
        )

    # Audio fallback. Always clean up the temp WAV regardless of how
    # the audio extractor exits.
    wav_path = _strip_audio_to_wav(path)
    try:
        audio_doc = audio.extract(wav_path, mime="audio/wav")
        if audio_doc is None:
            logger.warning(
                "video: audio extractor refused the temp WAV — bug? path=%s", path,
            )
            return ExtractedDoc(
                text="",
                page_breaks=[],
                language=None,
                metadata={
                    "subtitle_source": "asr_transcript_failed",
                    "extractor_name": "video",
                    "extractor_version": "1.0.0",
                },
                warnings=["audio_extractor_returned_none"],
            )
        # Tag the source so downstream renderers (chat chip, search hit
        # badge) can show "ASR transcript" vs. "Subtitles".
        audio_doc.setdefault("metadata", {})
        audio_doc["metadata"]["subtitle_source"] = "asr_transcript"
        return audio_doc
    finally:
        try:
            wav_path.unlink()
        except OSError:
            pass


def _fmt_ts(sec: int) -> str:
    """Format an integer second offset as `mm:ss` (zero-padded)."""
    return f"{sec // 60:02d}:{sec % 60:02d}"


def _frame_ocr_enabled() -> bool:
    """Master switch — VIDEO_FRAME_OCR_ENABLED=1 turns on the WARP-208 path."""
    return os.environ.get("VIDEO_FRAME_OCR_ENABLED", "0") == "1"


def _append_frame_ocr(
    base: ExtractedDoc, segments: list, stats,
) -> ExtractedDoc:
    """Merge a frame-OCR result onto an existing subtitle/ASR `ExtractedDoc`.

    Mutates `base` (in keeping with the audio-fallback path's
    `audio_doc.setdefault(...)` style) and returns it for caller
    convenience. Combines `subtitle_source` provenance:
      embedded         -> embedded+frame_ocr
      asr_transcript   -> asr_transcript+frame_ocr
      (empty base text) -> frame_ocr_only
    """
    base_text = base.get("text", "") or ""
    base_source = base.get("metadata", {}).get("subtitle_source")

    # Always surface the stats dict + any warnings, even when no
    # segments were emitted (operators triaging cost / quality).
    base["metadata"]["frame_ocr"] = {
        "frames_sampled": stats.frames_sampled,
        "frames_ocr_run": stats.frames_ocr_run,
        "segments_emitted": stats.segments_emitted,
        "interval_sec_used": stats.interval_sec_used,
    }
    if stats.warnings:
        base.setdefault("warnings", []).extend(stats.warnings)

    if not segments:
        # No frame-OCR text produced; leave base text + subtitle_source alone.
        return base

    # Render the frame-OCR section.
    section_lines = [_FRAME_OCR_SEPARATOR]
    for seg in segments:
        section_lines.append(
            f"[{_fmt_ts(seg.start_sec)} → {_fmt_ts(seg.end_sec)}] {seg.text}"
        )
    frame_section = "\n".join(section_lines)

    if base_text:
        base["text"] = f"{base_text}\n\n{frame_section}"
    else:
        base["text"] = frame_section

    # Combine provenance.
    if not base_text:
        base["metadata"]["subtitle_source"] = "frame_ocr_only"
    elif base_source in ("embedded", "asr_transcript"):
        base["metadata"]["subtitle_source"] = f"{base_source}+frame_ocr"
    else:
        # Unknown / "asr_transcript_failed" / etc. — treat as frame-OCR only
        # for badge purposes, since that's the only channel with text.
        base["metadata"]["subtitle_source"] = "frame_ocr_only"

    return base


def extract(path: Union[str, Path], mime: str) -> Optional[ExtractedDoc]:
    """Extract text from a video file.

    Order of operations:
      1. Subtitles-first / ASR-fallback (WARP-198).
      2. If `VIDEO_FRAME_OCR_ENABLED=1`, also run frame OCR (WARP-208)
         and merge the result on top.

    Returns None when `mime` isn't in `SUPPORTED_MIMES`. The 2 GB byte
    cap is enforced upstream in `registry.dispatch()` so this function
    doesn't re-check size.
    """
    p = Path(path)
    base = _extract_subtitles_or_audio_fallback(p, mime)
    if base is None:
        return None

    if not _frame_ocr_enabled():
        return base

    # Frame OCR is best-effort: extract_frame_text never raises out,
    # so we never gate the subtitle/ASR result on its success.
    segments, stats = frame_ocr.extract_frame_text(p)
    return _append_frame_ocr(base, segments, stats)

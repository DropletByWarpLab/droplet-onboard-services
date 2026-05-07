"""Video extractor — subtitles-first, audio-fallback through WARP-197.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.2

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

No frame OCR — that's WARP-208's surface. The 2 GB per-MIME byte cap
is enforced upstream by `registry.dispatch()` (`VIDEO_MAX_BYTES`).
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

from . import audio
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


def extract(path: Union[str, Path], mime: str) -> Optional[ExtractedDoc]:
    """Extract text from a video file via subtitles or audio fallback.

    Returns None when `mime` isn't in `SUPPORTED_MIMES`. The 2 GB byte
    cap is enforced upstream in `registry.dispatch()` so this function
    doesn't re-check size.
    """
    if mime not in SUPPORTED_MIMES:
        return None

    p = Path(path)
    streams = _ffprobe_streams(p)
    sub_index = _pick_subtitle_stream(streams)

    if sub_index is not None:
        srt_text = _extract_srt(p, sub_index)
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
    wav_path = _strip_audio_to_wav(p)
    try:
        audio_doc = audio.extract(wav_path, mime="audio/wav")
        if audio_doc is None:
            logger.warning(
                "video: audio extractor refused the temp WAV — bug? path=%s", p,
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

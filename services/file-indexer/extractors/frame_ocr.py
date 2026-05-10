"""WARP-208 — frame OCR for video.

Public surface:
  extract_frame_text(path, *, interval_sec, phash_threshold)
    -> tuple[list[FrameSegment], FrameOCRStats]

Pipeline:
  1. ffmpeg fps=1/N -> JPEG byte stream
  2. imagehash.phash on each frame; skip if hamming<phash_threshold from prev
  3. extractors.image._ocr_image_bytes on survivors
  4. Merge survivors into timestamp-tagged segments

Off by default — controlled by VIDEO_FRAME_OCR_ENABLED env var, which is
read by the caller (extractors/video.py). This module assumes its caller
already decided to invoke it.

Cost on a 60-min screencast with ~5 distinct slides:
  - 720 frame samples (~10s)
  - 720 phashes (~5s)
  - ~5 surviving Tesseract calls (~1s)
Total: ~15-20s on top of the existing audio path. Negligible at the
WARP-218 deferred-window timescale.
"""
from __future__ import annotations

import io
import logging
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional, Union

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SEC = 5
MIN_INTERVAL_SEC = 1
MAX_INTERVAL_SEC = 60
DEFAULT_PHASH_THRESHOLD = 8
MIN_PHASH_THRESHOLD = 0
MAX_PHASH_THRESHOLD = 64
JPEG_SOI_MARKER = b"\xff\xd8"


@dataclass
class FrameSegment:
    start_sec: int
    end_sec: int
    text: str


@dataclass
class FrameOCRStats:
    frames_sampled: int = 0
    frames_ocr_run: int = 0
    segments_emitted: int = 0
    interval_sec_used: int = DEFAULT_INTERVAL_SEC
    warnings: list[str] = field(default_factory=list)


def parse_interval_sec(raw: Optional[str] = None) -> int:
    """Read VIDEO_FRAME_OCR_INTERVAL_SEC env (or accept an explicit raw string).

    Clamps to [MIN_INTERVAL_SEC, MAX_INTERVAL_SEC]. Falls back to default
    on parse error. Same defensive pattern as WARP-218's `_parse_run_time`.
    """
    value = raw if raw is not None else os.environ.get("VIDEO_FRAME_OCR_INTERVAL_SEC", "").strip()
    if not value:
        return DEFAULT_INTERVAL_SEC
    try:
        n = int(value)
        if not (MIN_INTERVAL_SEC <= n <= MAX_INTERVAL_SEC):
            raise ValueError(f"out of range: {n}")
        return n
    except Exception as exc:
        logger.warning(
            "VIDEO_FRAME_OCR_INTERVAL_SEC=%r is invalid (%s); falling back to %d",
            value, exc, DEFAULT_INTERVAL_SEC,
        )
        return DEFAULT_INTERVAL_SEC


def parse_phash_threshold(raw: Optional[str] = None) -> int:
    """Read VIDEO_FRAME_OCR_PHASH_THRESHOLD env (or accept an explicit raw string).

    Clamps to [0, 64]. 0 = pixel-perfect required, 64 = always different.
    8 is the standard "very similar" cutoff that catches slide
    transitions reliably while ignoring video compression artifacts.
    """
    value = raw if raw is not None else os.environ.get("VIDEO_FRAME_OCR_PHASH_THRESHOLD", "").strip()
    if not value:
        return DEFAULT_PHASH_THRESHOLD
    try:
        n = int(value)
        if not (MIN_PHASH_THRESHOLD <= n <= MAX_PHASH_THRESHOLD):
            raise ValueError(f"out of range: {n}")
        return n
    except Exception as exc:
        logger.warning(
            "VIDEO_FRAME_OCR_PHASH_THRESHOLD=%r is invalid (%s); falling back to %d",
            value, exc, DEFAULT_PHASH_THRESHOLD,
        )
        return DEFAULT_PHASH_THRESHOLD


def _sample_frames(
    video_path: Union[str, Path], *, interval_sec: int
) -> Iterator[bytes]:
    """Yield JPEG-encoded frame bytes from ffmpeg, one per `interval_sec`.

    Reads ffmpeg stdout in chunks and splits on the JPEG SOI marker
    (0xFFD8). Each yielded chunk starts with SOI and is the bytes of
    one encoded JPEG frame.
    """
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(video_path),
        "-vf", f"fps=1/{interval_sec}",
        "-q:v", "2",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    buf = b""
    READ_SIZE = 64 * 1024
    try:
        while True:
            data = proc.stdout.read(READ_SIZE)
            if not data:
                break
            buf += data
            # Split on SOI markers; everything between two SOIs is one
            # JPEG frame.
            while True:
                first = buf.find(JPEG_SOI_MARKER)
                if first == -1:
                    break
                second = buf.find(JPEG_SOI_MARKER, first + 2)
                if second == -1:
                    break
                yield buf[first:second]
                buf = buf[second:]
        # Trailing frame: whatever's left after the last SOI is the
        # final frame.
        if buf and buf.startswith(JPEG_SOI_MARKER):
            yield buf
    finally:
        try:
            proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def _phash_bytes(jpeg_bytes: bytes):
    """Compute a perceptual hash of a JPEG byte payload.

    Lazy-imports `imagehash` so this module stays loadable on minimal
    dev envs that haven't pip-installed the optional dep yet. The
    orchestrator function `extract_frame_text` catches the resulting
    `ImportError` and degrades gracefully.
    """
    import imagehash  # noqa: WPS433 — intentional lazy import
    from PIL import Image

    return imagehash.phash(Image.open(io.BytesIO(jpeg_bytes)))


def _dedup_by_phash(
    frames: list[bytes],
    *,
    phash_threshold: int,
) -> list[tuple[int, bytes]]:
    """Filter frames where consecutive hamming-distance < phash_threshold.

    Returns a list of (frame_index, frame_bytes) tuples for survivors.
    The frame_index is the index into the original list (so callers
    can compute timestamps as `frame_index * interval_sec`).

    `ImportError` (e.g. imagehash missing) propagates up so the
    orchestrator can return `frame_ocr_unavailable`. Other exceptions
    on a single frame are logged and that frame is skipped, but
    `prev_hash` is left untouched so the dedup chain stays consistent
    with the surviving frames.
    """
    kept: list[tuple[int, bytes]] = []
    prev_hash = None
    for idx, fb in enumerate(frames):
        try:
            cur_hash = _phash_bytes(fb)
        except ImportError:
            # Propagate so extract_frame_text can flag frame_ocr_unavailable.
            raise
        except Exception as exc:
            logger.debug(
                "frame_ocr: phash failed on frame %d (%s) — skipping",
                idx, exc,
            )
            continue
        if prev_hash is not None and (cur_hash - prev_hash) < phash_threshold:
            continue
        prev_hash = cur_hash
        kept.append((idx, fb))
    return kept


def _merge_segments(segments: list[FrameSegment]) -> list[FrameSegment]:
    """Extend each segment's end_sec to the next segment's start_sec.

    A slide that survives at 00:30 and is skipped (deduped) at 00:35,
    00:40, 00:45 produces one segment [00:30 -> 00:50] instead of
    [00:30 -> 00:35]. The final segment keeps its provisional end_sec.
    """
    if not segments:
        return []
    out: list[FrameSegment] = []
    for i in range(len(segments) - 1):
        cur = segments[i]
        nxt = segments[i + 1]
        out.append(
            FrameSegment(
                start_sec=cur.start_sec,
                end_sec=nxt.start_sec,
                text=cur.text,
            )
        )
    out.append(segments[-1])
    return out


def _ocr_jpeg_bytes(jpeg_bytes: bytes) -> tuple[str, list[str]]:
    """Run Tesseract on raw JPEG bytes via the image extractor's helper.
    Returns (text, warnings)."""
    from extractors.image import _ocr_image_bytes
    return _ocr_image_bytes(jpeg_bytes)


def extract_frame_text(
    path: Union[str, Path],
    *,
    interval_sec: Optional[int] = None,
    phash_threshold: Optional[int] = None,
) -> tuple[list[FrameSegment], FrameOCRStats]:
    """Sample -> phash dedup -> OCR -> merge. Best-effort; never raises out.

    Pipeline failures degrade to (empty list, stats with warning) so the
    caller can attach the warning to the video extractor's `metadata.warnings`
    and still return whatever subtitle/ASR result it already produced.
    """
    interval = interval_sec if interval_sec is not None else parse_interval_sec()
    phash_thresh = (
        phash_threshold if phash_threshold is not None else parse_phash_threshold()
    )
    stats = FrameOCRStats(interval_sec_used=interval)

    # Phase 1: sample frames via ffmpeg pipe.
    try:
        frames = list(_sample_frames(path, interval_sec=interval))
    except Exception as exc:
        logger.warning("frame_ocr: sample failed (%s)", exc)
        stats.warnings.append(f"frame_ocr_sample_failed:{exc}")
        return [], stats
    stats.frames_sampled = len(frames)
    if not frames:
        return [], stats

    # Phase 2: dedup. ImportError on imagehash propagates from
    # _phash_bytes -> _dedup_by_phash; we catch it here so the rest of
    # the video extraction can still complete.
    try:
        survivors = _dedup_by_phash(frames, phash_threshold=phash_thresh)
    except ImportError as exc:
        logger.warning("frame_ocr: imagehash unavailable (%s)", exc)
        stats.warnings.append("frame_ocr_unavailable")
        return [], stats
    except Exception as exc:
        logger.warning("frame_ocr: dedup failed (%s)", exc)
        stats.warnings.append(f"frame_ocr_dedup_failed:{exc}")
        return [], stats

    # Phase 3: OCR each survivor.
    raw_segments: list[FrameSegment] = []
    for frame_idx, frame_bytes in survivors:
        stats.frames_ocr_run += 1
        try:
            text, _warnings = _ocr_jpeg_bytes(frame_bytes)
        except Exception as exc:
            logger.warning(
                "frame_ocr: OCR failed on frame %d (%s)", frame_idx, exc,
            )
            continue
        if not text.strip():
            continue
        raw_segments.append(
            FrameSegment(
                start_sec=frame_idx * interval,
                end_sec=(frame_idx + 1) * interval,  # provisional; merge extends
                text=text.strip(),
            )
        )

    # Phase 4: merge consecutive segments' time ranges.
    merged = _merge_segments(raw_segments)
    stats.segments_emitted = len(merged)
    return merged, stats

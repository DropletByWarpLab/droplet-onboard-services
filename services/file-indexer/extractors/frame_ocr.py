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


# Function bodies for sample/phash/ocr/merge/extract land in 1.4..1.6.
def extract_frame_text(
    path: Union[str, Path],
    *,
    interval_sec: Optional[int] = None,
    phash_threshold: Optional[int] = None,
) -> tuple[list[FrameSegment], FrameOCRStats]:
    raise NotImplementedError("WARP-208 Task 1.6 wires the pipeline")

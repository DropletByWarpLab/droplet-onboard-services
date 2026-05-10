# WARP-208 — Frame OCR for video extractor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add frame OCR to WARP-198's video extractor. When `VIDEO_FRAME_OCR_ENABLED=1`, sample frames every `VIDEO_FRAME_OCR_INTERVAL_SEC` (default 5s), perceptually-hash-dedup with `imagehash.phash` BEFORE OCR (skip frames within hamming-8 of the previous), run survivors through the existing Tesseract helper, merge timestamp-tagged segments into the existing `text` with combined provenance (`asr_transcript+frame_ocr` etc.).

**Architecture:** New single-responsibility module `extractors/frame_ocr.py` (sampling + dedup + per-frame OCR + segment merge). `extractors/video.py` calls it after the existing subtitle/ASR branch when the env flag is set. Reuses `extractors.image`'s Tesseract helper (refactor if needed to expose `_ocr_image_bytes`). Off by default; defers to WARP-218's daily window when enabled.

**Tech Stack:** Python 3.12, ffmpeg (already in Dockerfile), `imagehash==4.3.1` (new dep), `Pillow` (existing transitive of pytesseract), pytest.

**Spec:** [`docs/superpowers/specs/2026-05-09-warp-208-frame-ocr-design.md`](../specs/2026-05-09-warp-208-frame-ocr-design.md)

---

## Pre-flight finding

The spec calls out one branch in §6: **whether `extractors/image.py` already exposes a reusable `_ocr_image_bytes(jpeg_bytes)` helper**. Task 1.5 inspects this and either uses the helper as-is OR extracts it into a shared function. Both paths produce the same end-state; the choice is observed at task time.

---

## Task 0: Pre-flight

### Task 0.1: Confirm clean state

- [ ] **Step 1: Branch + main parity**

```bash
git status
git rev-parse --abbrev-ref HEAD
git log -1 --format="%h %s"
```

Expected: clean tree on `WARP-208`, last `main` commit is the WARP-208 spec merge.

- [ ] **Step 2: Phase 2 + WARP-214 + WARP-218 surfaces are intact**

```bash
cd services/file-indexer && python -m pytest tests/ -v 2>&1 | tail -10
cd ../../apps/orchestrator && npm test 2>&1 | tail -10
```

Expected: green (the `mcp-client.service.test.ts` pre-existing flake is acceptable).

---

## Task 1: `extractors/frame_ocr.py` module

### Task 1.1: Add `imagehash` dep

**Files:**
- Modify: `services/file-indexer/requirements.txt`
- Modify: `services/file-indexer/requirements-dev.txt`

- [ ] **Step 1: Append to requirements.txt**

Append:

```
# WARP-208 — frame OCR for video extractor (perceptual hashing for
# pre-OCR dedup so we don't run Tesseract on every redundant frame).
# imagehash 4.3.1 is the canonical pure-python perceptual-hashing lib;
# small (~20KB), MIT licensed, depends only on Pillow (already pulled
# in by pytesseract).
imagehash==4.3.1
```

- [ ] **Step 2: Append to requirements-dev.txt**

```
imagehash==4.3.1
```

- [ ] **Step 3: Verify install path**

```bash
cd services/file-indexer
pip install --dry-run -r requirements-dev.txt 2>&1 | grep -iE "imagehash|pillow" | head -5
```

Expected: `imagehash-4.3.1` ready to install. `Pillow` already present.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/requirements.txt services/file-indexer/requirements-dev.txt
git commit -m "deps(file-indexer): add imagehash for frame OCR phash dedup (WARP-208)"
```

### Task 1.2: Inspect + (if needed) refactor `extractors/image.py`

**Files:**
- Modify: `services/file-indexer/extractors/image.py` (only if a reusable `_ocr_image_bytes` helper isn't already exposed)

- [ ] **Step 1: Inspect the current image extractor**

```bash
grep -nE "def _ocr_image_bytes|def extract|pytesseract|image_to_data" services/file-indexer/extractors/image.py
```

- [ ] **Step 2: Decide path**

If a reusable function `_ocr_image_bytes(jpeg_or_png_bytes) -> tuple[str, list[str]]` (or equivalent) exists, **proceed to Task 1.3** with no changes. Otherwise, perform the refactor below.

- [ ] **Step 3 (Case B only): Extract the helper**

Open `services/file-indexer/extractors/image.py`. The existing `extract(path, mime)` function does file-load + Tesseract + confidence-threshold checks. Move the Tesseract+confidence logic into a new private helper that accepts raw bytes:

```python
import io
from PIL import Image

def _ocr_image_bytes(jpeg_or_png_bytes: bytes) -> tuple[str, list[str]]:
    """Run Tesseract on raw image bytes. Returns (text, warnings).

    Shared by:
      - extract(path, mime) — opens file from disk, calls this helper
      - WARP-208 frame_ocr — opens JPEG bytes from ffmpeg pipe

    Honors OCR_CONFIDENCE_THRESHOLD + OCR_LANG env vars.
    """
    img = Image.open(io.BytesIO(jpeg_or_png_bytes))
    # ... move the existing pytesseract.image_to_data + confidence logic here ...
    return text, warnings
```

Then update `extract(path, mime)` to load bytes from `path` and call `_ocr_image_bytes`. The public contract is unchanged; only the internal seam is new.

- [ ] **Step 4 (Case B only): Run existing tests to confirm no regression**

```bash
cd services/file-indexer
python -m pytest tests/test_extractors_image.py -v 2>&1 | tail -10
```

Expected: green. The refactor is behavior-preserving.

- [ ] **Step 5 (Case B only): Commit**

```bash
git add services/file-indexer/extractors/image.py
git commit -m "refactor(file-indexer): extract _ocr_image_bytes helper for reuse (WARP-208)"
```

### Task 1.3: `frame_ocr.py` — types + skeleton

**Files:**
- Create: `services/file-indexer/extractors/frame_ocr.py`

- [ ] **Step 1: Write the module skeleton**

Create `services/file-indexer/extractors/frame_ocr.py`:

```python
"""WARP-208 — frame OCR for video.

Public surface:
  extract_frame_text(path, *, interval_sec, phash_threshold)
    → tuple[list[FrameSegment], FrameOCRStats]

Pipeline:
  1. ffmpeg fps=1/N → JPEG byte stream
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
Total: ~15-20s on top of existing audio path. Negligible at the WARP-218
deferred-window timescale.
"""
from __future__ import annotations

import io
import logging
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SEC = 5
MIN_INTERVAL_SEC = 1
MAX_INTERVAL_SEC = 60
DEFAULT_PHASH_THRESHOLD = 8
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


def parse_interval_sec(raw: str | None = None) -> int:
    """Read VIDEO_FRAME_OCR_INTERVAL_SEC env (or accept an explicit raw string).
    Clamps to [MIN_INTERVAL_SEC, MAX_INTERVAL_SEC]. Falls back to default on parse error."""
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


def parse_phash_threshold(raw: str | None = None) -> int:
    value = raw if raw is not None else os.environ.get("VIDEO_FRAME_OCR_PHASH_THRESHOLD", "").strip()
    if not value:
        return DEFAULT_PHASH_THRESHOLD
    try:
        n = int(value)
        if not (0 <= n <= 64):
            raise ValueError(f"out of range: {n}")
        return n
    except Exception as exc:
        logger.warning(
            "VIDEO_FRAME_OCR_PHASH_THRESHOLD=%r is invalid (%s); falling back to %d",
            value, exc, DEFAULT_PHASH_THRESHOLD,
        )
        return DEFAULT_PHASH_THRESHOLD


# Function bodies for sample/phash/ocr/merge/extract land in 1.4..1.7.
def extract_frame_text(
    path: str | Path,
    *,
    interval_sec: int | None = None,
    phash_threshold: int | None = None,
) -> tuple[list[FrameSegment], FrameOCRStats]:
    raise NotImplementedError("WARP-208 Task 1.7 wires the pipeline")
```

- [ ] **Step 2: Sanity import**

```bash
cd services/file-indexer
python -c "from extractors import frame_ocr; print(frame_ocr.parse_interval_sec(), frame_ocr.parse_phash_threshold())"
```

Expected: `5 8`.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/extractors/frame_ocr.py
git commit -m "feat(file-indexer): frame_ocr module skeleton — types + env parsers (WARP-208)"
```

### Task 1.4: Frame sampling helper (`_sample_frames`)

**Files:**
- Modify: `services/file-indexer/extractors/frame_ocr.py`
- Create: `services/file-indexer/tests/test_frame_ocr.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_frame_ocr.py`:

```python
"""WARP-208: frame_ocr unit tests."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from extractors import frame_ocr


def test_parse_interval_sec_default():
    assert frame_ocr.parse_interval_sec(None) == 5


def test_parse_interval_sec_honors_env(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "10")
    assert frame_ocr.parse_interval_sec() == 10


def test_parse_interval_sec_clamps_out_of_range(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "999")
    assert frame_ocr.parse_interval_sec() == 5


def test_parse_interval_sec_falls_back_on_garbage(monkeypatch):
    monkeypatch.setenv("VIDEO_FRAME_OCR_INTERVAL_SEC", "banana")
    assert frame_ocr.parse_interval_sec() == 5


def test_parse_phash_threshold_default():
    assert frame_ocr.parse_phash_threshold(None) == 8


def test_sample_frames_invokes_ffmpeg_with_correct_filter():
    """`_sample_frames` shells out to ffmpeg with `fps=1/N` filter."""
    fake_proc = MagicMock()
    fake_proc.stdout.read.return_value = b""  # empty pipe = no frames
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc) as popen:
        list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=5))
    args = popen.call_args[0][0]
    assert "ffmpeg" in args[0]
    assert "fps=1/5" in " ".join(args)
    assert "image2pipe" in " ".join(args)
    assert "mjpeg" in " ".join(args)


def test_sample_frames_yields_jpeg_chunks_separated_by_soi_marker():
    """Two JPEGs concatenated in the pipe yield two byte-chunks."""
    soi = b"\xff\xd8"
    chunk1 = soi + b"jpeg-frame-1-payload" + b"\xff\xd9"
    chunk2 = soi + b"jpeg-frame-2-payload" + b"\xff\xd9"
    fake_proc = MagicMock()
    # Simulate the SOI-split protocol: the helper reads in chunks and splits on b"\xff\xd8".
    fake_proc.stdout.read.side_effect = [chunk1 + chunk2, b""]
    fake_proc.wait.return_value = 0
    with patch("extractors.frame_ocr.subprocess.Popen", return_value=fake_proc):
        out = list(frame_ocr._sample_frames("/tmp/x.mp4", interval_sec=5))
    assert len(out) == 2
    assert out[0].startswith(soi)
    assert out[1].startswith(soi)
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_frame_ocr.py -v 2>&1 | tail -10
```

Expected: `_sample_frames` doesn't exist yet → AttributeError.

- [ ] **Step 3: Implement `_sample_frames`**

Append to `services/file-indexer/extractors/frame_ocr.py`:

```python
import subprocess


def _sample_frames(video_path: str | Path, *, interval_sec: int):
    """Yield JPEG-encoded frame bytes from ffmpeg, one per `interval_sec`.

    Reads ffmpeg stdout in chunks and splits on the JPEG SOI marker
    (0xFFD8). Each yielded chunk starts with SOI and is the bytes of one
    encoded JPEG frame.
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
            # Split on SOI markers; everything between two SOIs is one JPEG.
            while True:
                # Find the SECOND SOI marker (start of the NEXT frame).
                first = buf.find(JPEG_SOI_MARKER)
                if first == -1:
                    break
                second = buf.find(JPEG_SOI_MARKER, first + 2)
                if second == -1:
                    break
                yield buf[first:second]
                buf = buf[second:]
        # Trailing frame: whatever's left in `buf` after the last SOI is the final frame.
        if buf and buf.startswith(JPEG_SOI_MARKER):
            yield buf
    finally:
        proc.wait(timeout=10)
```

- [ ] **Step 4: Run tests to confirm 7 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_frame_ocr.py -v 2>&1 | tail -15
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/frame_ocr.py services/file-indexer/tests/test_frame_ocr.py
git commit -m "feat(file-indexer): frame_ocr._sample_frames via ffmpeg pipe (WARP-208)"
```

### Task 1.5: Phash + dedup + merge helpers

**Files:**
- Modify: `services/file-indexer/extractors/frame_ocr.py`
- Modify: `services/file-indexer/tests/test_frame_ocr.py`

- [ ] **Step 1: Write failing tests**

Append to `services/file-indexer/tests/test_frame_ocr.py`:

```python
def test_merge_segments_extends_end_to_next_start():
    segs = [
        frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="A"),
        frame_ocr.FrameSegment(start_sec=10, end_sec=15, text="B"),
        frame_ocr.FrameSegment(start_sec=30, end_sec=35, text="C"),
    ]
    merged = frame_ocr._merge_segments(segs)
    assert [(s.start_sec, s.end_sec) for s in merged] == [(0, 10), (10, 30), (30, 35)]


def test_merge_segments_empty_returns_empty():
    assert frame_ocr._merge_segments([]) == []


def test_merge_segments_single_segment_unchanged():
    seg = frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="A")
    assert frame_ocr._merge_segments([seg]) == [seg]


def test_phash_dedup_skips_similar_frames():
    """Two frames with hamming-distance < threshold → second skipped."""
    fake_hash_a = MagicMock()
    fake_hash_b = MagicMock()
    fake_hash_a.__sub__ = lambda self, other: 5  # very similar
    with patch("extractors.frame_ocr._phash_bytes", side_effect=[fake_hash_a, fake_hash_b]):
        kept = frame_ocr._dedup_by_phash(
            [b"frame-a", b"frame-b"],
            phash_threshold=8,
        )
    assert kept == [(0, b"frame-a")]  # only the first


def test_phash_dedup_keeps_distinct_frames():
    """Two frames with hamming-distance ≥ threshold → both kept."""
    fake_hash_a = MagicMock()
    fake_hash_b = MagicMock()
    fake_hash_a.__sub__ = lambda self, other: 20  # very different
    with patch("extractors.frame_ocr._phash_bytes", side_effect=[fake_hash_a, fake_hash_b]):
        kept = frame_ocr._dedup_by_phash(
            [b"frame-a", b"frame-b"],
            phash_threshold=8,
        )
    assert [idx for idx, _ in kept] == [0, 1]
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_frame_ocr.py::test_merge_segments_extends_end_to_next_start -v 2>&1 | tail -5
```

Expected: AttributeError on `_merge_segments`.

- [ ] **Step 3: Implement helpers**

Append to `services/file-indexer/extractors/frame_ocr.py`:

```python
def _phash_bytes(jpeg_bytes: bytes):
    """Compute a perceptual hash of a JPEG byte payload."""
    # Lazy import — keeps the module loadable even when imagehash isn't installed
    # (e.g. minimal dev envs). Frame OCR will degrade gracefully via the warning
    # path in extract_frame_text.
    import imagehash
    from PIL import Image
    return imagehash.phash(Image.open(io.BytesIO(jpeg_bytes)))


def _dedup_by_phash(
    frames: list[bytes],
    *,
    phash_threshold: int,
) -> list[tuple[int, bytes]]:
    """Filter frames where consecutive hamming-distance < phash_threshold.
    Returns (frame_index, frame_bytes) tuples for survivors. The frame_index
    is the index into the original list (so callers can compute timestamps).
    """
    kept: list[tuple[int, bytes]] = []
    prev_hash = None
    for idx, fb in enumerate(frames):
        try:
            cur_hash = _phash_bytes(fb)
        except Exception as exc:
            logger.debug("frame_ocr: phash failed on frame %d (%s) — skipping", idx, exc)
            continue
        if prev_hash is not None and (cur_hash - prev_hash) < phash_threshold:
            continue
        prev_hash = cur_hash
        kept.append((idx, fb))
    return kept


def _merge_segments(segments: list[FrameSegment]) -> list[FrameSegment]:
    """Extend each segment's end_sec to the next segment's start_sec.

    A slide that survives at 00:30 and is skipped (deduped) at 00:35,
    00:40, 00:45 produces one segment [00:30 → 00:50] instead of [00:30 → 00:35].
    """
    if not segments:
        return []
    out: list[FrameSegment] = []
    for i in range(len(segments) - 1):
        cur = segments[i]
        nxt = segments[i + 1]
        out.append(FrameSegment(start_sec=cur.start_sec, end_sec=nxt.start_sec, text=cur.text))
    out.append(segments[-1])
    return out
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_frame_ocr.py -v 2>&1 | tail -15
```

Expected: 12 passed (7 from prior tasks + 5 new).

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/frame_ocr.py services/file-indexer/tests/test_frame_ocr.py
git commit -m "feat(file-indexer): frame_ocr phash dedup + segment merge helpers (WARP-208)"
```

### Task 1.6: `extract_frame_text()` orchestrator

**Files:**
- Modify: `services/file-indexer/extractors/frame_ocr.py`
- Modify: `services/file-indexer/tests/test_frame_ocr.py`

- [ ] **Step 1: Write failing tests**

Append:

```python
def test_extract_frame_text_returns_empty_when_no_frames(tmp_path):
    """No-frame video → empty segments + zero stats."""
    fake_video = tmp_path / "empty.mp4"
    fake_video.write_bytes(b"")
    with patch("extractors.frame_ocr._sample_frames", return_value=iter([])):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert stats.frames_sampled == 0
    assert stats.frames_ocr_run == 0
    assert stats.segments_emitted == 0


def test_extract_frame_text_runs_ocr_on_distinct_frames(tmp_path):
    """3 distinct JPEGs → 3 phashes + 3 OCR calls + segment merge."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8frame-1", b"\xff\xd8frame-2", b"\xff\xd8frame-3"]
    # Distinct hashes
    hashes = [MagicMock(), MagicMock(), MagicMock()]
    for i, h in enumerate(hashes):
        h.__sub__ = lambda self, other: 30  # always > threshold

    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[("welcome", []), ("revenue", []), ("risk", [])]):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)

    assert [s.text for s in segs] == ["welcome", "revenue", "risk"]
    assert [s.start_sec for s in segs] == [0, 5, 10]
    assert stats.frames_sampled == 3
    assert stats.frames_ocr_run == 3
    assert stats.segments_emitted == 3
    assert stats.interval_sec_used == 5


def test_extract_frame_text_skips_empty_ocr_results(tmp_path):
    """OCR returning '' → frame skipped (no segment emitted) but phash still tracked."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8frame-1", b"\xff\xd8frame-2"]
    hashes = [MagicMock(), MagicMock()]
    for h in hashes:
        h.__sub__ = lambda self, other: 30

    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=hashes), \
         patch("extractors.frame_ocr._ocr_jpeg_bytes",
               side_effect=[("", []), ("real text", [])]):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)

    assert [s.text for s in segs] == ["real text"]
    assert stats.frames_sampled == 2
    assert stats.frames_ocr_run == 2  # both ran OCR
    assert stats.segments_emitted == 1


def test_extract_frame_text_handles_imagehash_missing(tmp_path):
    """ImportError on imagehash → return empty + warning, don't raise."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    frames = [b"\xff\xd8frame-1"]
    with patch("extractors.frame_ocr._sample_frames", return_value=iter(frames)), \
         patch("extractors.frame_ocr._phash_bytes", side_effect=ImportError("no imagehash")):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert any("frame_ocr_unavailable" in w for w in stats.warnings)


def test_extract_frame_text_handles_ffmpeg_failure(tmp_path):
    """ffmpeg subprocess raises → return empty + warning, don't raise."""
    fake_video = tmp_path / "x.mp4"
    fake_video.write_bytes(b"")
    with patch("extractors.frame_ocr._sample_frames",
               side_effect=subprocess.SubprocessError("ffmpeg crashed")):
        segs, stats = frame_ocr.extract_frame_text(fake_video, interval_sec=5)
    assert segs == []
    assert any("frame_ocr_sample_failed" in w for w in stats.warnings)
```

- [ ] **Step 2: Run tests to confirm failure**

Expected: `_ocr_jpeg_bytes` doesn't exist; `extract_frame_text` is still `NotImplementedError`.

- [ ] **Step 3: Implement `_ocr_jpeg_bytes` + `extract_frame_text`**

Replace the `NotImplementedError` stub:

```python
def _ocr_jpeg_bytes(jpeg_bytes: bytes) -> tuple[str, list[str]]:
    """Run Tesseract on raw JPEG bytes via the image extractor's helper.
    Returns (text, warnings)."""
    from extractors.image import _ocr_image_bytes
    return _ocr_image_bytes(jpeg_bytes)


def extract_frame_text(
    path: str | Path,
    *,
    interval_sec: int | None = None,
    phash_threshold: int | None = None,
) -> tuple[list[FrameSegment], FrameOCRStats]:
    """Sample → phash dedup → OCR → merge. Best-effort; never raises out."""
    interval = interval_sec if interval_sec is not None else parse_interval_sec()
    phash_thresh = phash_threshold if phash_threshold is not None else parse_phash_threshold()
    stats = FrameOCRStats(interval_sec_used=interval)

    # Phase 1: sample
    try:
        frames = list(_sample_frames(path, interval_sec=interval))
    except Exception as exc:
        logger.warning("frame_ocr: sample failed (%s)", exc)
        stats.warnings.append(f"frame_ocr_sample_failed:{exc}")
        return [], stats
    stats.frames_sampled = len(frames)
    if not frames:
        return [], stats

    # Phase 2: dedup (catches imagehash ImportError too)
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

    # Phase 3: OCR each survivor
    raw_segments: list[FrameSegment] = []
    for frame_idx, frame_bytes in survivors:
        stats.frames_ocr_run += 1
        try:
            text, _warnings = _ocr_jpeg_bytes(frame_bytes)
        except Exception as exc:
            logger.warning("frame_ocr: OCR failed on frame %d (%s)", frame_idx, exc)
            continue
        if not text.strip():
            continue
        raw_segments.append(FrameSegment(
            start_sec=frame_idx * interval,
            end_sec=(frame_idx + 1) * interval,  # provisional; merge step extends
            text=text.strip(),
        ))

    # Phase 4: merge consecutive segments' time ranges
    merged = _merge_segments(raw_segments)
    stats.segments_emitted = len(merged)
    return merged, stats
```

But wait — the test `test_extract_frame_text_handles_imagehash_missing` patches `_phash_bytes` to raise ImportError. The dedup helper currently catches a generic `Exception` and returns the partial list. Let me make the ImportError surface up:

The `_dedup_by_phash` helper above currently does `except Exception as exc: continue`. ImportError would be silently caught and we'd return an empty `kept` list (interpreted as zero survivors → zero OCR calls). The test expects `frame_ocr_unavailable` in warnings, which means the orchestrator function needs to detect this case.

Update `_dedup_by_phash` to NOT catch `ImportError` — let it propagate:

```python
def _dedup_by_phash(
    frames: list[bytes],
    *,
    phash_threshold: int,
) -> list[tuple[int, bytes]]:
    kept: list[tuple[int, bytes]] = []
    prev_hash = None
    for idx, fb in enumerate(frames):
        try:
            cur_hash = _phash_bytes(fb)
        except ImportError:
            raise  # propagate so extract_frame_text can return frame_ocr_unavailable
        except Exception as exc:
            logger.debug("frame_ocr: phash failed on frame %d (%s) — skipping", idx, exc)
            continue
        if prev_hash is not None and (cur_hash - prev_hash) < phash_threshold:
            continue
        prev_hash = cur_hash
        kept.append((idx, fb))
    return kept
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_frame_ocr.py -v 2>&1 | tail -20
```

Expected: 17 passed (12 from prior tasks + 5 new in this task).

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/extractors/frame_ocr.py services/file-indexer/tests/test_frame_ocr.py
git commit -m "feat(file-indexer): frame_ocr.extract_frame_text orchestrator (WARP-208)"
```

---

## Task 2: `video.py` integration

### Task 2.1: Wire `frame_ocr` into `video.extract`

**Files:**
- Modify: `services/file-indexer/extractors/video.py`
- Modify: `services/file-indexer/tests/test_video.py`

- [ ] **Step 1: Read existing `video.extract`**

```bash
grep -nA 50 "^def extract" services/file-indexer/extractors/video.py | head -80
```

Find where the function returns the `ExtractedDoc` (after the subtitle path or audio fallback completes).

- [ ] **Step 2: Write failing tests**

Append to `services/file-indexer/tests/test_video.py`:

```python
def test_video_extract_skips_frame_ocr_when_disabled(monkeypatch, tmp_path):
    """VIDEO_FRAME_OCR_ENABLED unset → frame_ocr.extract_frame_text never called."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.delenv("VIDEO_FRAME_OCR_ENABLED", raising=False)

    with patch("extractors.video._extract_subtitles_only_or_audio_fallback",
               return_value={"text": "subs only", "page_breaks": [],
                             "language": None, "metadata": {"subtitle_source": "embedded"},
                             "warnings": []}), \
         patch("extractors.video.frame_ocr.extract_frame_text") as mock_frame:
        result = video.extract(fake_video, "video/mp4")

    mock_frame.assert_not_called()
    assert result["metadata"]["subtitle_source"] == "embedded"
    assert "Frame OCR" not in result["text"]


def test_video_extract_runs_frame_ocr_when_enabled_and_appends_section(monkeypatch, tmp_path):
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    fake_segments = [
        frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="welcome"),
        frame_ocr.FrameSegment(start_sec=5, end_sec=10, text="revenue"),
    ]
    fake_stats = frame_ocr.FrameOCRStats(
        frames_sampled=10, frames_ocr_run=2, segments_emitted=2, interval_sec_used=5,
    )

    with patch("extractors.video._extract_subtitles_only_or_audio_fallback",
               return_value={"text": "subtitle text", "page_breaks": [],
                             "language": "en",
                             "metadata": {"subtitle_source": "embedded"},
                             "warnings": []}), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=(fake_segments, fake_stats)):
        result = video.extract(fake_video, "video/mp4")

    # Combined text contains both channels.
    assert "subtitle text" in result["text"]
    assert "--- Frame OCR ---" in result["text"]
    assert "[00:00 → 00:05] welcome" in result["text"]
    assert "[00:05 → 00:10] revenue" in result["text"]
    # Combined provenance.
    assert result["metadata"]["subtitle_source"] == "embedded+frame_ocr"
    # Stats dict surfaced.
    assert result["metadata"]["frame_ocr"]["segments_emitted"] == 2


def test_video_extract_subtitle_source_when_only_frame_ocr(monkeypatch, tmp_path):
    """No subs, audio fallback empty, frame OCR has text → 'frame_ocr_only'."""
    fake_video = tmp_path / "demo.mp4"
    fake_video.write_bytes(b"\x00")

    monkeypatch.setenv("VIDEO_FRAME_OCR_ENABLED", "1")

    fake_segments = [frame_ocr.FrameSegment(start_sec=0, end_sec=5, text="text")]
    fake_stats = frame_ocr.FrameOCRStats(segments_emitted=1)

    with patch("extractors.video._extract_subtitles_only_or_audio_fallback",
               return_value={"text": "", "page_breaks": [],
                             "language": None,
                             "metadata": {"subtitle_source": "asr_transcript"},
                             "warnings": []}), \
         patch("extractors.video.frame_ocr.extract_frame_text",
               return_value=(fake_segments, fake_stats)):
        result = video.extract(fake_video, "video/mp4")

    assert result["metadata"]["subtitle_source"] == "frame_ocr_only"
```

(The plan refers to a `_extract_subtitles_only_or_audio_fallback` function that may not exist. The Dev should either rename the existing inner code into this helper OR adjust the test patch target to whatever the actual code path is. Pattern: extract the existing subtitle/audio decision tree into a private helper for testability, then the new code calls it before optionally adding frame OCR.)

- [ ] **Step 3: Run tests to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_video.py -v -k "frame_ocr" 2>&1 | tail -10
```

Expected: 3 failures.

- [ ] **Step 4: Refactor `video.extract` to support frame OCR**

In `services/file-indexer/extractors/video.py`:

1. Rename the existing logic that picks subtitles or audio fallback into a private helper `_extract_subtitles_or_audio_fallback(path, mime) -> ExtractedDoc | None`. This makes it testable + composable.

2. Modify `extract(path, mime)` to:

```python
import os
from extractors import frame_ocr


def extract(path, mime):
    base = _extract_subtitles_or_audio_fallback(path, mime)
    if base is None:
        return None

    if os.environ.get("VIDEO_FRAME_OCR_ENABLED", "0") != "1":
        return base

    # Frame OCR enabled — append.
    segments, stats = frame_ocr.extract_frame_text(path)

    if not segments:
        # Frame OCR ran but produced nothing — pass stats warnings through but
        # don't change the text or subtitle_source.
        if stats.warnings:
            base.setdefault("warnings", []).extend(stats.warnings)
        base["metadata"]["frame_ocr"] = {
            "frames_sampled": stats.frames_sampled,
            "frames_ocr_run": stats.frames_ocr_run,
            "segments_emitted": stats.segments_emitted,
            "interval_sec_used": stats.interval_sec_used,
        }
        return base

    # Render frame-OCR section.
    section_lines = ["", "--- Frame OCR ---"]
    for seg in segments:
        section_lines.append(f"[{_fmt_ts(seg.start_sec)} → {_fmt_ts(seg.end_sec)}] {seg.text}")
    frame_section = "\n".join(section_lines)

    base_text = base.get("text", "")
    base["text"] = base_text + "\n" + frame_section if base_text else frame_section.lstrip("\n")

    # Combine provenance.
    base_source = base["metadata"].get("subtitle_source")
    if not base_text:
        base["metadata"]["subtitle_source"] = "frame_ocr_only"
    elif base_source in ("embedded", "asr_transcript"):
        base["metadata"]["subtitle_source"] = f"{base_source}+frame_ocr"
    else:
        base["metadata"]["subtitle_source"] = "frame_ocr_only"

    base["metadata"]["frame_ocr"] = {
        "frames_sampled": stats.frames_sampled,
        "frames_ocr_run": stats.frames_ocr_run,
        "segments_emitted": stats.segments_emitted,
        "interval_sec_used": stats.interval_sec_used,
    }
    if stats.warnings:
        base.setdefault("warnings", []).extend(stats.warnings)

    return base


def _fmt_ts(sec: int) -> str:
    return f"{sec // 60:02d}:{sec % 60:02d}"
```

- [ ] **Step 5: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_video.py -v 2>&1 | tail -15
```

Expected: all video tests green (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/video.py services/file-indexer/tests/test_video.py
git commit -m "feat(file-indexer): video.extract integrates frame OCR when enabled (WARP-208)"
```

---

## Task 3: Optional — drawtext fixture

### Task 3.1: Generate the fixture

**Files:**
- Create: `services/file-indexer/tests/fixtures/with-frame-text.mp4`

- [ ] **Step 1: Generate via ffmpeg**

```bash
ffmpeg -y -f lavfi -i "color=c=white:s=320x240:r=1:d=15" \
  -vf "drawtext=text='Welcome':fontsize=40:fontcolor=black:enable='between(t,0,5)',\
drawtext=text='Revenue':fontsize=40:fontcolor=black:enable='between(t,5,10)',\
drawtext=text='Risk':fontsize=40:fontcolor=black:enable='between(t,10,15)'" \
  -t 15 \
  services/file-indexer/tests/fixtures/with-frame-text.mp4
```

Expected: ~50KB file with 3 text-bearing time-slices.

- [ ] **Step 2: Verify fixture is reasonable**

```bash
ffprobe -v error -show_streams services/file-indexer/tests/fixtures/with-frame-text.mp4 2>&1 | grep -E "duration|codec_type"
```

Expected: 15 seconds, 1 video stream.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/tests/fixtures/with-frame-text.mp4
git commit -m "test(file-indexer): drawtext fixture for frame OCR integration test (WARP-208)"
```

(This task is **optional** — if generating the fixture is awkward in the Dev's environment, the unit tests with mocked frames already cover the contract. Skip with a note in the self-assessment.)

---

## Task 4: Docs + smoke

### Task 4.1: `docs/RAG_TESTING.md` update

**Files:**
- Modify: `docs/RAG_TESTING.md`

- [ ] **Step 1: Append a "Frame OCR (WARP-208)" section** under the "Deferred ASR (WARP-218)" section already there:

```markdown
## Frame OCR (WARP-208)

Off by default. When `VIDEO_FRAME_OCR_ENABLED=1`, video uploads also get
frame OCR alongside subtitles or ASR — useful for screencasts, slide decks,
signage videos where the on-screen text is the primary signal.

### Knobs

| Env var | Default | Range | Notes |
|---|---|---|---|
| `VIDEO_FRAME_OCR_ENABLED` | `0` (off) | `0|1` | Master switch |
| `VIDEO_FRAME_OCR_INTERVAL_SEC` | `5` | `1..60` | Lower = more frames sampled = more OCR cost |
| `VIDEO_FRAME_OCR_PHASH_THRESHOLD` | `8` | `0..64` | Hamming-distance threshold for pre-OCR dedup. Lower = more frames pass through to OCR. |

### Cost on a 60-min screencast

- Frame sampling (720 frames): ~10s
- 720 phashes: ~5s
- Surviving OCR calls (~5 distinct slides): ~1s
- **Total frame-OCR cost: ~15-20s on top of the existing ASR path.**

Negligible at the WARP-218 deferred-window timescale (the ASR call itself dominates).

### Output

Frame OCR text is appended to the video's existing transcript under a
sentinel separator:

```
budget meeting kickoff
projecting q4 revenue at one hundred thousand

--- Frame OCR ---
[00:00 → 00:30] Welcome to Q4 Planning · Acme Corp
[00:30 → 02:15] Revenue Targets — $100K MRR by EOY
```

`metadata.subtitle_source` carries the combined provenance: `embedded+frame_ocr`,
`asr_transcript+frame_ocr`, or `frame_ocr_only`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RAG_TESTING.md
git commit -m "docs(rag): operator notes for frame OCR (WARP-208)"
```

### Task 4.2: Final test runs

- [ ] **Step 1: Full suites**

```bash
cd services/file-indexer && python -m pytest tests/ -v 2>&1 | tail -15
cd ../../apps/orchestrator && npm test 2>&1 | tail -10
```

Expected: green on both. The WARP-208 changes are purely additive in file-indexer.

- [ ] **Step 2: Push**

```bash
git push -u origin WARP-208
```

- [ ] **Step 3: Hand off to QA**

Do NOT open the PR. Return a self-assessment with the same section headers as prior Phase 2/3 Devs (What I built / Tests / Decisions / Known limits / Manager-call items / Local-validation snapshot / Commit log).

---

## Self-review checklist (pre-push)

1. **Spec coverage:** §3 architecture → Task 1 + 2; §4 file map → all files; §5 per-frame pipeline → 1.4/1.5/1.6 each step; §6 image refactor → Task 1.2; §7 error handling → tests in 1.6; §8 testing → 17 unit cases; §9 phasing → tasks ordered as specified.

2. **No placeholders.** Search for TODO/TBD/FIXME — none should appear except in this checklist.

3. **Type consistency.** `FrameSegment` shape, `FrameOCRStats` fields, env-var names (`VIDEO_FRAME_OCR_ENABLED`, `VIDEO_FRAME_OCR_INTERVAL_SEC`, `VIDEO_FRAME_OCR_PHASH_THRESHOLD`), `subtitle_source` enum strings (`embedded+frame_ocr`, `asr_transcript+frame_ocr`, `frame_ocr_only`), separator string (`--- Frame OCR ---`) — all uniform across modules + tests + docs.

4. **No forbidden surfaces:** no `@droplet/tools-core`, no `setup.sh`, no edits to existing migrations, no production Compose secrets.

5. **Tests run green at every task** — frequent commits per the bite-sized step pattern.

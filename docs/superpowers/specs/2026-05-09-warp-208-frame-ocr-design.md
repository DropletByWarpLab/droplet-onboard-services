# WARP-208 — Frame OCR for video extractor

**Status:** Design — pending user review
**Owner:** Brain memory team
**Date:** 2026-05-09
**Phase 2 reference:** [`docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md`](./2026-05-07-rag-phase-2-extractors-design.md) (§4.2 video)
**Phase 3.1 reference:** [`docs/superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md`](./2026-05-08-warp-218-deferred-asr-design.md)
**Tickets:** WARP-208 (this), WARP-223 (runtime feature-flag subsystem — filed; this PR ships with env var, future migration adopts the flag)

## 1. Goals

Extend WARP-198's video extractor with **frame OCR** as a third text channel alongside subtitles and ASR. When `VIDEO_FRAME_OCR_ENABLED=1`:

- Sample frames every `VIDEO_FRAME_OCR_INTERVAL_SEC` seconds (default 5, env-overridable, clamped to `[1, 60]`)
- Perceptually-hash-dedup with `imagehash.phash` BEFORE OCR (skip frames whose hamming distance from the previous survivor is `< VIDEO_FRAME_OCR_PHASH_THRESHOLD`, default 8)
- Run survivors through Tesseract via the existing `extractors.image` helper (inherits `OCR_CONFIDENCE_THRESHOLD` from WARP-201)
- Merge results into the existing `text` with timestamp-tagged segments
- Tag `metadata.subtitle_source` with the combined channel (e.g. `asr_transcript+frame_ocr`)

**Off by default.** Operators opt in via env var. When off, behavior is exactly WARP-198 today.

**Defers to WARP-218.** Frame OCR work happens inside `transcription_worker.run_one()` during the daily 03:00 window. No mid-flight inline OCR. The brain-memory upload path already routes audio/video to `queued_for_transcription`; frame OCR adds ~15-20s on top of the existing ASR cost — negligible at the deferred-window timescale.

## 2. Non-goals

- **Streaming live-video OCR** — Phase 3+ ticket (related: WARP-209 streaming ASR).
- **Per-frame language detection** — uses whatever `OCR_LANG` env var the image extractor already honors.
- **ML-based slide detection** — phash dedup catches slide transitions reliably; YAGNI.
- **Adaptive sampling** (scene-change-aware) — fixed-interval + dedup is the standard pattern.
- **Inline (non-deferred) frame OCR** — defers always when enabled (per Q3).
- **Operator UI for the toggle** — env var for v1; WARP-223 will migrate this to the runtime flag system once it lands.

## 3. Architecture

```
   ┌─── orchestrator (existing — no change) ────────────────────┐
   │  audio/video upload → INSERT BrainMemoryItem               │
   │  status='queued_for_transcription' (WARP-218)              │
   └────────────────────────────────────────────────────────────┘
                          │
                          ▼ daily 03:00 OR transcribe-now
   ┌─── file-indexer ────────────────────────────────────────────┐
   │  transcription_worker.run_one(itemId)                       │
   │     ↓                                                       │
   │  registry.dispatch(path, mime, depth=0)                     │
   │     ↓                                                       │
   │  video.extract(path, mime)                                  │
   │     │                                                       │
   │     ├── existing path: subtitles OR ASR fallback            │
   │     │       (text + metadata.subtitle_source set)           │
   │     │                                                       │
   │     └── NEW path (when VIDEO_FRAME_OCR_ENABLED=1):          │
   │         frame_ocr.extract_frame_text(path, interval_sec)    │
   │           - ffmpeg fps=1/N → JPEG byte stream               │
   │           - imagehash.phash(frame) — hamming<8 → skip OCR   │
   │           - run survivors through                           │
   │             extractors.image._ocr_image_bytes()             │
   │           - emit list[FrameSegment] with timestamp ranges   │
   │                                                             │
   │         merge into result["text"] under separator           │
   │         "\n\n--- Frame OCR ---\n[mm:ss → mm:ss] text..."    │
   │                                                             │
   │         tag metadata.subtitle_source =                      │
   │           "embedded+frame_ocr" / "asr_transcript+frame_ocr" │
   │           / "frame_ocr_only" (no subs and ASR empty)        │
   │                                                             │
   │         tag metadata.frame_ocr =                            │
   │           {frames_sampled, frames_ocr_run,                  │
   │            segments_emitted, interval_sec_used}             │
   └─────────────────────────────────────────────────────────────┘
```

**Boundaries.**

- **New file** `services/file-indexer/extractors/frame_ocr.py` — single-responsibility unit: sampling + dedup + per-frame OCR + segment merge. Public surface: `extract_frame_text(path, *, interval_sec, phash_threshold) -> tuple[list[FrameSegment], FrameOCRStats]`.
- **`services/file-indexer/extractors/video.py` modified** — calls `frame_ocr.extract_frame_text` after the existing subtitle/ASR branch when the flag is on. Merges results into the returned `ExtractedDoc`.
- **Reuses** `extractors.image._ocr_image_bytes()` (or extracts a shared helper if the existing function isn't reusable as-is — see §6).
- **No changes** to `transcription_worker.py`, `scheduler_service.py`, or the orchestrator. Frame OCR runs purely inside the existing video-extractor invocation.

## 4. File structure

| Path | Status | Responsibility |
|---|---|---|
| `services/file-indexer/extractors/frame_ocr.py` | **new** | Frame sampling (ffmpeg → JPEG bytes), phash dedup, per-frame OCR, segment merge. ~120 LoC. |
| `services/file-indexer/extractors/video.py` | modify | Call `frame_ocr.extract_frame_text` after subtitle/ASR. Merge text + metadata. ~30 LoC additions. |
| `services/file-indexer/extractors/image.py` | modify (if needed) | Extract `_ocr_image_bytes(jpeg_bytes) -> tuple[str, list[str]]` helper if it doesn't already exist as a reusable function. ~20 LoC refactor. |
| `services/file-indexer/requirements.txt` | modify | Add `imagehash==4.3.1` (~20KB pip dep, MIT licensed). Pillow is already transitive via pytesseract. |
| `services/file-indexer/tests/test_frame_ocr.py` | **new** | All `frame_ocr.py` behaviors (~12 cases). |
| `services/file-indexer/tests/test_video.py` | modify | Extend with frame-OCR-enabled assertions (~3 cases). |
| `services/file-indexer/tests/fixtures/with-frame-text.mp4` | **new** | 5-second test video where each frame has rendered text (e.g. 3 frames × text overlay). Generated via ffmpeg `drawtext` filter at fixture-build time, committed as a tiny binary. |
| `docs/RAG_TESTING.md` | modify | Operator notes on enabling frame OCR + cost expectations. |
| `CLAUDE.md` | (no change) | The "no while-true" + "no guessing" rules from prior tickets continue to apply; no new standards. |

Note: WARP-223 (feature flag subsystem) is filed but not a dependency. This ticket ships with `VIDEO_FRAME_OCR_ENABLED` as an env var; the flag system migrates the toggle later.

## 5. Per-frame pipeline

### 5.1 Sampling (ffmpeg)

```bash
ffmpeg -hide_banner -loglevel error \
       -i <video_path> \
       -vf "fps=1/${INTERVAL_SEC}" \
       -q:v 2 \
       -f image2pipe -vcodec mjpeg -
```

- `fps=1/N` filter takes one frame per N seconds. Configurable via `VIDEO_FRAME_OCR_INTERVAL_SEC` (default 5, clamped to `[1, 60]`).
- `-f image2pipe -vcodec mjpeg -` streams JPEG frames to stdout. We read them as bytes — no per-frame disk write.
- We split the stream by SOI marker (`0xFFD8`): accumulate bytes until we see the next SOI, yield the prior chunk.

The frame's wall-clock timestamp inside the video = `frame_index * interval_sec`. `fps=1/N` produces predictable cadence so we don't need ffprobe per-frame.

### 5.2 Dedup (imagehash phash, before OCR)

```python
import io
from PIL import Image
import imagehash

def _phash_bytes(jpeg_bytes: bytes) -> imagehash.ImageHash:
    return imagehash.phash(Image.open(io.BytesIO(jpeg_bytes)))
```

For each sampled frame:
- Compute phash
- If `(prev_hash is not None) AND (cur_hash - prev_hash) < phash_threshold` → skip OCR for this frame
- Else: run OCR, emit a `FrameSegment`, update `prev_hash`

`phash_threshold` defaults to 8 (env: `VIDEO_FRAME_OCR_PHASH_THRESHOLD`, range `[0, 64]`). 0 = pixel-perfect match required; 64 = always different. 8 is the standard "very similar" cutoff that catches slide transitions reliably while ignoring video compression artifacts.

**Why phash before OCR**: Tesseract is the expensive call (~200ms per frame typical). phash is a single PIL load + a fast bitwise op (~5ms). For a 60-min screencast with 5 distinct slides, phash-before brings us from ~720 OCR calls to ~5. That's the main cost-reduction lever in the design.

### 5.3 Per-frame OCR (reuse image extractor)

`extractors.image` already has the Tesseract-with-confidence-threshold logic for WARP-201's image extractor. If a reusable `_ocr_image_bytes(jpeg_bytes) -> tuple[str, list[str]]` helper exists, frame_ocr imports it directly. If not, the implementation extracts the inner OCR call into a new shared helper and updates the image extractor to use it. This keeps the Tesseract logic in one place — confidence threshold, language config, low-confidence warning handling all stay at WARP-201's spec.

The OCR call returns:
- `text: str` (empty if Tesseract returned nothing or all chars were below confidence)
- `warnings: list[str]` (e.g. `low_confidence_ocr` when mean confidence < threshold)

If `text` is empty → skip emitting a `FrameSegment` for this frame. Phash is still updated so the dedup chain stays consistent.

### 5.4 Segment shape + merge

```python
@dataclass
class FrameSegment:
    start_sec: int
    end_sec: int
    text: str
```

After all frames are processed:

```python
def _merge_segments(segments: list[FrameSegment]) -> list[FrameSegment]:
    """Extend each segment's end_sec to the next segment's start_sec.
    A slide that survives at 00:30 and is skipped (deduped) at 00:35,
    00:40, 00:45 produces one segment [00:30 → 00:50] instead of [00:30 → 00:35]."""
    if not segments:
        return []
    out = []
    for i, seg in enumerate(segments[:-1]):
        out.append(FrameSegment(seg.start_sec, segments[i+1].start_sec, seg.text))
    out.append(segments[-1])
    return out
```

Each merged segment is rendered as `"[mm:ss → mm:ss] <text>"`.

### 5.5 Final text shape (when subtitles + frame OCR both run)

```
budget meeting kickoff
projecting q4 revenue at one hundred thousand

--- Frame OCR ---
[00:00 → 00:30] Welcome to Q4 Planning · Acme Corp
[00:30 → 02:15] Revenue Targets — $100K MRR by EOY
[02:15 → 03:45] Risk Mitigation — three top concerns...
```

The `--- Frame OCR ---` separator is a known sentinel — chunker treats it like the email's `--- Attachment: <name> ---` separator (text-level boundary, no special chunking).

### 5.6 Metadata flow

| Subtitle path | ASR fallback | Frame OCR | `metadata.subtitle_source` |
|---|---|---|---|
| ✓ | — | ✓ | `embedded+frame_ocr` |
| — | ✓ | ✓ | `asr_transcript+frame_ocr` |
| — | empty | ✓ | `frame_ocr_only` |
| ✓ | — | (disabled) | `embedded` (unchanged from WARP-198) |
| — | ✓ | (disabled) | `asr_transcript` (unchanged) |

`metadata.frame_ocr` (new sub-dict): `{ frames_sampled, frames_ocr_run, segments_emitted, interval_sec_used }`. Useful for operators triaging cost / quality.

`page_breaks`: the frame-OCR section's per-segment-end character offsets append to the existing `page_breaks` array. Future citation features can jump to a timestamp for frame-OCR results.

## 6. Refactor of `extractors/image.py` (if needed)

Frame OCR reuses Tesseract via the image extractor. Two cases:

**Case A: `extractors.image` already exposes a reusable byte-OCR helper.** Then frame_ocr imports it directly. No image-extractor change needed.

**Case B: image extractor is monolithic** (single `extract(path, mime)` doing file-load + OCR + warnings inline). Then we extract a private helper:

```python
# services/file-indexer/extractors/image.py

def _ocr_image_bytes(jpeg_or_png_bytes: bytes) -> tuple[str, list[str]]:
    """Run Tesseract on raw image bytes. Returns (text, warnings).

    Shared by:
      - extract(path, mime) → opens file from disk, calls this helper
      - frame_ocr (WARP-208) → opens JPEG bytes from ffmpeg pipe

    Honors OCR_CONFIDENCE_THRESHOLD + OCR_LANG env vars (existing WARP-201 contract).
    """
    img = Image.open(io.BytesIO(jpeg_or_png_bytes))
    # ... existing Tesseract-with-confidence logic moved here ...
    return text, warnings
```

`extract(path, mime)` in `image.py` then becomes a thin wrapper that loads the file and delegates. Existing tests (`test_extractors_image.py`) keep passing — the contract is unchanged from the caller's perspective; only the internal seam is new.

The plan task picks Case A or Case B based on what's already in the file.

## 7. Error handling

| Failure | Behavior |
|---|---|
| ffmpeg sample subprocess fails (bad video, codec issue) | Log warning, append `frame_ocr_sample_failed:<exc>` to `metadata.warnings`, return whatever subtitle/ASR path produced. Frame OCR is best-effort. |
| Single-frame phash fails (corrupt JPEG bytes from a partial pipe read) | Skip just that frame, log debug, continue with the next. |
| Single-frame OCR fails (Tesseract crash on a weird image) | Skip just that frame, log warning. Other frames keep going. |
| `imagehash` lib not installed | Lazy ImportError at module load → `metadata.warnings.append("frame_ocr_unavailable")` + skip the frame-OCR pass entirely. Subtitle/ASR result still returned. Same graceful-degrade pattern as WARP-197's faster-whisper missing case. |
| All frames deduped (e.g. completely static video) | Emit zero segments. `subtitle_source` stays at the subtitle/ASR-only value. `metadata.frame_ocr.segments_emitted = 0`. Not an error. |
| All frames OCR'd but every result was empty (e.g. video with no on-screen text) | Same as above — zero segments. |
| Operator sets garbage `VIDEO_FRAME_OCR_INTERVAL_SEC` (e.g. `"banana"`, `"-5"`, `"999"`) | Log warning, fall back to default 5. Range clamped to `[1, 60]`. Same pattern as WARP-218's `_parse_run_time`. |

**No automatic retries.** A failed frame is permanently skipped within this run — the daily worker's existing per-item retry cap (max 3/hour from WARP-218) covers transient sampling/OCR failures at the item level.

## 8. Testing

### 8.1 Unit tests in `services/file-indexer/tests/test_frame_ocr.py`

- `test_extract_frame_text_returns_empty_when_disabled` — `VIDEO_FRAME_OCR_ENABLED=0` → returns `([], stats)` regardless of video content.
- `test_extract_frame_text_samples_at_interval_default_5sec` — mock ffmpeg pipe; verify the call uses `fps=1/5`.
- `test_extract_frame_text_honors_interval_env_var` — `VIDEO_FRAME_OCR_INTERVAL_SEC=10` → `fps=1/10`.
- `test_extract_frame_text_clamps_interval_to_range` — `999` and `-5` and `"banana"` all fall back to default 5.
- `test_phash_dedup_skips_similar_frames` — feed two JPEGs with `hamming_distance=2` → second is skipped (no OCR).
- `test_phash_dedup_runs_ocr_when_distinct` — feed two JPEGs with `hamming_distance=20` → both OCR'd.
- `test_segment_merge_extends_end_to_next_start` — 3 surviving segments at [0,10,30] → emitted as `[(0,10), (10,30), (30, default_end)]`.
- `test_extract_frame_text_skips_empty_ocr_results` — frame OCR returns `""` → no `FrameSegment` emitted, but phash still updated.
- `test_extract_frame_text_handles_ffmpeg_failure_gracefully` — mock subprocess raises → returns `([], stats_with_warning)` not raise.
- `test_extract_frame_text_handles_imagehash_missing` — mock import error → returns `([], stats_with_warning)`.
- `test_metadata_subtitle_source_combinations` — when video extractor merges, `embedded+frame_ocr` / `asr_transcript+frame_ocr` / `frame_ocr_only` cases all produce correct strings.
- `test_metadata_frame_ocr_dict_populated` — `frames_sampled`, `frames_ocr_run`, `segments_emitted`, `interval_sec_used` all set correctly.

### 8.2 Existing test extensions in `test_video.py`

- `test_video_with_frame_ocr_enabled_appends_section` — small fixture with subtitles, with `VIDEO_FRAME_OCR_ENABLED=1`, verify text contains `--- Frame OCR ---` separator.
- `test_video_with_frame_ocr_disabled_does_not_call_extract` — flag off → mocked `frame_ocr.extract_frame_text` never called.
- `test_video_no_subs_no_audio_text_frame_ocr_only` — verify `subtitle_source = "frame_ocr_only"` in the all-fallback case.

### 8.3 Fixture: `services/file-indexer/tests/fixtures/with-frame-text.mp4`

Generated once at fixture-build time via ffmpeg `drawtext`, committed as a tiny binary (~50KB):

```bash
ffmpeg -y \
  -f lavfi -i "color=c=white:s=320x240:r=1:d=15" \
  -vf "drawtext=text='Welcome' :fontsize=40:fontcolor=black: \
       enable='between(t,0,5)', \
       drawtext=text='Revenue':fontsize=40:fontcolor=black: \
       enable='between(t,5,10)', \
       drawtext=text='Risk':fontsize=40:fontcolor=black: \
       enable='between(t,10,15)'" \
  -t 15 with-frame-text.mp4
```

3 distinct text frames over 15 seconds — predictable phash distances + predictable Tesseract output. The fixture's content is checked into the repo; not regenerated per-CI-run.

### 8.4 Manual smoke (post-build)

1. Set `VIDEO_FRAME_OCR_ENABLED=1` and `VIDEO_FRAME_OCR_INTERVAL_SEC=2` in the test stack.
2. Drop a real screencast (any `.mp4` with on-screen text) into Nextcloud OR via brain memory upload.
3. Force the daily run early via `transcribe-now` (WARP-218).
4. Watch file-indexer logs for `frame_ocr.extract_frame_text` activity.
5. `docker compose exec db psql -U droplet -d droplet -c 'SELECT text FROM "FileContentChunk" ORDER BY "indexedAt" DESC LIMIT 3;'` — confirm text contains `--- Frame OCR ---` and timestamp segments.
6. Hit `/knowledge` in the dashboard — confirm citation chip's source-channel badge shows the combined provenance (e.g. "Transcribed by ASR + frame OCR" — already supported by WARP-214's `SourceChannelBadge` component for any `subtitle_source` it doesn't recognize).

Document smoke result in PR body.

## 9. Phasing

**Single PR.** ~5 files touched, ~250 LoC including tests. Estimated 3-4 hours of agent time.

Order within the PR:
1. `imagehash` dep added to requirements
2. (If needed) `image.py` refactor to expose `_ocr_image_bytes`
3. `frame_ocr.py` implementation (sampling + dedup + per-frame OCR + merge)
4. `frame_ocr.py` unit tests
5. `video.py` integration (call when flag is set, merge text + metadata)
6. `video.py` test extensions
7. Fixture generation + commit
8. `docs/RAG_TESTING.md` operator notes
9. Manual smoke + push

**Blocks:** nothing.
**Unblocks:** WARP-223 has one fewer env var to absorb (frame_ocr) when it lands.

## 10. Open questions

None. Q1–Q3 of the brainstorm + the feature-flag question all resolved:

- Q1: frame OCR ALWAYS runs when enabled, in addition to subtitles/ASR (combined provenance)
- Q2: 5-sec sampling default + imagehash phash dedup BEFORE OCR (hamming<8); timestamp-tagged segments default on
- Q3: frame OCR work defers to WARP-218's daily run (no new scheduler)
- Feature flags: env var for v1; WARP-223 will migrate to runtime flag system later

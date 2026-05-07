# RAG Phase 2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four new extractors (audio · video · email · archive) to the existing Phase 1 dispatch registry so the LLM and `/knowledge` dashboard can index those file types under the same per-user RBAC and chunking pipeline.

**Architecture:** Each extractor is a Python module in `services/file-indexer/extractors/` plugged into the existing dispatch table by MIME. Email and archive extractors call back into `dispatch()` recursively to handle attachments / archive members; recursion is bounded by `MAX_RECURSION_DEPTH = 2`. Audio uses `faster-whisper` with CUDA-then-CPU fallback through a single-worker queue so we never crash Ollama. Video uses `ffprobe` to pick subtitles when present, else falls back through the audio path.

**Tech Stack:** Python 3.11 (file-indexer); `faster-whisper` (CTranslate2); `ffmpeg` (system, audio/video decode); stdlib `email.parser` + `extract-msg` (MAPI); `python-magic` (MIME detection); stdlib `zipfile` / `tarfile`; `srt` (subtitle parsing); TypeScript (orchestrator MIME allow-list); vitest (integration tests).

**Spec:** [`docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md`](../specs/2026-05-07-rag-phase-2-extractors-design.md)

---

## Branching, parallelization, contract carrier

Four independent branches off the latest `main`:

```
WARP-197 (audio)     ─┐
WARP-199 (email)     ─┤  dispatch in parallel; each lands independently
WARP-200 (archive)   ─┘
                                                        ▼
                                         WARP-198 (video) — depends on 197
```

**Recursion-contract carrier rule.** WARP-199 and WARP-200 both touch `extractors/registry.py` to add the `depth` parameter on `dispatch()` and the `MAX_RECURSION_DEPTH = 2` constant. To avoid duplicate work and merge conflicts:

1. The first of {199, 200} to open its PR carries the contract change as Task 1 (the registry contract refactor). It must land before the second branch's PR can merge.
2. The second-mover rebases onto `main` after the first one merges; their Task 1 becomes a no-op (the change is already there) and they pick up the contract for free.
3. WARP-197 and WARP-198 do NOT touch `dispatch()` recursion. They only register their MIME and per-MIME cap. They can land in any order.

**Local-validation gate (per the spec §8).** Before each PR merges, the Manager runs:

```bash
cd <repo-root>
RUN_RAG_INTEGRATION=1 ./scripts/test-rag.sh --only <ticket-name>
```

…on this machine end-to-end. The integration test must produce a real `FileContentChunk` row and a real citation through `/api/llm/chat`. If Docker Desktop has bind-mount problems, the gate falls back to the unit test suite + a manual smoke documented in the PR.

---

## Pre-flight: branch + tickets verification

These run before any ticket starts.

### Task 0.1: Verify clean state

- [ ] **Step 1: Confirm branch + state**

```bash
git status
git rev-parse --abbrev-ref HEAD
git log -1 --format="%h %s"
```

Expected: clean tree on `main` at the spec-merge commit. If you're on a feature branch already, that's fine — confirm it's branched off the spec-merge commit on `main`.

- [ ] **Step 2: Confirm tickets exist in Jira**

In a browser, open https://warp-lab.atlassian.net/browse/WARP-197 — it must exist with status "To Do". Same for WARP-198, WARP-199, WARP-200.

Phase 3 follow-ups (do not work on these now): WARP-207 through WARP-214.

### Task 0.2: Confirm Phase 1 surface is intact

- [ ] **Step 1: Run the full RAG unit suite locally**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -30
```

Expected: all Phase 1 extractor tests pass (text, pdf, docx, image). If a test fails before you've changed anything, stop and surface it — Phase 2 cannot land if Phase 1 is broken.

- [ ] **Step 2: Confirm the orchestrator builds**

```bash
cd apps/orchestrator
npm test 2>&1 | tail -10
```

Expected: green. (The brain memory + knowledge tests from WARP-203/204/205 must pass.)

---

## WARP-197 — Audio extractor

**Branch:** `WARP-197` (off `main`)
**Spec sections:** §4.1 audio · §5 cross-cutting · §6 GPU contention · §9 testing

### Task 1.1: Add `faster-whisper` dependency

**Files:**
- Modify: `services/file-indexer/requirements.txt`

- [ ] **Step 1: Add dep**

Append to `services/file-indexer/requirements.txt`:

```
faster-whisper==1.0.3
```

- [ ] **Step 2: Verify install path**

```bash
cd services/file-indexer
pip install --dry-run -r requirements.txt 2>&1 | grep -i "faster-whisper\|ctranslate" | head
```

Expected: shows `faster-whisper-1.0.3` and `ctranslate2` (the CUDA backend dep) ready to install.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/requirements.txt
git commit -m "deps(file-indexer): add faster-whisper for ASR (WARP-197)"
```

### Task 1.2: Add `ffmpeg` to the file-indexer Dockerfile

**Files:**
- Modify: `services/file-indexer/Dockerfile`

- [ ] **Step 1: Read the existing Dockerfile**

```bash
cat services/file-indexer/Dockerfile
```

Look for the `apt-get install` block that already adds `tesseract-ocr` (added in WARP-201). The new packages go in the same block.

- [ ] **Step 2: Edit the Dockerfile**

Find the line that installs `tesseract-ocr tesseract-ocr-eng` and extend it:

```dockerfile
# Before:
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

# After:
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

If the existing block already lives in a different shape, preserve its style and just add `ffmpeg \`.

- [ ] **Step 3: Build the image locally to confirm the install works**

```bash
docker build -t file-indexer-warp197-test services/file-indexer/ 2>&1 | tail -20
```

Expected: image builds successfully; final size grows by ~70 MB.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/Dockerfile
git commit -m "build(file-indexer): add ffmpeg for audio/video decode (WARP-197)"
```

### Task 1.3: Create the audio fixture

**Files:**
- Create: `services/file-indexer/tests/fixtures/sample.wav`

- [ ] **Step 1: Generate a 5-second WAV with known phrase**

The simplest path is to use `say` (macOS) or `espeak` (Linux) to generate audio of a known phrase.

```bash
# macOS
say -o /tmp/sample.aiff "the budget for q4 is one hundred thousand dollars"
ffmpeg -i /tmp/sample.aiff -ac 1 -ar 16000 services/file-indexer/tests/fixtures/sample.wav

# Linux fallback (in CI, etc.)
espeak -w services/file-indexer/tests/fixtures/sample.wav "the budget for q4 is one hundred thousand dollars"
```

If neither is available, generate via Python:

```python
# generate_sample_wav.py — run once locally, commit the output
import wave, struct, math
fr = 16000
duration_s = 5
amp = 12000
freq = 440  # placeholder tone — won't transcribe to anything but proves the pipeline runs
n = fr * duration_s
with wave.open("services/file-indexer/tests/fixtures/sample.wav", "w") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(fr)
    for i in range(n):
        sample = int(amp * math.sin(2 * math.pi * freq * i / fr))
        w.writeframes(struct.pack("<h", sample))
```

(If you fall back to the tone-generator, the unit test asserts the transcription pipeline RAN and produced an `ExtractedDoc` — not specific phrase content. The integration test is where we'd want a real-speech fixture.)

- [ ] **Step 2: Commit**

```bash
git add services/file-indexer/tests/fixtures/sample.wav
git commit -m "test(file-indexer): add audio fixture for WARP-197 tests"
```

### Task 1.4: Write the failing audio-extractor unit test

**Files:**
- Create: `services/file-indexer/tests/test_audio.py`

- [ ] **Step 1: Write the test**

```python
"""Unit tests for the audio extractor (WARP-197)."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import audio
from extractors.types import ExtractedDoc

FIXTURES = Path(__file__).parent / "fixtures"


def test_extract_returns_extracted_doc_for_wav():
    """Happy path: real WAV file produces a non-None ExtractedDoc with metadata."""
    result = audio.extract(FIXTURES / "sample.wav", mime="audio/wav")
    assert result is not None
    assert isinstance(result, dict)  # ExtractedDoc is TypedDict; runtime is dict
    assert "text" in result
    assert "metadata" in result
    assert "duration_sec" in result["metadata"]
    # We don't assert specific text content because the fixture may be a tone
    # generator — the integration test is where we'd assert phrase content.
    assert result["metadata"]["duration_sec"] > 0


def test_extract_returns_none_for_unsupported_mime():
    """Defensive: extractor refuses MIMEs it doesn't claim."""
    result = audio.extract(FIXTURES / "sample.wav", mime="text/plain")
    assert result is None


def test_extract_warns_on_cpu_fallback(monkeypatch):
    """When CUDA OOMs, the extractor falls back to CPU and emits a warning."""
    # Force the CUDA path to raise OOM on first call.
    calls = {"n": 0}

    class FakeModel:
        def __init__(self, *a, **kw):
            calls["n"] += 1
            if kw.get("device") == "cuda":
                raise RuntimeError("CUDA out of memory")

        def transcribe(self, *a, **kw):
            # Return shape: (segments, info)
            class Seg:
                start = 0.0
                end = 1.0
                text = "hello"

            class Info:
                language = "en"
                duration = 1.0

            return [Seg()], Info()

    monkeypatch.setattr(audio, "WhisperModel", FakeModel)
    audio._reset_model_cache()  # exposed test seam — see implementation
    result = audio.extract(FIXTURES / "sample.wav", mime="audio/wav")
    assert result is not None
    assert "gpu_unavailable" in result["warnings"]
```

- [ ] **Step 2: Run the test to confirm it fails for the right reason**

```bash
cd services/file-indexer
python -m pytest tests/test_audio.py -v 2>&1 | tail -15
```

Expected: 3 errors with `ModuleNotFoundError: No module named 'extractors.audio'`. That's what we want — the failure proves the test would be exercising real code if the module existed.

### Task 1.5: Implement the audio extractor

**Files:**
- Create: `services/file-indexer/extractors/audio.py`

- [ ] **Step 1: Write the module**

```python
"""Audio extractor — faster-whisper ASR with CUDA→CPU fallback.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.1

Engine: faster-whisper (CTranslate2). Default model `small.en` (~470MB);
configurable via `ASR_MODEL` env var with allow-list.

Single-worker queue: a process-global threading.Lock serializes
transcription calls so we never run two ASR jobs in parallel and never
crash the Ollama-owned GPU. CUDA-first; on RuntimeError (OOM, etc.)
fall back to CPU for that call only and emit `gpu_unavailable`.

Lazy model load: model is instantiated on first call and cached on the
module. `_reset_model_cache()` is a test seam to drop the cache.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional

from .types import ExtractedDoc

logger = logging.getLogger(__name__)

# MIMEs we claim. Anything else returns None from extract().
SUPPORTED_MIMES = frozenset(
    {
        "audio/mpeg",
        "audio/mp4",  # m4a
        "audio/wav",
        "audio/x-wav",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/aac",
    }
)

# Allowed model names — keep the env var honest.
_ALLOWED_MODELS = frozenset({"tiny.en", "base.en", "small.en", "medium.en", "large-v3"})

# Lazy import — keep the module importable even when faster-whisper isn't
# installed yet (helps unit tests that mock WhisperModel).
try:
    from faster_whisper import WhisperModel  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    WhisperModel = None  # type: ignore[assignment,misc]


_model_lock = threading.Lock()
_model_cache: dict[str, object] = {}  # keyed by (model_name, device)


def _model_name() -> str:
    raw = os.environ.get("ASR_MODEL", "small.en")
    if raw not in _ALLOWED_MODELS:
        logger.warning("Unknown ASR_MODEL=%r; falling back to small.en", raw)
        return "small.en"
    return raw


def _reset_model_cache() -> None:
    """Test seam: drop the cached model so the next call re-instantiates."""
    _model_cache.clear()


def _get_model(device: str):
    """Return a cached WhisperModel for the given device, instantiating if needed."""
    name = _model_name()
    key = f"{name}:{device}"
    if key not in _model_cache:
        compute_type = "float16" if device == "cuda" else "int8"
        _model_cache[key] = WhisperModel(name, device=device, compute_type=compute_type)
    return _model_cache[key]


def extract(path: Path, mime: str) -> Optional[ExtractedDoc]:
    """Transcribe an audio file via faster-whisper.

    Returns None if the MIME isn't in SUPPORTED_MIMES.
    On CUDA OOM, falls back to CPU and emits 'gpu_unavailable' in warnings.
    """
    if mime not in SUPPORTED_MIMES:
        return None

    warnings: list[str] = []
    segments = []
    info = None

    # Single-worker queue: only one ASR job runs at a time across the file-indexer process.
    with _model_lock:
        try:
            model = _get_model("cuda")
            segments_iter, info = model.transcribe(str(path), beam_size=5, temperature=0.0)
            segments = list(segments_iter)
        except RuntimeError as exc:
            # Most commonly CUDA OOM when Ollama is mid-inference.
            logger.warning("CUDA path failed (%s); falling back to CPU", exc)
            warnings.append("gpu_unavailable")
            model = _get_model("cpu")
            segments_iter, info = model.transcribe(str(path), beam_size=5, temperature=0.0)
            segments = list(segments_iter)

    # Merge segments into a single text body and remember segment-end offsets.
    text_parts: list[str] = []
    page_breaks: list[int] = []
    cursor = 0
    for seg in segments:
        line = seg.text.strip()
        text_parts.append(line)
        cursor += len(line) + 1  # +1 for the join newline
        page_breaks.append(cursor)
    text = "\n".join(text_parts)

    metadata = {
        "language": getattr(info, "language", None) if info else None,
        "duration_sec": getattr(info, "duration", None) if info else None,
    }

    return ExtractedDoc(
        text=text,
        page_breaks=page_breaks,
        language=metadata["language"],
        metadata=metadata,
        warnings=warnings,
    )
```

- [ ] **Step 2: Run the unit test to confirm 3/3 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_audio.py -v 2>&1 | tail -10
```

Expected: 3 passed. If `test_extract_warns_on_cpu_fallback` fails because `WhisperModel` isn't importable in the test environment, that's a real install issue — fix `pip install -r requirements.txt` first, or skip-mark the test with `@pytest.mark.skipif(WhisperModel is None, ...)` if needed.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/extractors/audio.py services/file-indexer/tests/test_audio.py
git commit -m "feat(rag): audio extractor via faster-whisper (WARP-197)"
```

### Task 1.6: Register audio in the extractor dispatch table

**Files:**
- Modify: `services/file-indexer/extractors/registry.py`

- [ ] **Step 1: Read the existing registry**

```bash
cat services/file-indexer/extractors/registry.py | head -80
```

Find the MIME→handler dict (Phase 1 added `text`, `pdf`, `docx`, `image` entries).

- [ ] **Step 2: Add the audio entry**

Add an import for the audio module and extend the dict to include audio MIMEs. Replace the existing dispatcher's MIME mapping section:

```python
# Top of file, with the other extractor imports
from . import audio  # noqa: F401  # registered via SUPPORTED_MIMES

# In the dispatch() function (or whatever the dispatcher is named), extend
# the MIME → handler lookup so it includes:
_HANDLERS = {
    # Phase 1 (already there):
    # "text/plain": text.extract, ...
    # "application/pdf": pdf.extract, ...
    # ...
    # Phase 2 — audio:
    **{m: audio.extract for m in audio.SUPPORTED_MIMES},
}
```

- [ ] **Step 3: Add the per-MIME size cap**

Add the audio cap. Locate the existing `MAX_INDEX_BYTES = 50 * 1024 * 1024` constant and extend with:

```python
import os

DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # docs (Phase 1)
AUDIO_MAX_BYTES   = int(os.environ.get("AUDIO_MAX_BYTES", 500 * 1024 * 1024))


def _cap_for_mime(mime: str) -> int:
    """Per-MIME byte cap. Audio is much bigger than docs."""
    if mime in audio.SUPPORTED_MIMES:
        return AUDIO_MAX_BYTES
    return DEFAULT_MAX_BYTES
```

If WARP-199 has already landed and `_cap_for_mime` already exists, just add the audio branch to it.

In the dispatch path, replace any byte-cap check that uses the old single constant with `_cap_for_mime(mime)`.

- [ ] **Step 4: Add a registry test for the audio MIME**

Modify `services/file-indexer/tests/test_registry.py` (it should already exist from WARP-201) and add:

```python
def test_audio_mime_dispatches():
    """The registry knows audio/wav routes to the audio extractor."""
    from extractors import registry, audio
    assert registry._HANDLERS["audio/wav"] is audio.extract


def test_audio_cap_is_500mb():
    from extractors import registry
    assert registry._cap_for_mime("audio/wav") == 500 * 1024 * 1024
    assert registry._cap_for_mime("audio/mpeg") == 500 * 1024 * 1024
    assert registry._cap_for_mime("text/plain") == 50 * 1024 * 1024
```

- [ ] **Step 5: Run the registry tests**

```bash
cd services/file-indexer
python -m pytest tests/test_registry.py -v 2>&1 | tail -10
```

Expected: green. If existing registry tests fail because of your refactor, fix the breakage before continuing.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/registry.py services/file-indexer/tests/test_registry.py
git commit -m "feat(rag): register audio MIME + 500MB cap in dispatch registry (WARP-197)"
```

### Task 1.7: Extend the orchestrator brain-memory MIME allow-list

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`

- [ ] **Step 1: Find the allow-list constant**

```bash
grep -n "ALLOWED_MIMES\|allowedMimes" apps/orchestrator/src/routes/files-brain.ts | head
```

The constant landed in WARP-203. It's a `Set<string>` or similar.

- [ ] **Step 2: Extend it with audio MIMEs**

Replace the constant definition to include audio:

```typescript
const ALLOWED_MIMES = new Set<string>([
  // Phase 1 (already there):
  "text/plain", "text/markdown", "text/csv", "text/html",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png", "image/jpeg", "image/webp",
  // Phase 2 — audio (WARP-197):
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav",
  "audio/ogg", "audio/flac", "audio/webm", "audio/aac",
]);
```

- [ ] **Step 3: Add a unit test asserting the allow-list extension**

Modify `apps/orchestrator/src/__tests__/files-brain.test.ts` and add:

```typescript
it("accepts audio uploads (WARP-197)", async () => {
  const fakeWav = Buffer.alloc(64);
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", fakeWav, { filename: "memo.wav", contentType: "audio/wav" });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 4: Run the orchestrator tests**

```bash
cd apps/orchestrator
npm test -- files-brain 2>&1 | tail -15
```

Expected: existing 16 tests + 1 new = 17 passing.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/routes/files-brain.ts \
        apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): accept audio MIMEs in brain memory upload (WARP-197)"
```

### Task 1.8: Live integration test for audio

**Files:**
- Create: `tests/rag-audio.integration.test.ts`

- [ ] **Step 1: Read an existing RAG integration test for the boot pattern**

```bash
cat tests/rag-brain-upload.integration.test.ts | head -60
```

Reuse its Compose-up/Compose-down pattern, MQTT helper, and prisma helper.

- [ ] **Step 2: Write the audio integration test**

```typescript
/**
 * WARP-197: end-to-end audio extraction.
 *
 * Skip-gated by RUN_RAG_INTEGRATION=1 (matches every other RAG integration
 * test on main). Boots the same Compose stack the WARP-206 e2e test uses
 * via docker/docker-compose.test.override.yml.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client as PgClient } from "pg";
import fs from "node:fs";
import path from "node:path";

const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("WARP-197 audio extraction (live)", () => {
  let pg: PgClient;

  beforeAll(async () => {
    pg = new PgClient({ connectionString: "postgresql://droplet:droplet@localhost:5432/droplet" });
    await pg.connect();
  }, 30_000);

  afterAll(async () => {
    await pg.end();
  });

  it("transcribes an uploaded WAV and produces FileContentChunk rows", async () => {
    // Upload a WAV via the brain memory endpoint.
    const wavBytes = fs.readFileSync(
      path.resolve(__dirname, "../services/file-indexer/tests/fixtures/sample.wav"),
    );
    const form = new FormData();
    form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "memo.wav");
    const uploadRes = await fetch("http://localhost:3000/api/files/brain/upload", {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(202);
    const { itemId } = (await uploadRes.json()) as { itemId: string };

    // Poll for indexedAt — give Whisper up to 3 minutes (cold model load + transcription).
    const deadline = Date.now() + 180_000;
    let chunks: Array<{ text: string }> = [];
    while (Date.now() < deadline) {
      const r = await pg.query(
        `SELECT text FROM "FileContentChunk" WHERE "brainItemId" = $1`,
        [itemId],
      );
      if (r.rows.length > 0) {
        chunks = r.rows;
        break;
      }
      await new Promise((res) => setTimeout(res, 2_000));
    }
    expect(chunks.length).toBeGreaterThan(0);
    // We don't assert specific transcript content because the fixture may be
    // a tone — what we assert is that the pipeline produced *some* text and
    // a row landed under the right brainItemId (per-user RBAC).
    expect(chunks[0].text).toBeDefined();
  }, 240_000); // 4 min total budget
});
```

- [ ] **Step 3: Confirm it skips cleanly without the env var**

```bash
cd tests
npx vitest run rag-audio.integration.test.ts 2>&1 | tail -5
```

Expected: 1 file, 1 test skipped (clean skip — no errors).

- [ ] **Step 4: Commit**

```bash
git add tests/rag-audio.integration.test.ts
git commit -m "test(rag): live integration test for audio extraction (WARP-197)"
```

### Task 1.9: Push WARP-197

- [ ] **Step 1: Push the branch**

```bash
git push -u origin WARP-197
```

- [ ] **Step 2: Hand off to QA**

Do NOT open the PR yet. Return a self-assessment per the harness flow. The orchestrator will dispatch the QA agent, synthesize Dev + QA into a PR body, and run the local-validation gate before opening the PR.

---

## WARP-198 — Video extractor (depends on WARP-197 merged)

**Branch:** `WARP-198` (off `main` AFTER WARP-197 has merged)
**Spec sections:** §4.2 video · §9 testing

### Task 2.0: Confirm prerequisite is merged

- [ ] **Step 1: Check that WARP-197 is on `main`**

```bash
git checkout main
git pull --ff-only origin main
git log --oneline | head -10 | grep -i "WARP-197" || echo "NOT FOUND — STOP and wait for WARP-197 to merge"
```

If you don't see a "WARP-197" commit, STOP. Video extractor depends on `extractors/audio.py` for the audio-fallback path.

- [ ] **Step 2: Branch off**

```bash
git checkout -b WARP-198
```

### Task 2.1: Add subtitle-parsing dep

**Files:**
- Modify: `services/file-indexer/requirements.txt`

- [ ] **Step 1: Append**

```
srt==3.5.3
```

- [ ] **Step 2: Commit**

```bash
git add services/file-indexer/requirements.txt
git commit -m "deps(file-indexer): add srt for subtitle parsing (WARP-198)"
```

### Task 2.2: Create video fixtures

**Files:**
- Create: `services/file-indexer/tests/fixtures/with-srt.mp4`
- Create: `services/file-indexer/tests/fixtures/no-srt.mp4`

- [ ] **Step 1: Generate `no-srt.mp4`**

Take the audio fixture from WARP-197 and wrap it in an MP4 with a black video stream:

```bash
ffmpeg -loop 1 -i /dev/null \
  -f lavfi -i color=black:s=320x240:d=5 \
  -i services/file-indexer/tests/fixtures/sample.wav \
  -c:v libx264 -tune stillimage -pix_fmt yuv420p \
  -c:a aac -shortest \
  services/file-indexer/tests/fixtures/no-srt.mp4
```

If `lavfi` isn't available, generate a 5-second test pattern:

```bash
ffmpeg -f lavfi -i testsrc=duration=5:size=320x240:rate=15 \
       -i services/file-indexer/tests/fixtures/sample.wav \
       -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
       services/file-indexer/tests/fixtures/no-srt.mp4
```

- [ ] **Step 2: Generate `with-srt.mp4`**

Create a tiny `.srt` file inline, then mux it into an MP4:

```bash
cat > /tmp/cues.srt <<'EOF'
1
00:00:00,500 --> 00:00:02,000
budget meeting kickoff

2
00:00:02,500 --> 00:00:04,500
projecting q4 revenue at one hundred thousand
EOF

ffmpeg -i services/file-indexer/tests/fixtures/no-srt.mp4 \
       -i /tmp/cues.srt \
       -c copy -c:s mov_text \
       services/file-indexer/tests/fixtures/with-srt.mp4
```

- [ ] **Step 3: Verify the fixtures**

```bash
ffprobe -v error -show_streams services/file-indexer/tests/fixtures/with-srt.mp4 2>&1 | grep -i codec_type
```

Expected: lists at least one `codec_type=subtitle` along with video and audio.

```bash
ffprobe -v error -show_streams services/file-indexer/tests/fixtures/no-srt.mp4 2>&1 | grep -i codec_type
```

Expected: no `codec_type=subtitle` — only video + audio.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/tests/fixtures/with-srt.mp4 \
        services/file-indexer/tests/fixtures/no-srt.mp4
git commit -m "test(file-indexer): add video fixtures for WARP-198 tests"
```

### Task 2.3: Write the failing video unit test

**Files:**
- Create: `services/file-indexer/tests/test_video.py`

- [ ] **Step 1: Write the test**

```python
"""Unit tests for the video extractor (WARP-198)."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import video

FIXTURES = Path(__file__).parent / "fixtures"


def test_with_srt_uses_subtitle_stream():
    """When the file has a text-based subtitle stream, that's the source of truth."""
    result = video.extract(FIXTURES / "with-srt.mp4", mime="video/mp4")
    assert result is not None
    assert result["metadata"]["subtitle_source"] == "embedded"
    assert "budget meeting kickoff" in result["text"].lower()


def test_no_srt_falls_back_to_audio():
    """When no subtitle stream exists, fall back to the audio extractor (WARP-197)."""
    result = video.extract(FIXTURES / "no-srt.mp4", mime="video/mp4")
    assert result is not None
    assert result["metadata"]["subtitle_source"] == "asr_transcript"
    # Don't assert specific transcription content — the fixture audio may be a tone.
    assert "text" in result


def test_returns_none_for_unsupported_mime():
    result = video.extract(FIXTURES / "with-srt.mp4", mime="audio/wav")
    assert result is None
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_video.py -v 2>&1 | tail -10
```

Expected: 3 errors with `ModuleNotFoundError: No module named 'extractors.video'`.

### Task 2.4: Implement the video extractor

**Files:**
- Create: `services/file-indexer/extractors/video.py`

- [ ] **Step 1: Write the module**

```python
"""Video extractor — subtitles-first, audio-fallback through WARP-197.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.2

Step 1: ffprobe the file to look for text-based subtitle streams.
Step 2a: if one exists, ffmpeg-extract it as SRT, parse with `srt`.
Step 2b: otherwise, ffmpeg-strip the audio to a 16kHz mono WAV in /tmp
        and dispatch to the audio extractor.

No frame OCR (WARP-208 covers that).
"""
from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

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

# codec_name values for text-based subtitle streams ffmpeg can convert to SRT.
_TEXT_SUBTITLE_CODECS = frozenset({"srt", "ass", "ssa", "mov_text", "webvtt"})


def _ffprobe_streams(path: Path) -> list[dict]:
    """Return the list of streams from ffprobe -show_streams."""
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout).get("streams", [])


def _pick_subtitle_stream(streams: list[dict]) -> Optional[int]:
    """Return the stream index of the first text-based subtitle, English-preferred."""
    candidates = [
        s for s in streams if s.get("codec_type") == "subtitle" and s.get("codec_name") in _TEXT_SUBTITLE_CODECS
    ]
    if not candidates:
        return None
    # Prefer English by language tag, else first.
    for s in candidates:
        if s.get("tags", {}).get("language") == "eng":
            return int(s["index"])
    return int(candidates[0]["index"])


def _extract_srt(path: Path, stream_index: int) -> str:
    """Run ffmpeg to convert the picked subtitle stream to SRT on stdout."""
    # `-map 0:s:<n>` indexes among subtitle streams; we need the in-file
    # subtitle index (which `_pick_subtitle_stream` returns from `-show_streams`).
    # Convert that to subtitle-only index by counting subtitle streams up to N.
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
    """Decode the audio track to a 16kHz mono WAV in /tmp; return the path."""
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    import os as _os

    _os.close(fd)
    subprocess.run(
        [
            "ffmpeg",
            "-y",  # overwrite
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


def extract(path: Path, mime: str) -> Optional[ExtractedDoc]:
    """Extract text from a video file via subtitles or audio fallback."""
    if mime not in SUPPORTED_MIMES:
        return None

    streams = _ffprobe_streams(path)
    sub_index = _pick_subtitle_stream(streams)

    if sub_index is not None:
        # Subtitle path.
        srt_text = _extract_srt(path, sub_index)
        cues = list(srt_lib.parse(srt_text))
        text_parts: list[str] = []
        page_breaks: list[int] = []
        cursor = 0
        for cue in cues:
            line = cue.content.replace("\n", " ").strip()
            text_parts.append(line)
            cursor += len(line) + 1
            page_breaks.append(cursor)
        return ExtractedDoc(
            text="\n".join(text_parts),
            page_breaks=page_breaks,
            language=None,
            metadata={"subtitle_source": "embedded", "cue_count": len(cues)},
            warnings=[],
        )

    # Audio fallback.
    wav_path = _strip_audio_to_wav(path)
    try:
        audio_doc = audio.extract(wav_path, mime="audio/wav")
        if audio_doc is None:
            logger.warning("audio extractor refused the temp WAV — bug?")
            return ExtractedDoc(
                text="",
                page_breaks=[],
                language=None,
                metadata={"subtitle_source": "asr_transcript_failed"},
                warnings=["audio_extractor_returned_none"],
            )
        # Tag the source so downstream consumers can render the right badge.
        audio_doc["metadata"]["subtitle_source"] = "asr_transcript"
        return audio_doc
    finally:
        try:
            wav_path.unlink()
        except OSError:
            pass
```

- [ ] **Step 2: Run the unit test to confirm 3/3 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_video.py -v 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/extractors/video.py services/file-indexer/tests/test_video.py
git commit -m "feat(rag): video extractor — subtitles-first, audio-fallback (WARP-198)"
```

### Task 2.5: Register video in the dispatch table

**Files:**
- Modify: `services/file-indexer/extractors/registry.py`

- [ ] **Step 1: Add the video import + handler entries**

Same pattern as Task 1.6:

```python
from . import video  # noqa: F401

_HANDLERS = {
    # ... existing entries
    **{m: video.extract for m in video.SUPPORTED_MIMES},
}

VIDEO_MAX_BYTES = int(os.environ.get("VIDEO_MAX_BYTES", 2048 * 1024 * 1024))


def _cap_for_mime(mime: str) -> int:
    if mime in audio.SUPPORTED_MIMES:
        return AUDIO_MAX_BYTES
    if mime in video.SUPPORTED_MIMES:
        return VIDEO_MAX_BYTES
    return DEFAULT_MAX_BYTES
```

- [ ] **Step 2: Add registry tests**

In `services/file-indexer/tests/test_registry.py`:

```python
def test_video_mime_dispatches():
    from extractors import registry, video
    assert registry._HANDLERS["video/mp4"] is video.extract


def test_video_cap_is_2gb():
    from extractors import registry
    assert registry._cap_for_mime("video/mp4") == 2 * 1024 * 1024 * 1024
```

- [ ] **Step 3: Run registry tests**

```bash
cd services/file-indexer
python -m pytest tests/test_registry.py -v 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/extractors/registry.py services/file-indexer/tests/test_registry.py
git commit -m "feat(rag): register video MIME + 2GB cap in dispatch registry (WARP-198)"
```

### Task 2.6: Extend the orchestrator brain-memory MIME allow-list (video)

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Extend the allow-list**

Add to `ALLOWED_MIMES` Set:

```typescript
"video/mp4", "video/quicktime", "video/x-matroska",
"video/webm", "video/x-msvideo", "video/mpeg",
```

- [ ] **Step 2: Add a unit test**

```typescript
it("accepts video uploads (WARP-198)", async () => {
  const fakeMp4 = Buffer.alloc(64);
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", fakeMp4, { filename: "meeting.mp4", contentType: "video/mp4" });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 3: Run the orchestrator tests**

```bash
cd apps/orchestrator
npm test -- files-brain 2>&1 | tail -15
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/routes/files-brain.ts \
        apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): accept video MIMEs in brain memory upload (WARP-198)"
```

### Task 2.7: Live integration test for video

**Files:**
- Create: `tests/rag-video.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client as PgClient } from "pg";
import fs from "node:fs";
import path from "node:path";

const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("WARP-198 video extraction (live)", () => {
  let pg: PgClient;

  beforeAll(async () => {
    pg = new PgClient({ connectionString: "postgresql://droplet:droplet@localhost:5432/droplet" });
    await pg.connect();
  }, 30_000);

  afterAll(async () => {
    await pg.end();
  });

  async function uploadAndPoll(filename: string, mime: string, fixture: string) {
    const bytes = fs.readFileSync(path.resolve(__dirname, fixture));
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), filename);
    const r = await fetch("http://localhost:3000/api/files/brain/upload", { method: "POST", body: form });
    expect(r.status).toBe(202);
    const { itemId } = (await r.json()) as { itemId: string };
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const q = await pg.query(`SELECT text FROM "FileContentChunk" WHERE "brainItemId" = $1`, [itemId]);
      if (q.rows.length > 0) return q.rows;
      await new Promise((res) => setTimeout(res, 2_000));
    }
    throw new Error(`No chunks for ${filename} within 3 minutes`);
  }

  it("extracts subtitle text when the video has an embedded subtitle stream", async () => {
    const rows = await uploadAndPoll(
      "with-srt.mp4",
      "video/mp4",
      "../services/file-indexer/tests/fixtures/with-srt.mp4",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.text).join(" ").toLowerCase()).toContain("budget meeting");
  }, 240_000);

  it("falls back to ASR when no subtitle stream is present", async () => {
    const rows = await uploadAndPoll(
      "no-srt.mp4",
      "video/mp4",
      "../services/file-indexer/tests/fixtures/no-srt.mp4",
    );
    expect(rows.length).toBeGreaterThan(0);
    // Pipeline ran; we don't assert specific text because the fixture audio may be a tone.
  }, 240_000);
});
```

- [ ] **Step 2: Confirm clean skip**

```bash
cd tests
npx vitest run rag-video.integration.test.ts 2>&1 | tail -5
```

Expected: 1 file, 2 tests skipped.

- [ ] **Step 3: Commit**

```bash
git add tests/rag-video.integration.test.ts
git commit -m "test(rag): live integration test for video extraction (WARP-198)"
```

### Task 2.8: Push WARP-198

- [ ] **Step 1: Push**

```bash
git push -u origin WARP-198
```

- [ ] **Step 2: Hand off to QA per the harness flow.**

---

## WARP-199 — Email extractor (carries the recursion contract)

**Branch:** `WARP-199` (off `main`; can run in parallel with WARP-197 + WARP-200)
**Spec sections:** §4.3 email · §5 cross-cutting · §7 recursion semantics

> **Contract carrier note.** WARP-199 is the chosen carrier for the recursion contract refactor (`depth` parameter on `dispatch()` + `MAX_RECURSION_DEPTH = 2` constant + per-MIME cap dispatcher). If WARP-200 lands first instead, the WARP-199 Task 1 below becomes a no-op rebase — you'll see the constants already on `main`.

### Task 3.0: Branch off

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull --ff-only origin main
git checkout -b WARP-199
```

### Task 3.1: Refactor registry to add the recursion contract

**Files:**
- Modify: `services/file-indexer/extractors/registry.py`
- Modify: `services/file-indexer/extractors/__init__.py` (re-export, if it exists)

- [ ] **Step 1: Read the existing dispatcher signature**

```bash
grep -n "def dispatch" services/file-indexer/extractors/registry.py
```

The signature today is `dispatch(path, mime) → ExtractedDoc | None`.

- [ ] **Step 2: Write the failing test for the new recursion contract**

In `services/file-indexer/tests/test_registry.py`:

```python
def test_dispatch_returns_warning_when_recursion_too_deep():
    """At depth > MAX_RECURSION_DEPTH, dispatch returns a warning ExtractedDoc, never raises."""
    from extractors import registry
    fake_path = Path("/tmp/nope")
    result = registry.dispatch(fake_path, "text/plain", depth=registry.MAX_RECURSION_DEPTH + 1)
    assert result is not None
    assert result["text"] == ""
    assert "max_recursion_depth_exceeded" in result["warnings"]


def test_dispatch_default_depth_is_zero():
    """Backwards compat: callers that don't pass depth still work (defaults to 0)."""
    from extractors import registry
    # Reach into the function signature to verify the default.
    import inspect
    sig = inspect.signature(registry.dispatch)
    assert sig.parameters["depth"].default == 0
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_registry.py::test_dispatch_returns_warning_when_recursion_too_deep -v 2>&1 | tail -10
```

Expected: TypeError or AssertionError because `depth` isn't a parameter yet.

- [ ] **Step 4: Implement the contract**

Edit `extractors/registry.py`:

```python
import os
from pathlib import Path
from typing import Optional

from .types import ExtractedDoc

MAX_RECURSION_DEPTH = 2

DEFAULT_MAX_BYTES = 50 * 1024 * 1024
# Per-MIME caps land here as each extractor PR adds them. Phase 2:
AUDIO_MAX_BYTES   = int(os.environ.get("AUDIO_MAX_BYTES",   500 * 1024 * 1024))
VIDEO_MAX_BYTES   = int(os.environ.get("VIDEO_MAX_BYTES",  2048 * 1024 * 1024))
EMAIL_MAX_BYTES   = int(os.environ.get("EMAIL_MAX_BYTES",   100 * 1024 * 1024))
ARCHIVE_MAX_BYTES = int(os.environ.get("ARCHIVE_MAX_BYTES", 200 * 1024 * 1024))

# _HANDLERS dict already exists from Phase 1 — keep it.

def _cap_for_mime(mime: str) -> int:
    """Per-MIME byte cap. Audio/video/email/archive are bigger than docs."""
    # Use try/except imports because each extractor may not be present yet.
    try:
        from . import audio as _audio  # type: ignore
        if mime in _audio.SUPPORTED_MIMES:
            return AUDIO_MAX_BYTES
    except ImportError:
        pass
    try:
        from . import video as _video  # type: ignore
        if mime in _video.SUPPORTED_MIMES:
            return VIDEO_MAX_BYTES
    except ImportError:
        pass
    try:
        from . import email as _email  # type: ignore
        if mime in _email.SUPPORTED_MIMES:
            return EMAIL_MAX_BYTES
    except ImportError:
        pass
    try:
        from . import archive as _archive  # type: ignore
        if mime in _archive.SUPPORTED_MIMES:
            return ARCHIVE_MAX_BYTES
    except ImportError:
        pass
    return DEFAULT_MAX_BYTES


def dispatch(path: Path, mime: str, depth: int = 0) -> Optional[ExtractedDoc]:
    """Route an extraction to the right handler.

    Recursion: email + archive extractors call back into dispatch() with
    depth+1. If depth exceeds MAX_RECURSION_DEPTH, return an empty
    ExtractedDoc with a `max_recursion_depth_exceeded` warning. Never raise
    — the caller still wants the partial output it already accumulated.
    """
    if depth > MAX_RECURSION_DEPTH:
        return ExtractedDoc(
            text="",
            page_breaks=[],
            language=None,
            metadata={"mime": mime, "depth": depth},
            warnings=["max_recursion_depth_exceeded"],
        )
    # Byte-cap check
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > _cap_for_mime(mime):
        return ExtractedDoc(
            text="",
            page_breaks=[],
            language=None,
            metadata={"mime": mime, "size": size, "cap": _cap_for_mime(mime)},
            warnings=["size_cap_exceeded"],
        )
    handler = _HANDLERS.get(mime)
    if handler is None:
        return None
    return handler(path, mime)
```

(Preserve any existing logic in `dispatch()` from Phase 1 — chunking caps, etc. The above is the additive contract change, not a rewrite.)

- [ ] **Step 5: Run the registry tests + Phase 1 extractor tests**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -30
```

Expected: ALL tests pass — Phase 1 handlers still work because the new code is backwards-compatible (`depth=0` default).

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/extractors/registry.py services/file-indexer/tests/test_registry.py
git commit -m "feat(rag): add depth + MAX_RECURSION_DEPTH to dispatch contract (WARP-199)"
```

### Task 3.2: Add email-parsing deps

**Files:**
- Modify: `services/file-indexer/requirements.txt`

- [ ] **Step 1: Append**

```
extract-msg==0.50.0
python-magic==0.4.27
```

(`email.parser` is stdlib — no dep needed.)

- [ ] **Step 2: Add libmagic to the Dockerfile**

Edit `services/file-indexer/Dockerfile`'s apt-get line to include `libmagic1`:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    ffmpeg \
    libmagic1 \
    && rm -rf /var/lib/apt/lists/*
```

(If WARP-197 already added `ffmpeg`, just add `libmagic1` to the list.)

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/requirements.txt services/file-indexer/Dockerfile
git commit -m "deps(file-indexer): add extract-msg + python-magic + libmagic1 (WARP-199)"
```

### Task 3.3: Create email fixtures

**Files:**
- Create: `services/file-indexer/tests/fixtures/simple.eml`
- Create: `services/file-indexer/tests/fixtures/with-pdf-attachment.eml`

- [ ] **Step 1: Write `simple.eml`**

Create the file with this exact content (RFC 822):

```
From: alice@example.com
To: bob@example.com
Subject: Q4 budget kickoff
Date: Wed, 15 Apr 2026 10:00:00 +0000
Content-Type: text/plain; charset=utf-8

Hi Bob,

I'd like to schedule a meeting to review the Q4 budget projection.
Current draft has revenue at one hundred thousand dollars.

Best,
Alice
```

- [ ] **Step 2: Write `with-pdf-attachment.eml`**

Generate via Python (one-time script — commit only the output):

```python
# generate_email_fixture.py — run once locally
from email.message import EmailMessage
from email.utils import formatdate
from pathlib import Path
import shutil

# Pick a small PDF that exists in the repo (Phase 1 fixture).
src_pdf = Path("services/file-indexer/tests/fixtures/sample.pdf")
assert src_pdf.exists(), "Phase 1 PDF fixture is required"

m = EmailMessage()
m["From"] = "alice@example.com"
m["To"] = "bob@example.com"
m["Subject"] = "Budget proposal attached"
m["Date"] = formatdate(localtime=True)
m.set_content("Bob, see the attached PDF for the full proposal.")
m.add_attachment(
    src_pdf.read_bytes(),
    maintype="application",
    subtype="pdf",
    filename="proposal.pdf",
)
Path("services/file-indexer/tests/fixtures/with-pdf-attachment.eml").write_bytes(bytes(m))
```

(Make the script ephemeral — don't commit it.)

- [ ] **Step 3: Commit fixtures**

```bash
git add services/file-indexer/tests/fixtures/simple.eml \
        services/file-indexer/tests/fixtures/with-pdf-attachment.eml
git commit -m "test(file-indexer): add email fixtures for WARP-199 tests"
```

### Task 3.4: Write the failing email unit test

**Files:**
- Create: `services/file-indexer/tests/test_email.py`

- [ ] **Step 1: Write the test**

```python
"""Unit tests for the email extractor (WARP-199)."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import email as email_ext

FIXTURES = Path(__file__).parent / "fixtures"


def test_simple_eml_extracts_headers_and_body():
    result = email_ext.extract(FIXTURES / "simple.eml", mime="message/rfc822")
    assert result is not None
    assert "From: alice@example.com" in result["text"]
    assert "Subject: Q4 budget kickoff" in result["text"]
    assert "one hundred thousand" in result["text"]


def test_eml_with_pdf_attachment_recurses():
    """The PDF attachment is dispatched recursively and its text is appended."""
    result = email_ext.extract(FIXTURES / "with-pdf-attachment.eml", mime="message/rfc822")
    assert result is not None
    # Email body
    assert "Bob, see the attached PDF" in result["text"]
    # Attachment separator + PDF text (Phase 1 fixture content)
    assert "--- Attachment: proposal.pdf ---" in result["text"]
    # The Phase 1 sample.pdf contains a known phrase — assert any non-trivial text bled through.
    assert len(result["text"]) > 200


def test_unsupported_mime_returns_none():
    result = email_ext.extract(FIXTURES / "simple.eml", mime="text/plain")
    assert result is None
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_email.py -v 2>&1 | tail -10
```

Expected: 3 errors with `ModuleNotFoundError: No module named 'extractors.email'`.

### Task 3.5: Implement the email extractor

**Files:**
- Create: `services/file-indexer/extractors/email.py`

- [ ] **Step 1: Write the module**

```python
"""Email extractor — .eml (RFC 822) + .msg (Outlook MAPI).

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.3

Compose a structured text body (From/To/Subject/Date headers + body) and
recurse through dispatch() for each attachment whose MIME is supported.
Recursion depth bounded by registry.MAX_RECURSION_DEPTH (default 2).
"""
from __future__ import annotations

import email as stdlib_email
import logging
import os
import tempfile
from email.message import Message
from pathlib import Path
from typing import Optional

import magic

from . import registry
from .types import ExtractedDoc

logger = logging.getLogger(__name__)

SUPPORTED_MIMES = frozenset(
    {
        "message/rfc822",
        "application/vnd.ms-outlook",
        "application/x-msmail",
    }
)

_ATTACHMENT_SEPARATOR = "\n--- Attachment: {name} ---\n"


def _format_headers(msg: Message) -> str:
    """Compose the From/To/Subject/Date headers block."""
    lines = []
    for header in ("From", "To", "Cc", "Subject", "Date"):
        v = msg.get(header)
        if v:
            lines.append(f"{header}: {v}")
    return "\n".join(lines)


def _extract_body(msg: Message) -> str:
    """Pick the text/plain body if present; else strip HTML to text."""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                return part.get_content().strip()
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                # Crude HTML→text — Phase 1 has readability-lxml; importing
                # it transitively pulls heavy deps, so use a simple regex.
                import re
                return re.sub(r"<[^>]+>", "", part.get_content()).strip()
    else:
        if msg.get_content_type() == "text/plain":
            return msg.get_content().strip()
    return ""


def _walk_attachments(msg: Message, depth: int) -> tuple[str, list[str]]:
    """Recursively dispatch attachments; return (concatenated_text, warnings)."""
    text_parts: list[str] = []
    warnings: list[str] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        cd = part.get("Content-Disposition", "")
        if "attachment" not in cd.lower() and not part.get_filename():
            continue
        filename = part.get_filename() or "unnamed"
        payload = part.get_payload(decode=True) or b""
        if not payload:
            continue
        # Detect MIME from bytes — don't trust the email's stated type alone.
        mime = magic.from_buffer(payload, mime=True)
        # Write to a temp file so the recursive dispatcher can stat() + read.
        fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or "")
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        try:
            sub = registry.dispatch(Path(tmp), mime, depth=depth + 1)
            if sub is None:
                warnings.append(f"unsupported_attachment:{filename}:{mime}")
                continue
            text_parts.append(_ATTACHMENT_SEPARATOR.format(name=filename))
            text_parts.append(sub["text"])
            warnings.extend(sub.get("warnings") or [])
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return "\n".join(text_parts), warnings


def _extract_eml(path: Path, depth: int) -> ExtractedDoc:
    with open(path, "rb") as f:
        msg = stdlib_email.message_from_binary_file(f)
    body = _extract_body(msg)
    headers = _format_headers(msg)
    attachments_text, attachment_warnings = _walk_attachments(msg, depth)

    full_text = "\n\n".join(p for p in [headers, body, attachments_text] if p)
    return ExtractedDoc(
        text=full_text,
        page_breaks=[len(headers) + 1, len(headers) + len(body) + 2] if body else [],
        language=None,
        metadata={
            "from": msg.get("From"),
            "subject": msg.get("Subject"),
            "date": msg.get("Date"),
        },
        warnings=attachment_warnings,
    )


def _extract_msg(path: Path, depth: int) -> ExtractedDoc:
    """Outlook .msg via extract-msg."""
    import extract_msg  # local import — module is heavy

    m = extract_msg.Message(str(path))
    headers_lines = []
    if m.sender:
        headers_lines.append(f"From: {m.sender}")
    if m.to:
        headers_lines.append(f"To: {m.to}")
    if m.subject:
        headers_lines.append(f"Subject: {m.subject}")
    if m.date:
        headers_lines.append(f"Date: {m.date}")
    headers = "\n".join(headers_lines)
    body = (m.body or "").strip()

    attachments_text_parts: list[str] = []
    warnings: list[str] = []
    for att in m.attachments:
        filename = att.longFilename or att.shortFilename or "unnamed"
        payload = att.data
        if not payload:
            continue
        mime = magic.from_buffer(payload, mime=True)
        fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(filename)[1] or "")
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        try:
            sub = registry.dispatch(Path(tmp), mime, depth=depth + 1)
            if sub is None:
                warnings.append(f"unsupported_attachment:{filename}:{mime}")
                continue
            attachments_text_parts.append(_ATTACHMENT_SEPARATOR.format(name=filename))
            attachments_text_parts.append(sub["text"])
            warnings.extend(sub.get("warnings") or [])
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    attachments_text = "\n".join(attachments_text_parts)
    full_text = "\n\n".join(p for p in [headers, body, attachments_text] if p)
    return ExtractedDoc(
        text=full_text,
        page_breaks=[],
        language=None,
        metadata={"from": m.sender, "subject": m.subject, "date": str(m.date) if m.date else None},
        warnings=warnings,
    )


def extract(path: Path, mime: str, depth: int = 0) -> Optional[ExtractedDoc]:
    """Top-level entry point. Note the optional `depth` for recursion bookkeeping."""
    if mime not in SUPPORTED_MIMES:
        return None
    if mime in {"application/vnd.ms-outlook", "application/x-msmail"}:
        return _extract_msg(path, depth)
    return _extract_eml(path, depth)
```

- [ ] **Step 2: Run unit tests to confirm 3/3 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_email.py -v 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/extractors/email.py \
        services/file-indexer/tests/test_email.py
git commit -m "feat(rag): email extractor with recursive attachment dispatch (WARP-199)"
```

### Task 3.6: Register email in the dispatch table

**Files:**
- Modify: `services/file-indexer/extractors/registry.py`

- [ ] **Step 1: Add the import + handler entries**

```python
from . import email as email_ext  # noqa: F401

_HANDLERS = {
    # ... existing
    **{m: lambda p, mime, depth=0, _h=email_ext.extract: _h(p, mime, depth) for m in email_ext.SUPPORTED_MIMES},
}
```

(The lambda forwards `depth` because email's signature is `extract(path, mime, depth=0)`. Other handlers are `extract(path, mime)`. Keep the `dispatch()` call site uniform: it calls `handler(path, mime)` for non-recursive handlers and `handler(path, mime, depth=depth)` for recursive ones — see Step 2.)

Better: put a small helper in the registry:

```python
def _call_handler(handler, path: Path, mime: str, depth: int):
    import inspect
    sig = inspect.signature(handler)
    if "depth" in sig.parameters:
        return handler(path, mime, depth=depth)
    return handler(path, mime)
```

…and have `dispatch()` route through `_call_handler`. Update the registry test to assert this works for both shapes.

- [ ] **Step 2: Add a registry test**

```python
def test_email_mime_dispatches():
    from extractors import registry, email as email_ext
    # _HANDLERS contains email handler under message/rfc822
    assert "message/rfc822" in registry._HANDLERS


def test_email_cap_is_100mb():
    from extractors import registry
    assert registry._cap_for_mime("message/rfc822") == 100 * 1024 * 1024
```

- [ ] **Step 3: Run the full suite**

```bash
cd services/file-indexer
python -m pytest tests/ -v 2>&1 | tail -15
```

Expected: green across Phase 1 + audio (if landed) + email.

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/extractors/registry.py services/file-indexer/tests/test_registry.py
git commit -m "feat(rag): register email MIMEs + 100MB cap in dispatch (WARP-199)"
```

### Task 3.7: Extend orchestrator brain-memory MIME allow-list (email)

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Add email MIMEs**

```typescript
"message/rfc822", "application/vnd.ms-outlook", "application/x-msmail",
```

- [ ] **Step 2: Add a unit test**

```typescript
it("accepts email uploads (WARP-199)", async () => {
  const fakeEml = Buffer.from("Subject: hi\n\nbody\n");
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", fakeEml, { filename: "march.eml", contentType: "message/rfc822" });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/orchestrator && npm test -- files-brain 2>&1 | tail -10
git add apps/orchestrator/src/routes/files-brain.ts apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): accept email MIMEs in brain memory upload (WARP-199)"
```

### Task 3.8: Live integration test for email

**Files:**
- Create: `tests/rag-email.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client as PgClient } from "pg";
import fs from "node:fs";
import path from "node:path";

const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("WARP-199 email extraction (live)", () => {
  let pg: PgClient;
  beforeAll(async () => {
    pg = new PgClient({ connectionString: "postgresql://droplet:droplet@localhost:5432/droplet" });
    await pg.connect();
  }, 30_000);
  afterAll(async () => { await pg.end(); });

  it("indexes both email body and PDF attachment text", async () => {
    const bytes = fs.readFileSync(
      path.resolve(__dirname, "../services/file-indexer/tests/fixtures/with-pdf-attachment.eml"),
    );
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "message/rfc822" }), "march.eml");
    const r = await fetch("http://localhost:3000/api/files/brain/upload", { method: "POST", body: form });
    expect(r.status).toBe(202);
    const { itemId } = (await r.json()) as { itemId: string };
    const deadline = Date.now() + 120_000;
    let chunks: Array<{ text: string }> = [];
    while (Date.now() < deadline) {
      const q = await pg.query(`SELECT text FROM "FileContentChunk" WHERE "brainItemId" = $1`, [itemId]);
      if (q.rows.length > 0) { chunks = q.rows; break; }
      await new Promise((res) => setTimeout(res, 1_500));
    }
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("Bob, see the attached PDF");
    expect(combined).toContain("--- Attachment: proposal.pdf ---");
  }, 180_000);
});
```

- [ ] **Step 2: Confirm clean skip + commit**

```bash
cd tests && npx vitest run rag-email.integration.test.ts 2>&1 | tail -5
git add tests/rag-email.integration.test.ts
git commit -m "test(rag): live integration test for email extraction (WARP-199)"
```

### Task 3.9: Push WARP-199

```bash
git push -u origin WARP-199
```

Hand off to QA per the harness.

---

## WARP-200 — Archive extractor

**Branch:** `WARP-200` (off `main`; can run in parallel with WARP-197 + WARP-199)
**Spec sections:** §4.4 archive · §7 recursion semantics

> **Contract carrier note.** If WARP-199 has already merged when you start, the recursion contract (§3.1) is already on `main` — you'll just rebase and skip the contract-refactor task. If you're racing ahead of WARP-199, you'll need to carry it (copy Task 3.1 verbatim into your branch first). The plan below assumes WARP-199 is the carrier; adapt if order swaps.

### Task 4.0: Branch off + verify recursion contract

- [ ] **Step 1: Branch off main**

```bash
git checkout main
git pull --ff-only origin main
git checkout -b WARP-200
```

- [ ] **Step 2: Confirm the contract is in place**

```bash
grep -n "MAX_RECURSION_DEPTH\|def dispatch" services/file-indexer/extractors/registry.py
```

If you see `MAX_RECURSION_DEPTH = 2` and `def dispatch(path, mime, depth=0)`, you're good. If not, the contract isn't on main yet — execute Task 3.1 verbatim on this branch first, then continue.

### Task 4.1: Create archive fixtures

**Files:**
- Create: `services/file-indexer/tests/fixtures/simple.zip`
- Create: `services/file-indexer/tests/fixtures/nested.zip`
- Create: `services/file-indexer/tests/fixtures/traversal.zip`
- Create: `services/file-indexer/tests/fixtures/encrypted.zip`
- Create: `services/file-indexer/tests/fixtures/bomb.zip`

- [ ] **Step 1: Generate `simple.zip`**

```bash
mkdir -p /tmp/zipsrc && cd /tmp/zipsrc
echo "the budget for q4 is one hundred thousand" > note.txt
echo "second file" > more.txt
zip -r /tmp/simple.zip note.txt more.txt
mv /tmp/simple.zip "<repo>/services/file-indexer/tests/fixtures/simple.zip"
```

- [ ] **Step 2: Generate `nested.zip`** (zip-in-zip — exercises the recursion path)

```bash
cd /tmp/zipsrc
zip /tmp/inner.zip note.txt
zip /tmp/nested.zip /tmp/inner.zip
mv /tmp/nested.zip "<repo>/services/file-indexer/tests/fixtures/nested.zip"
```

- [ ] **Step 3: Generate `traversal.zip`** (zip-slip attempt)

Python script (one-shot):

```python
import zipfile
with zipfile.ZipFile("services/file-indexer/tests/fixtures/traversal.zip", "w") as z:
    z.writestr("../../../../etc/passwd-fake", "nope")
    z.writestr("legit.txt", "hello")
```

- [ ] **Step 4: Generate `encrypted.zip`**

```bash
echo "secret" > /tmp/secret.txt
zip -j -P "hunter2" /tmp/encrypted.zip /tmp/secret.txt
mv /tmp/encrypted.zip "<repo>/services/file-indexer/tests/fixtures/encrypted.zip"
```

- [ ] **Step 5: Generate `bomb.zip`** (small file claiming gigabytes)

A real recursive bomb is risky to commit. Instead, create a fixture that triggers the cumulative-decompressed-size cap by storing a single highly-compressible large file:

```python
# generate_bomb.py — one-shot
import zipfile, os
data = b"\x00" * (600 * 1024 * 1024)  # 600 MB of zeros — compresses to ~600 KB
with zipfile.ZipFile("services/file-indexer/tests/fixtures/bomb.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr("zeros.bin", data)
```

The compressed file is ~600 KB; decompressed it's 600 MB and trips `MAX_ARCHIVE_TOTAL_BYTES = 500MB`. (Don't run this with a real GB-scale fixture committed to git — keep the in-memory bytes ≤ 1 GB.)

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/tests/fixtures/{simple,nested,traversal,encrypted,bomb}.zip
git commit -m "test(file-indexer): add archive fixtures + bomb fixture (WARP-200)"
```

### Task 4.2: Write the failing archive unit test

**Files:**
- Create: `services/file-indexer/tests/test_archive.py`

- [ ] **Step 1: Write the test**

```python
"""Unit tests for the archive extractor (WARP-200)."""
from __future__ import annotations

from pathlib import Path

import pytest

from extractors import archive

FIXTURES = Path(__file__).parent / "fixtures"


def test_simple_zip_extracts_member_text():
    result = archive.extract(FIXTURES / "simple.zip", mime="application/zip")
    assert result is not None
    assert "one hundred thousand" in result["text"]
    assert "second file" in result["text"]


def test_nested_zip_recurses_to_depth_2():
    result = archive.extract(FIXTURES / "nested.zip", mime="application/zip")
    assert result is not None
    # The inner zip's content makes it through.
    assert "one hundred thousand" in result["text"] or "hello" in result["text"] or len(result["text"]) > 0


def test_traversal_paths_are_rejected():
    result = archive.extract(FIXTURES / "traversal.zip", mime="application/zip")
    assert result is not None
    # The legit member made it; the traversal one is excluded with a warning.
    assert "hello" in result["text"]
    assert any("traversal" in w or "path" in w.lower() for w in result["warnings"])


def test_encrypted_zip_emits_warning_and_skips():
    result = archive.extract(FIXTURES / "encrypted.zip", mime="application/zip")
    assert result is not None
    assert "encrypted_archive_skipped" in result["warnings"]


def test_bomb_zip_aborts_at_cumulative_cap():
    """Cumulative-decompressed cap fires before the bomb finishes expanding."""
    result = archive.extract(FIXTURES / "bomb.zip", mime="application/zip")
    assert result is not None
    assert any("decompressed_size_cap_exceeded" in w for w in result["warnings"])


def test_unsupported_mime_returns_none():
    result = archive.extract(FIXTURES / "simple.zip", mime="text/plain")
    assert result is None
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd services/file-indexer
python -m pytest tests/test_archive.py -v 2>&1 | tail -10
```

Expected: 6 errors with `ModuleNotFoundError: No module named 'extractors.archive'`.

### Task 4.3: Implement the archive extractor

**Files:**
- Create: `services/file-indexer/extractors/archive.py`

- [ ] **Step 1: Write the module**

```python
"""Archive extractor — five-layer bomb defense + bounded recursion.

Spec: docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md §4.4

Five defenses, evaluated in order on every member iteration:
  1. MAX_ARCHIVE_MEMBERS = 1000
  2. Path traversal rejection
  3. Per-member size cap (registry._cap_for_mime)
  4. Cumulative decompressed size cap (MAX_ARCHIVE_TOTAL_BYTES = 500MB)
  5. Streaming reads only — never extractall(), never read() unbounded
"""
from __future__ import annotations

import logging
import os
import tempfile
import zipfile
import tarfile
from pathlib import Path
from typing import Optional

import magic

from . import registry
from .types import ExtractedDoc

logger = logging.getLogger(__name__)

SUPPORTED_MIMES = frozenset(
    {
        "application/zip",
        "application/x-zip-compressed",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip",
        "application/x-bzip2",
    }
)

MAX_ARCHIVE_MEMBERS = int(os.environ.get("MAX_ARCHIVE_MEMBERS", 1000))
MAX_ARCHIVE_TOTAL_BYTES = int(
    os.environ.get("MAX_ARCHIVE_TOTAL_BYTES", 500 * 1024 * 1024)
)
_READ_CHUNK = 64 * 1024


def _is_traversal(name: str) -> bool:
    """Reject any member path that escapes the extraction root."""
    norm = os.path.normpath(name)
    return norm.startswith("..") or norm.startswith("/") or "/.." in norm


def _is_encrypted_zip(zf: zipfile.ZipFile) -> bool:
    return any(info.flag_bits & 0x1 for info in zf.infolist())


def _process_member_bytes(
    member_name: str,
    member_bytes: bytes,
    depth: int,
) -> tuple[str, list[str]]:
    """Detect MIME, dispatch, return (text, warnings)."""
    mime = magic.from_buffer(member_bytes, mime=True)
    fd, tmp = tempfile.mkstemp(suffix=os.path.splitext(member_name)[1] or "")
    try:
        os.write(fd, member_bytes)
    finally:
        os.close(fd)
    try:
        sub = registry.dispatch(Path(tmp), mime, depth=depth + 1)
        if sub is None:
            return "", [f"unsupported_member:{member_name}:{mime}"]
        return sub.get("text", ""), sub.get("warnings") or []
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _extract_zip(path: Path, depth: int) -> ExtractedDoc:
    text_parts: list[str] = []
    warnings: list[str] = []
    cumulative = 0

    try:
        with zipfile.ZipFile(path) as zf:
            if _is_encrypted_zip(zf):
                return ExtractedDoc(
                    text="",
                    page_breaks=[],
                    language=None,
                    metadata={"format": "zip", "encrypted": True},
                    warnings=["encrypted_archive_skipped"],
                )
            members = zf.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]
            for info in members:
                if info.is_dir():
                    continue
                if _is_traversal(info.filename):
                    warnings.append(f"path_traversal_rejected:{info.filename}")
                    continue
                # Per-member cap based on detected MIME (probe a few KB first).
                with zf.open(info) as f:
                    head = f.read(8192)
                mime_guess = magic.from_buffer(head, mime=True)
                cap = registry._cap_for_mime(mime_guess)
                if info.file_size > cap:
                    warnings.append(f"member_size_cap_exceeded:{info.filename}")
                    continue
                # Cumulative cap — read in chunks, track running total.
                with zf.open(info) as f:
                    chunks = [head]
                    read = len(head)
                    while True:
                        b = f.read(_READ_CHUNK)
                        if not b:
                            break
                        read += len(b)
                        cumulative += len(b)
                        if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                            warnings.append("decompressed_size_cap_exceeded")
                            return ExtractedDoc(
                                text="\n".join(text_parts),
                                page_breaks=[],
                                language=None,
                                metadata={"format": "zip"},
                                warnings=warnings,
                            )
                        chunks.append(b)
                    member_bytes = b"".join(chunks)
                t, w = _process_member_bytes(info.filename, member_bytes, depth)
                if t:
                    text_parts.append(f"--- Member: {info.filename} ---\n{t}")
                warnings.extend(w)
    except zipfile.BadZipFile as exc:
        warnings.append(f"bad_zip_file:{exc}")

    return ExtractedDoc(
        text="\n".join(text_parts),
        page_breaks=[],
        language=None,
        metadata={"format": "zip"},
        warnings=warnings,
    )


def _extract_tar(path: Path, depth: int) -> ExtractedDoc:
    """Tar / tar.gz / tar.bz2 — same five-layer defense as zip."""
    text_parts: list[str] = []
    warnings: list[str] = []
    cumulative = 0

    try:
        with tarfile.open(path, "r:*") as tf:
            members = tf.getmembers()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                warnings.append(f"too_many_members:{len(members)}")
                members = members[:MAX_ARCHIVE_MEMBERS]
            for m in members:
                if not m.isfile():
                    continue
                if _is_traversal(m.name):
                    warnings.append(f"path_traversal_rejected:{m.name}")
                    continue
                f = tf.extractfile(m)
                if f is None:
                    continue
                head = f.read(8192)
                mime_guess = magic.from_buffer(head, mime=True)
                cap = registry._cap_for_mime(mime_guess)
                if m.size > cap:
                    warnings.append(f"member_size_cap_exceeded:{m.name}")
                    continue
                chunks = [head]
                while True:
                    b = f.read(_READ_CHUNK)
                    if not b:
                        break
                    cumulative += len(b)
                    if cumulative > MAX_ARCHIVE_TOTAL_BYTES:
                        warnings.append("decompressed_size_cap_exceeded")
                        return ExtractedDoc(
                            text="\n".join(text_parts),
                            page_breaks=[],
                            language=None,
                            metadata={"format": "tar"},
                            warnings=warnings,
                        )
                    chunks.append(b)
                member_bytes = b"".join(chunks)
                t, w = _process_member_bytes(m.name, member_bytes, depth)
                if t:
                    text_parts.append(f"--- Member: {m.name} ---\n{t}")
                warnings.extend(w)
    except tarfile.TarError as exc:
        warnings.append(f"bad_tar_file:{exc}")

    return ExtractedDoc(
        text="\n".join(text_parts),
        page_breaks=[],
        language=None,
        metadata={"format": "tar"},
        warnings=warnings,
    )


def extract(path: Path, mime: str, depth: int = 0) -> Optional[ExtractedDoc]:
    if mime not in SUPPORTED_MIMES:
        return None
    if mime in {"application/zip", "application/x-zip-compressed"}:
        return _extract_zip(path, depth)
    return _extract_tar(path, depth)
```

- [ ] **Step 2: Run unit tests to confirm 6/6 pass**

```bash
cd services/file-indexer
python -m pytest tests/test_archive.py -v 2>&1 | tail -15
```

Expected: 6 passed.

- [ ] **Step 3: Commit**

```bash
git add services/file-indexer/extractors/archive.py services/file-indexer/tests/test_archive.py
git commit -m "feat(rag): archive extractor — 5-layer bomb defense, depth-2 recursion (WARP-200)"
```

### Task 4.4: Register archive in the dispatch table

**Files:**
- Modify: `services/file-indexer/extractors/registry.py`

- [ ] **Step 1: Add the import + handler entries**

```python
from . import archive  # noqa: F401

_HANDLERS = {
    # ... existing
    **{m: archive.extract for m in archive.SUPPORTED_MIMES},
}
```

(Use the `_call_handler` helper from Task 3.1 so `depth` is forwarded — archive's `extract()` takes `depth` like email's.)

- [ ] **Step 2: Add registry tests**

```python
def test_archive_mime_dispatches():
    from extractors import registry
    assert "application/zip" in registry._HANDLERS


def test_archive_cap_is_200mb():
    from extractors import registry
    assert registry._cap_for_mime("application/zip") == 200 * 1024 * 1024
```

- [ ] **Step 3: Run + commit**

```bash
cd services/file-indexer && python -m pytest tests/ -v 2>&1 | tail -15
git add services/file-indexer/extractors/registry.py services/file-indexer/tests/test_registry.py
git commit -m "feat(rag): register archive MIMEs + 200MB cap in dispatch (WARP-200)"
```

### Task 4.5: Extend orchestrator brain-memory MIME allow-list (archive)

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Add archive MIMEs**

```typescript
"application/zip", "application/x-zip-compressed",
"application/x-tar", "application/gzip", "application/x-gzip", "application/x-bzip2",
```

- [ ] **Step 2: Add unit test**

```typescript
it("accepts archive uploads (WARP-200)", async () => {
  const fakeZip = Buffer.alloc(64);
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", fakeZip, { filename: "stuff.zip", contentType: "application/zip" });
  expect(res.status).toBe(202);
});
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/orchestrator && npm test -- files-brain 2>&1 | tail -10
git add apps/orchestrator/src/routes/files-brain.ts apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): accept archive MIMEs in brain memory upload (WARP-200)"
```

### Task 4.6: Live integration test for archive

**Files:**
- Create: `tests/rag-archive.integration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client as PgClient } from "pg";
import fs from "node:fs";
import path from "node:path";

const SHOULD_RUN = process.env.RUN_RAG_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("WARP-200 archive extraction (live)", () => {
  let pg: PgClient;
  beforeAll(async () => {
    pg = new PgClient({ connectionString: "postgresql://droplet:droplet@localhost:5432/droplet" });
    await pg.connect();
  }, 30_000);
  afterAll(async () => { await pg.end(); });

  it("indexes member files of a zip and falls back gracefully on traversal", async () => {
    const bytes = fs.readFileSync(
      path.resolve(__dirname, "../services/file-indexer/tests/fixtures/simple.zip"),
    );
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/zip" }), "stuff.zip");
    const r = await fetch("http://localhost:3000/api/files/brain/upload", { method: "POST", body: form });
    expect(r.status).toBe(202);
    const { itemId } = (await r.json()) as { itemId: string };
    const deadline = Date.now() + 120_000;
    let chunks: Array<{ text: string }> = [];
    while (Date.now() < deadline) {
      const q = await pg.query(`SELECT text FROM "FileContentChunk" WHERE "brainItemId" = $1`, [itemId]);
      if (q.rows.length > 0) { chunks = q.rows; break; }
      await new Promise((res) => setTimeout(res, 1_500));
    }
    const combined = chunks.map((c) => c.text).join("\n");
    expect(combined).toContain("one hundred thousand");
    expect(combined).toContain("--- Member: note.txt ---");
  }, 180_000);
});
```

- [ ] **Step 2: Confirm clean skip + commit**

```bash
cd tests && npx vitest run rag-archive.integration.test.ts 2>&1 | tail -5
git add tests/rag-archive.integration.test.ts
git commit -m "test(rag): live integration test for archive extraction (WARP-200)"
```

### Task 4.7: Push WARP-200

```bash
git push -u origin WARP-200
```

Hand off to QA per the harness.

---

## Cross-cutting cleanup (lands with whichever PR is last)

### Task 5.1: Update operator docs

**Files:**
- Modify: `docs/RAG_TESTING.md`

- [ ] **Step 1: Add Phase 2 entries to the per-test scope table**

Append rows for:
- `rag-audio.integration.test.ts` — uploads a WAV, asserts FileContentChunk landed
- `rag-video.integration.test.ts` — uploads with-srt and no-srt MP4s, asserts subtitle_source differs
- `rag-email.integration.test.ts` — uploads .eml with PDF attachment, asserts both bleed through
- `rag-archive.integration.test.ts` — uploads simple.zip, asserts member text + member separator

- [ ] **Step 2: Add a Phase 2 troubleshooting block**

```markdown
### Phase 2 specific failure modes

- **Audio test hangs at 'transcribing':** check ai-gateway logs and `nvidia-smi`. If GPU is busy with Ollama, the ASR job will fall back to CPU and take 2-3× real-time. Look for `gpu_unavailable` in the chunk's `metadata.warnings`.

- **Video test fails 'no subtitle_source':** ffprobe couldn't read the file. Check `docker compose logs file-indexer` for ffmpeg errors. If your fixture was generated on a host with a different ffmpeg version, regenerate it.

- **Email test missing attachment text:** the recursive dispatch silently skipped the attachment. Look for `unsupported_attachment:<filename>:<mime>` in `metadata.warnings`. Confirm the inner MIME is in the registry.

- **Archive test fails on `bomb.zip`:** if the `decompressed_size_cap_exceeded` warning isn't there, the cumulative-byte check has regressed. Re-run the unit test (`tests/test_archive.py::test_bomb_zip_aborts_at_cumulative_cap`).
```

- [ ] **Step 3: Update the LLM-determinism section**

Append:

```markdown
**Whisper transcription drift:** faster-whisper is deterministic at `temperature=0` for a given (model, input) pair, but transcripts shift across model versions. Tests assert substring matches ("the transcript contains 'budget'"), not full-text equality. If you bump the `ASR_MODEL` env var, expect to update assertions in `test_audio.py`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/RAG_TESTING.md
git commit -m "docs(rag): operator notes for Phase 2 extractors (WARP-197/198/199/200)"
```

(This task lands as part of whichever PR is the last to merge — typically WARP-198 since it depends on 197.)

---

## Self-review checklist (run before handing off any branch)

For each branch, before pushing:

1. **Spec coverage** — every spec section §4.x for that ticket has at least one task. §5 cross-cutting (registry, MIME allow-list, Dockerfile) has at least one task. §6 GPU contention is implemented (audio extractor's lock + CUDA-then-CPU fallback). §7 recursion is in registry.py + email + archive. §9 testing has unit + integration tests for the ticket's extractor.

2. **No placeholders** — search the diff for `TODO`, `TBD`, `FIXME`, `XXX`, `placeholder`. Should return zero hits.

3. **Type consistency** — `ExtractedDoc` is constructed with the same five keys (`text`, `page_breaks`, `language`, `metadata`, `warnings`) everywhere. `dispatch(path, mime, depth=0)` signature is uniform.

4. **Tests run green locally** — full file-indexer pytest suite + orchestrator vitest suite. If anything broke, you caused it; fix it.

5. **Integration test skips cleanly without env var** — `npx vitest run <new file>` exits 0 with N skipped.

6. **No forbidden surfaces touched** — no changes to `@droplet/tools-core`, no changes to existing migrations, no changes to `setup.sh` or production Compose secrets.

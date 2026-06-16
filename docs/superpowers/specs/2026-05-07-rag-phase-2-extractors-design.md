# RAG Phase 2 — Audio, Video, Email, Archive extractors

**Status:** Design — pending review
**Owner:** Brain memory team
**Date:** 2026-05-07
**Phase 1 reference:** [`docs/superpowers/specs/2026-04-28-rag-system-design.md`](./2026-04-28-rag-system-design.md)
**Tickets shipping in this phase:** WARP-197 (audio), WARP-198 (video), WARP-199 (email), WARP-200 (archive)
**Tickets cut and tracked for later:** WARP-207..214 (see §10)

## 1. Goals

1. Add four new extractors to the existing Phase 1 dispatch registry so the LLM and `/knowledge` dashboard can index audio recordings, video files, email messages, and archives.
2. Inherit Phase 1's invariants — same `ExtractedDoc` shape, same chunking pipeline, same per-user RBAC, same `FileContentChunk` table, same `RUN_RAG_INTEGRATION=1`-gated integration tests.
3. Deliver bomb-resilient archive handling (five-layer defense) and bounded recursion so "PDF inside email inside zip" works without exposing the device to amplification attacks.
4. Cooperate with the GPU Ollama uses for LLM inference — never crash Ollama; degrade gracefully to CPU when the GPU is busy.
5. Validate on real hardware before merge: every PR runs end-to-end via `./scripts/test-rag.sh` on the Manager's machine before landing.

## 2. Non-goals

Each item below has a Jira ticket so we don't lose track:

- **Speaker diarization** (WARP-207) — flat transcripts only in v2.
- **Frame OCR for video** (WARP-208) — subtitles + audio cover most real content.
- **Real-time streaming transcription** (WARP-209) — batch ASR over uploaded files only.
- **Live email sync** via IMAP/Exchange/Gmail (WARP-210) — file-drop only.
- **Bulk mailbox import** (.pst/.mbox/Maildir) (WARP-211) — per-message `.eml` and `.msg` only.
- **7z support and password-protected archives** (WARP-212) — clean "unsupported" warning, skip.
- **Auto-tune ASR model size** by file duration/language (WARP-213) — static `ASR_MODEL` env var.
- **Dashboard polish** (WARP-214) — generic "file" icon for new MIME types in v2; per-MIME icons + ASR ETA + recursion breadcrumbs land as a fast follow-up.

## 3. Architecture

```
                  ┌────────── extractors/ (Python, services/file-indexer) ──────────┐
                  │                                                                   │
                  │  registry.py  ─►  dispatch(path, mime, depth=0) → ExtractedDoc    │
                  │     ▲                            │                                │
                  │     │ recursive call (depth+1)   ▼                                │
                  │     │                  ┌─────────────────────────────────────┐    │
                  │     │                  │  Phase 1 leaves                     │    │
                  │     │                  │   text · pdf · docx · image (OCR)   │    │
                  │     │                  └─────────────────────────────────────┘    │
                  │     │                                                              │
                  │     ├── audio.py     (WARP-197) — faster-whisper                  │
                  │     │                       small.en default, CUDA→CPU fallback   │
                  │     │                       single-worker queue                   │
                  │     │                                                              │
                  │     ├── video.py     (WARP-198) — ffprobe → subtitles?            │
                  │     │                       yes: srt/vtt parser → ExtractedDoc    │
                  │     │                       no:  ffmpeg strip audio → audio.py    │
                  │     │                                                              │
                  │     ├── email.py     (WARP-199) — .eml stdlib + .msg via          │
                  │     │                       extract-msg; body→text; recurse       │
                  │     │                       attachments via dispatch(depth+1)     │
                  │     │                                                              │
                  │     └── archive.py   (WARP-200) — zipfile/tarfile streaming       │
                  │                              5-layer bomb defense; recurse        │
                  │                              members via dispatch(depth+1)        │
                  └───────────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- **No new services.** All extractors live inside the existing `services/file-indexer` Python process.
- **Recursion contract.** `dispatch()` gains a `depth: int = 0` parameter and a `MAX_RECURSION_DEPTH = 2` constant. Email and archive extractors increment depth on each recursive call. If `depth > MAX_RECURSION_DEPTH`, the inner call returns an `ExtractedDoc` with empty text + a warning — never raises.
- **Brain memory + Nextcloud parity.** Both ingestion paths produce `FileContentChunk` rows tagged with the right `source` discriminator. Search treats them identically.

## 4. Per-extractor specs

### 4.1 WARP-197 — Audio (`audio.py`)

**Engine:** `faster-whisper` (CTranslate2). Default model `small.en` (~470 MB). Configurable via `ASR_MODEL` env var with allow-list `{tiny.en, base.en, small.en, medium.en, large-v3}`.

**Device selection:** First call tries `device="cuda"`. On CUDA OOM, fall back to `device="cpu"` for that call only; emit a `gpu_unavailable` warning. Next call retries CUDA. Model lazily instantiated on first call, cached on the module.

**Single-worker queue:** All transcription calls go through a `threading.Lock`. At most one ASR job runs at a time across the file-indexer process. Status MQTT events grow a `transcripts_pending: int` field for dashboard surfacing.

**MIME map:** `audio/mpeg`, `audio/mp4` (m4a), `audio/wav`, `audio/x-wav`, `audio/ogg`, `audio/flac`, `audio/webm`, `audio/aac`.

**Output shape:**
- `text` = full transcript, segments newline-separated.
- `metadata.language` = Whisper's auto-detected language code.
- `metadata.duration_sec` = ffprobe duration.
- `page_breaks` = list of segment-end character offsets (for "jump to ~5:30" citations later).
- `warnings` includes `"gpu_unavailable"` when CPU fallback fired.

**Cap:** `AUDIO_MAX_BYTES = 500 * 1024 * 1024` (500 MB). Configurable via env. Files over the cap are rejected with a clear warning; no transcription attempted.

### 4.2 WARP-198 — Video (`video.py`)

**Step 1 — `ffprobe`:** Run `ffprobe -v error -show_streams -of json <path>`. Parse for subtitle streams.

**Step 2a — Subtitles path:** If at least one text-based subtitle stream exists (`codec_name` ∈ `{srt, ass, ssa, mov_text, webvtt}`), pick the first English stream by `tags.language`, else the first one. Extract via `ffmpeg -i <path> -map 0:s:<idx> -c:s text -f srt -` → SubRip text on stdout. Parse with the `srt` Python library. `text` = each cue's text joined with `\n`. `page_breaks` = cue-end character offsets. `metadata.subtitle_source = "embedded"`.

**Step 2b — Audio fallback:** No subtitle stream → `ffmpeg -i <path> -vn -ac 1 -ar 16000 -f wav -` to a temp file → call `audio.py`'s dispatcher. `metadata.subtitle_source = "asr_transcript"`.

**MIME map:** `video/mp4`, `video/quicktime`, `video/x-matroska`, `video/webm`, `video/x-msvideo` (avi), `video/mpeg`. No frame OCR (WARP-208).

**Cap:** `VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024` (2 GB). The audio decode is to a 16 kHz mono WAV temp file in `/tmp` — small even for long videos.

### 4.3 WARP-199 — Email (`email.py`)

**`.eml` (RFC 822):** Stdlib `email.parser.BytesParser`. Compose `text` as:

```
From: alice@example.com
To: bob@example.com
Subject: Q4 budget
Date: 2026-04-15

<body — plaintext part if present, else HTML→text via readability-lxml>
```

**`.msg` (Outlook MAPI):** `extract-msg` (Python package, MIT license, OLE-file based). Same composed shape as `.eml`. The package extracts headers + body and yields attachments as bytes — feed those into the recursive path.

**Attachments:**
1. Detect MIME from filename + magic bytes (`python-magic`).
2. If our registry can handle it → `dispatch(tmpfile, mime, depth=current_depth+1)`.
3. Append the resulting `text` to the parent's text under a `\n--- Attachment: <filename> ---\n` separator.
4. Append the attachment's chunks to the parent's chunk stream, tagged with the parent email's id in `metadata.parent_email_id` so citations can say "attachment in email from Alice."
5. Skip silently if the attachment's MIME is unsupported (warning only — don't fail the whole email).

**MIME map:** `message/rfc822`, `application/vnd.ms-outlook`, `application/x-msmail`. Recursion bounded by `MAX_RECURSION_DEPTH = 2`.

**Cap:** `EMAIL_MAX_BYTES = 100 * 1024 * 1024` (100 MB) on the email envelope. Per-attachment caps from their own MIME class still apply within.

### 4.4 WARP-200 — Archive (`archive.py`)

**Five-layer defense, evaluated in order on every member iteration:**

1. **`MAX_ARCHIVE_MEMBERS = 1000`** — abort early if the manifest has more entries.
2. **Path traversal** — reject any member whose normalized path contains `..` or starts with `/`. Matches the WARP-205 brain export defense.
3. **Per-member size cap** — re-use the per-MIME cap from the member's detected MIME (a 600 MB MP4 inside a zip is still rejected if it exceeds `VIDEO_MAX_BYTES`).
4. **Cumulative decompressed size cap** — `MAX_ARCHIVE_TOTAL_BYTES = 500 * 1024 * 1024` (500 MB). Track running total; abort the moment cumulative output crosses the line.
5. **Streaming reads only** — `zipfile.ZipFile.open(member)` + `read(chunk_size)` loop. Never `extractall()`. Never `read()` without a size argument on an unknown member.

**Recursion:** Each member that survives the five gates is dispatched via `dispatch(member_tmpfile, mime, depth=current_depth+1)`. Same `MAX_RECURSION_DEPTH = 2` cap as email.

**MIME map:** `application/zip`, `application/x-zip-compressed`, `application/x-tar`, `application/gzip`, `application/x-gzip`, `application/x-bzip2`. **No `.7z`** in v2 (WARP-212).

**Cap:** `ARCHIVE_MAX_BYTES = 200 * 1024 * 1024` (200 MB) on the compressed input. The cumulative-decompressed cap is the real defense; the input cap stops obvious abuse before we open the file.

**Encrypted archives:** detect via `zipfile.ZipFile.namelist()` raising `RuntimeError`-style or via `info.flag_bits & 0x1`. Emit a `"encrypted_archive_skipped"` warning and skip — no password prompt in v2 (WARP-212).

## 5. Cross-cutting changes

### 5.1 `registry.py`

```python
MAX_RECURSION_DEPTH = 2
DEFAULT_MAX_BYTES = 50 * 1024 * 1024          # docs (Phase 1)
AUDIO_MAX_BYTES   = int(os.environ.get("AUDIO_MAX_BYTES",   500 * 1024 * 1024))
VIDEO_MAX_BYTES   = int(os.environ.get("VIDEO_MAX_BYTES",  2048 * 1024 * 1024))
EMAIL_MAX_BYTES   = int(os.environ.get("EMAIL_MAX_BYTES",   100 * 1024 * 1024))
ARCHIVE_MAX_BYTES = int(os.environ.get("ARCHIVE_MAX_BYTES", 200 * 1024 * 1024))
```

Per-MIME cap lookup is a small dict keyed by MIME prefix; default falls back to `DEFAULT_MAX_BYTES`. The byte-cap check moves to `dispatch()` so individual extractors don't each have to enforce it.

### 5.2 Brain memory MIME allow-list

`apps/orchestrator/src/routes/files-brain.ts` constants extend with: `audio/*` (the MIMEs in §4.1), `video/*` (the MIMEs in §4.2), `message/rfc822`, `application/vnd.ms-outlook`, `application/x-msmail`, `application/zip`, `application/x-zip-compressed`, `application/x-tar`, `application/gzip`, `application/x-gzip`, `application/x-bzip2`.

The orchestrator-side multipart upload cap stays at 50 MB. Anything bigger has to come in via Nextcloud (which has no upload-time cap on our side). This asymmetry is documented in `docs/RAG_TESTING.md` and the brain memory allow-list comment.

### 5.3 `Dockerfile` deps

Adds to `services/file-indexer/Dockerfile`:

- `ffmpeg` (system, `apt-get install -y ffmpeg`) — ~70 MB.
- `python-magic` + `libmagic1` (system) — ~3 MB.
- `faster-whisper` (pip) — ~30 MB; CTranslate2 wheel pulls in ~150 MB CUDA libs.
- `extract-msg` (pip) — ~3 MB.
- `srt` (pip) — < 1 MB.

**Total Docker image growth:** ~250–300 MB. Acceptable for an edge appliance with 64 GB SSD.

`tesseract-ocr` is already present from WARP-201.

## 6. GPU contention with Ollama

The Ollama runtime in the sibling `droplet-local-LLM` repo holds the GPU during LLM inference. ASR also wants the GPU. We cooperate, never compete:

1. **Single-worker queue** ensures only one ASR job at a time inside file-indexer.
2. **CUDA-first attempt** with a one-shot try/except on `RuntimeError` / CUDA-out-of-memory.
3. **Automatic CPU fallback** for the failing call only; next call tries CUDA again.
4. **Lazy model load** — model is instantiated on first call (5–10 s warm-up cost), cached on the module afterward. Restart of file-indexer drops the cache; not a problem.
5. **Visibility** via the `transcripts_pending` MQTT field so the dashboard can show queue depth.

Worst case: Ollama is mid-inference on a long generation, ASR job lands, CUDA OOM, ASR runs on CPU at ~2–3× real-time on the inference host. User sees a `gpu_unavailable` warning on that chunk's metadata. Acceptable.

## 7. Recursion semantics

`dispatch(path, mime, depth=0) → ExtractedDoc | None`

- `depth = 0` is the "user-uploaded a file" entry point.
- Email and archive extractors increment depth on each inner dispatch.
- If `depth > MAX_RECURSION_DEPTH (2)`, the inner extractor returns an `ExtractedDoc` with `text = ""`, `warnings = ["max_recursion_depth_exceeded"]`, and metadata identifying the format.
- The parent extractor still includes that warning in its merged output so the user sees "10 of 12 attachments indexed; 2 skipped: max_recursion_depth_exceeded."

Why depth = 2: covers the realistic worst case (PDF inside email inside zip), kills pathological nesting (zip inside zip inside zip inside zip).

## 8. Phasing and dispatch plan

```
WARP-199 (email)     ─┐
WARP-200 (archive)   ─┤  dispatch all three Devs in parallel; each lands
WARP-197 (audio)     ─┘  independently
                                                  ▼
                                       WARP-198 (video) — depends on 197 (audio fallback)
```

**Recursion contract carrier.** Whichever of WARP-199 or WARP-200 lands first carries the `dispatch(depth=0)` parameter addition + the `MAX_RECURSION_DEPTH` constant. The other branches rebase onto that change.

**Harness flow per ticket** (same as Phase 1):

1. Dev agent in isolated worktree → fresh branch off latest `main` → TDD per the plan.
2. QA agent independently validates → PASS / PASS_WITH_NOTES / FAIL.
3. Manager (me) synthesizes Dev + QA into a PR body, opens the PR.
4. CI runs the existing per-workspace test workflows + the path-filtered `rag-tests.yml` from WARP-206 (already on `main`, picks up `services/file-indexer/**` and `tests/rag-*` automatically).
5. **Local validation gate** (new in Phase 2): Manager runs `./scripts/test-rag.sh --only <ticket>` on this machine end-to-end with `RUN_RAG_INTEGRATION=1`. The integration test must produce a real `FileContentChunk` and a real citation through `/api/llm/chat`.
6. Admin-merge after CI green and local-gate green.

If the local stack can't boot for environmental reasons (Docker Desktop bind-mount issues etc.), fall back to: (a) the unit test suite + integration test on a manual `setup.sh` Compose run, or (b) document a reproducible manual smoke. Any local validation failure goes back to Dev for revisions — no merge-and-fix-forward.

## 9. Testing

Mirrors Phase 1 — same patterns, same `RUN_RAG_INTEGRATION=1` skip-gate.

### 9.1 Per-ticket unit tests in `services/file-indexer/tests/`

- **WARP-197:** `test_audio.py` — fixture: 5-second WAV with known phrase. Asserts transcript contains the phrase (substring match), `metadata.language = "en"`, `metadata.duration_sec ≈ 5`. CPU-fallback test mocks the CUDA OOM path and asserts the warning lands.
- **WARP-198:** `test_video.py` — two fixtures: `with-srt.mp4` (embedded SRT subtitle) and `no-srt.mp4` (audio only). Asserts `subtitle_source` differs across the two and that both produce non-empty text.
- **WARP-199:** `test_email.py` — fixtures: `simple.eml`, `with-pdf-attachment.eml`, `outlook.msg`. Asserts headers appear in the body text, attachment text is interpolated under the separator, recursion depth tracking works.
- **WARP-200:** `test_archive.py` — fixtures: `simple.zip`, `nested.zip` (zip-in-zip), `bomb.zip` (recursive bomb fixture), `traversal.zip` (zip-slip attempt), `encrypted.zip`. Asserts each of the five defenses fires under the right conditions.

### 9.2 Integration tests in `tests/`

Each gated by `RUN_RAG_INTEGRATION=1`:

- `rag-audio.integration.test.ts` — drop a WAV through brain memory upload → assert chunks contain transcript text.
- `rag-video.integration.test.ts` — drop an MP4-with-SRT and an MP4-without-SRT; assert the right `metadata.subtitle_source` on each.
- `rag-email.integration.test.ts` — drop an `.eml` with a PDF attachment; assert both the email body and the PDF content end up in chunks.
- `rag-archive.integration.test.ts` — drop a `.zip` with mixed contents; assert chunks land for supported members and warnings land for unsupported ones.

### 9.3 CI workflow

The `rag-tests.yml` path filter shipped in WARP-206 already covers `services/file-indexer/**` and `tests/rag-*`, so it picks up Phase 2 tests automatically. The `tests/package.json` `test:rag` script uses `rag-*.integration.test.ts` glob — auto-includes the new suites.

### 9.4 Determinism

Whisper is deterministic at `temperature=0` for a given model + input, but version drift across Whisper releases changes outputs. Tests assert **substring matches** ("the transcript contains the word 'budget'") rather than full-text equality. Documented in `docs/RAG_TESTING.md` alongside the existing LLM-determinism note.

## 10. Cut items + Jira tracking

| Ticket | Item | Why deferred |
|---|---|---|
| WARP-207 | Speaker diarization | Hard to evaluate; v2 use case works without it |
| WARP-208 | Frame OCR for video | Subtitles + audio cover ~95% of real content |
| WARP-209 | Real-time streaming transcription | Privacy + always-on capture is a separate UX story |
| WARP-210 | Live email sync (IMAP/Exchange/Gmail) | Large new auth surface; per-provider design |
| WARP-211 | Bulk mailbox import (.pst/.mbox/Maildir) | Different ingestion UX; multi-GB files |
| WARP-212 | 7z + password-protected archives | Heavy native deps; UX problem for passwords |
| WARP-213 | Auto-tune ASR model size | Speculative until we see real workload data |
| WARP-214 | Dashboard MIME icons + ASR ETA + recursion breadcrumbs | Backend-first; polish lands as fast follow-up |

## 11. Per-user RBAC reminder

All Phase 2 chunks land in the existing `FileContentChunk` table with `userId` set. The Phase 1 hard-`WHERE userId = $1` filter on every query path applies unchanged. Brain memory items follow the same rules: cross-user GET / DELETE returns 404, never 403 (no existence leak).

## 12. Open questions

None. Q1–Q7 of the brainstorm + the Section 3 amendment lock everything.

# RAG integration testing

Operator's guide for the WARP-201..206 RAG integration suite. If you're
triaging a failed `rag-tests` CI run or about to ship a change to
`services/file-indexer/`, `apps/orchestrator/src/routes/files-*`, or
the embedding plumbing, start here.

## What gets tested

Six vitest files live in `tests/`. They share one Compose stack so the
boot cost is amortized.

| File | What it covers |
|---|---|
| `rag-extractors.integration.test.ts` | WARP-201. Drops PDF/DOCX/PNG/text fixtures into Nextcloud, runs `occ files:scan`, asserts `FileContentChunk` rows land with the expected text. Verifies extractor dispatch, MIME routing, and Tesseract OCR. |
| `rag-search.integration.test.ts` | WARP-202. Drives the MCP `search_content` tool over the stdio transport against the live ai-gateway gRPC + pgvector. Asserts `AUTH_REQUIRED` gating, per-user RBAC, and `EMBEDDING_UNAVAILABLE` when ai-gateway is down. |
| `rag-brain-upload.integration.test.ts` | WARP-203. POSTs to `/api/files/brain/upload`, polls until the file-indexer flips `BrainMemoryItem.indexedAt` and writes `FileContentChunk(source='brain')` rows. Asserts the upload returns `202 {itemId, status:"indexing"}` and that another user's row is invisible. |
| `rag-knowledge.integration.test.ts` | WARP-204. Seeds chunks for two users, hits `GET /api/files/knowledge/recent` and `GET /api/files/knowledge/search`. Asserts ordering, cursor pagination (`?before=`), and the cross-user filter. |
| `rag-brain-export.integration.test.ts` | WARP-205. Uploads a brain file, exports the zip via `GET /api/files/brain/export?all=1`, deletes the row, asserts cascade deletion of chunks. |
| `rag-end-to-end.integration.test.ts` | WARP-206. The full chain: PDF into Nextcloud + PNG via brain-upload → wait for indexedAt → POST `/api/llm/chat` twice → assert each response cites the right file with non-empty snippets. Loops 5x for retrieval determinism. |

## Running locally

The runner script handles boot, health checks, and teardown.

```bash
./scripts/test-rag.sh
```

**Prereqs:**
- Docker Desktop or Docker Engine running.
- ≥4 GB free RAM, ≥30 GB free disk (cold image pulls + builds total ~5 GB).
- Allow 20-30 min on the first cold run; 5-12 min once images are cached.

**Run a single file** (escape hatch when iterating on one ticket):

```bash
./scripts/test-rag.sh --only end-to-end       # rag-end-to-end only
./scripts/test-rag.sh --only brain-upload     # rag-brain-upload only
```

**Don't tear down on exit** (useful when you want to poke at the live
stack after a failure):

```bash
./scripts/test-rag.sh --no-down
# Stack stays up. Tear it down by hand later:
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml down -v
```

**Dry run** (print the commands without executing):

```bash
./scripts/test-rag.sh --dry-run
```

### Manual mode (without the runner)

If you need finer control:

```bash
# 1. Boot the stack with the test-port override.
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml \
  up -d db cache broker ai-gateway file-indexer mcp-server orchestrator nextcloud

# 2. Wait for orchestrator health.
curl -sf http://localhost:3000/api/orchestrator/health

# 3. Run vitest directly.
cd tests
RUN_RAG_INTEGRATION=1 API_URL=http://localhost:3000 \
  npx vitest run --no-file-parallelism rag-end-to-end.integration.test.ts
```

## The skip gate

Every RAG integration test wraps its `describe` block in
`describe.skipIf(!SHOULD_RUN)` where `SHOULD_RUN === process.env.RUN_RAG_INTEGRATION === "1"`.

This means:
- Default `npm test` runs do NOT pay the Compose-up tax.
- The full suite runs only when `RUN_RAG_INTEGRATION=1` is set.
- The `tests/package.json` script `test:rag` sets it for you.

## Reading failure modes

Container logs are the primary triage surface. CI uploads them as an
artifact (`rag-tests-logs-<run_id>`); locally, attach a log tail to
the failure manually.

| Symptom | First service to check |
|---|---|
| Extractor unit tests fail; chunks never land | `file-indexer` — Tesseract install, pypdf import, MIME dispatch. |
| Brain-upload returns 500 / chunks never land for brain items | `orchestrator` (multer multipart, BrainMemoryItem write) → `file-indexer` (extractors.dispatch in the brain branch). |
| `search_content` returns empty / `EMBEDDING_UNAVAILABLE` | `ai-gateway` — gRPC port, embed model loaded, JETSON_OLLAMA_URL reachable. |
| `/api/llm/chat` returns 200 but trace has no `search_content` call | `orchestrator` — agent loop iter limit, model not honoring tool prompt. The retrieval test loops 5x to surface this kind of flake. |
| Nextcloud `occ files:scan` hangs forever | `nextcloud` — bootstrap not done yet (occ status fails), or admin user-files dir missing. |
| `localhost:3000` connection refused | The test override wasn't loaded — re-run with `./scripts/test-rag.sh` instead of just `docker compose up`. |

```bash
# Tail one service's logs from a still-running stack:
docker compose -f docker/docker-compose.yml \
  -f docker/docker-compose.test.override.yml \
  logs --tail 100 file-indexer

# Dump everything relevant to a file (mirrors what CI uploads):
for svc in file-indexer orchestrator ai-gateway nextcloud db mcp-server; do
  docker compose -f docker/docker-compose.yml \
    -f docker/docker-compose.test.override.yml \
    logs --no-color "$svc" > "rag-${svc}.log"
done
```

## CI

**The rag-tests workflow does NOT run on pull requests.** WARP-215
moved it to `workflow_dispatch`-only after PR-blocking runs were
hitting 25-30 min and adding too much latency to the merge train.

The four PR-required workflows still cover the RAG surface:
- `file-indexer-tests` (pytest, ~2 min) — exercises every extractor
  unit-level via committed fixtures
- `orchestrator-tests` (vitest, ~1 min) — covers the brain-memory
  routes, the knowledge routes, and the Prisma surface via mocks
- `mcp-server-tests` (vitest, ~1 min) — covers the search-content
  tool wiring
- `docker-build` (image builds, ~12 min) — catches Dockerfile
  regressions before they hit prod

Together those catch ~95% of regressions; this lane is the
"cherry on top" that exercises the live stack and is meant for
manual verification before a major RAG change.

**Run locally** with `./scripts/test-rag.sh` for the inner loop, or
**kick the workflow off manually** from
https://github.com/DropletByWarpLab/droplet-pi-platform/actions/workflows/rag-tests.yml
→ "Run workflow" → pick a branch → "Run workflow".

**Job timeout:** 35 min. Above that we'd start dropping legit slow runs
as flakes; below it Nextcloud's cold bootstrap (~3 min) eats too much
of the budget.

**Failure artifacts:** `rag-tests-logs-<run_id>`. Retention 7 days.
Contains one file per service plus a `ps.txt` snapshot. Download and
grep for `ERROR` / `WARN` first.

## LLM determinism caveat (e2e test)

`rag-end-to-end.integration.test.ts` asserts the **retrieval chain**
(does the agent call `search_content`? does it return the right path?
is the snippet non-empty?), NOT the model's free-form prose.

The "5 runs in a row" loop checks that retrieval — same chunks, same
file, same sentinel — stays stable across model invocations. Free-text
output is allowed to vary; that's a model property, not a RAG one. The
header comment in the test file spells out which axes are deterministic.

If your ai-gateway routes to an off-line Jetson (the default in this
repo), the e2e test will hit the iteration limit on the agent loop —
`stop_reason: "iteration_limit"` is acceptable as long as
`search_content` was called and returned hits. Set
`RAG_E2E_MODEL=<your-test-model>` to override the default model name
the test sends.

## Updating the suite

When you add a new RAG-touching code path:

1. Add a unit test inside the relevant service workspace
   (`services/file-indexer/tests/`, `apps/orchestrator/src/...`,
   `packages/tools-core/`).
2. Only add a new integration test if it spans services. The bar for
   adding to this suite is high — every test increases the suite's
   manual-run latency.
3. Add the new test file to the vitest invocation in
   `.github/workflows/rag-tests.yml` so manual runs pick it up.
4. Update this doc's "What gets tested" table.

## Deferred ASR (WARP-218)

Audio + video uploads via the chat-attachment path are no longer transcribed
synchronously. They land in `BrainMemoryItem.status='queued_for_transcription'`
and a daily APScheduler job in the file-indexer dequeues them once per day at
`TRANSCRIPTION_RUN_LOCAL_TIME` (env, default `03:00` local). The worker lives
in `services/file-indexer/transcription_worker.py`; the schedule wiring lives
in `services/file-indexer/scheduler_service.py`.

### Manual override

Operators (and the dashboard's kebab → "Transcribe now") can promote one
item to immediate processing:

    POST /api/files/brain/:itemId/transcribe-now

Response codes:

  - 202 → MQTT publish fired on `droplet/transcription/run-one`; worker picks
    up out-of-band
  - 401 → no auth
  - 404 → cross-user (no existence leak; same pattern as the GET / DELETE
    routes)
  - 409 → status is already 'indexing' or 'ready'
  - 429 → 3 attempts in last 60 minutes; check `Retry-After`

### Retry cap

Per item, max **3 attempts per rolling 60-minute window**. The window opens
on the first attempt; the cap is enforced both by the worker (silent skip
on the daily run via `db.claim_attempt`) and the orchestrator route (429 +
`Retry-After`). On a successful run the window resets so a transient retry
doesn't penalize a future one.

### Stuck-item reconciliation

On file-indexer startup, `transcription_worker.reconcile_at_startup()` flips
every row in `status='indexing'` with `lastAttemptedAt < NOW() - INTERVAL '6
hours'` back to `queued_for_transcription`. Catches mid-transcription crashes
— without it, those rows would sit in 'indexing' forever.

### Failure-mode cheatsheet

  - Audio/video upload → `BrainMemoryItem.status` = `queued_for_transcription`.
    File-indexer logs `brain_ingest: itemId=… is queued_for_transcription,
    skipping inline dispatch`.
  - Dashboard chip should read "Queued for transcription · runs nightly"
    until the daily run flips it.
  - Force the run early: `TRANSCRIPTION_RUN_LOCAL_TIME=$(date -d '+2 minutes' +'%H:%M')`,
    restart the file-indexer container, watch the worker logs.
  - Force a failure: stop the ai-gateway container, then `transcribe-now`.
    Status should land at `failed` with a populated `failureReason`.

## Frame OCR (WARP-208)

Off by default. When `VIDEO_FRAME_OCR_ENABLED=1`, video uploads also get
frame OCR alongside subtitles or ASR — useful for screencasts, slide decks,
signage videos, and any clip where the on-screen text is the primary signal.

Frame OCR runs **inside** the deferred-ASR path (WARP-218). There is no
new scheduler — when the daily 03:00 transcription window picks up a video
item, frame OCR is layered on top of the subtitle/ASR result before the
text gets chunked.

### Knobs

| Env var | Default | Range | Notes |
|---|---|---|---|
| `VIDEO_FRAME_OCR_ENABLED` | `0` (off) | `0` / `1` | Master switch. `0` keeps WARP-198 behavior intact. |
| `VIDEO_FRAME_OCR_INTERVAL_SEC` | `5` | `1..60` | Frame sample period in seconds. Lower = more frames sampled = more OCR cost. Garbage values fall back to default. |
| `VIDEO_FRAME_OCR_PHASH_THRESHOLD` | `8` | `0..64` | Hamming-distance threshold for the pre-OCR perceptual-hash dedup. Lower = more frames pass through to OCR. `8` is the standard "very similar" cutoff for slide transitions. |

### Cost on a 60-min screencast (5-second sampling)

- Frame sampling (720 frames): ~10s
- 720 phashes: ~5s
- Surviving OCR calls (~5 distinct slides): ~1s
- **Total frame-OCR cost: ~15-20s on top of the existing ASR path.**

Negligible at the WARP-218 deferred-window timescale (the ASR call itself
dominates).

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

`metadata.subtitle_source` carries the combined provenance, one of:

  - `embedded` — subtitles only (frame OCR disabled or produced nothing)
  - `embedded+frame_ocr` — subtitles AND frame OCR
  - `asr_transcript` — ASR only
  - `asr_transcript+frame_ocr` — ASR AND frame OCR
  - `frame_ocr_only` — no subtitles, ASR empty, frame OCR is the sole channel

`metadata.frame_ocr` (new sub-dict) is populated whenever the flag is on and
the path runs, regardless of segment count:

```json
{
  "frames_sampled": 12,
  "frames_ocr_run": 5,
  "segments_emitted": 4,
  "interval_sec_used": 5
}
```

Useful for operators triaging cost vs. quality.

### Smoke test

1. Set `VIDEO_FRAME_OCR_ENABLED=1` and `VIDEO_FRAME_OCR_INTERVAL_SEC=2` in `.env`.
2. Recreate the file-indexer container so the env var is re-read:
   `docker compose -f docker/docker-compose.yml --env-file .env up -d --force-recreate file-indexer`.
3. Drop a `.mp4` with on-screen text into Nextcloud OR upload via brain memory.
4. Force the daily run early: `POST /api/files/brain/:itemId/transcribe-now`.
5. Watch file-indexer logs for `frame_ocr.extract_frame_text` activity.
6. Confirm the chunked text contains `--- Frame OCR ---` and `[mm:ss → mm:ss]`
   timestamp segments:
   `docker compose exec db psql -U droplet -d droplet -c 'SELECT text FROM "FileContentChunk" ORDER BY "indexedAt" DESC LIMIT 3;'`.
7. The dashboard's `/knowledge` source-channel badge will reflect the combined
   provenance via WARP-214's `SourceChannelBadge`.

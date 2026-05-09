# WARP-218 — Deferred ASR + daily transcription window

**Status:** Design — pending user review
**Owner:** Brain memory team
**Date:** 2026-05-08
**Phase 2 reference:** [`docs/superpowers/specs/2026-05-07-rag-phase-2-extractors-design.md`](./2026-05-07-rag-phase-2-extractors-design.md)
**Phase 2 polish reference:** [`docs/superpowers/specs/2026-05-08-warp-214-knowledge-polish-design.md`](./2026-05-08-warp-214-knowledge-polish-design.md)
**Tickets:** WARP-218 (this spec), WARP-219 (adaptive scheduler — Phase 3 follow-up), WARP-222 (Nextcloud-watched audio/video deferral — out of scope here, see §2), WARP-221 (existing while-true scheduler cleanup, follows this PR's apscheduler precedent)

## 1. Goals

Defer audio + video transcription on **chat-attached uploads** (the brain-memory ingestion path) to a daily off-peak window. Phase 2 v1 ships ASR (WARP-197 audio + WARP-198 video) running synchronously when a file is uploaded; on a CPU-only Jetson this saturates the device for tens of minutes per file and contends with the LLM path users are actually here for.

Specifically:

- A new persistent `status` enum on `BrainMemoryItem` (`queued_for_transcription | indexing | ready | failed`).
- Audio/video uploads insert with `status='queued_for_transcription'`. Other MIMEs continue indexing inline.
- A new in-process apscheduler in the file-indexer fires once per day at `TRANSCRIPTION_RUN_LOCAL_TIME` (env, default `03:00` local).
- A worker module (`transcription_worker.py`) dequeues queued items, runs the existing extractor pipeline, transitions status, publishes MQTT for the dashboard.
- An orchestrator route `POST /api/files/brain/:itemId/transcribe-now` lets users promote a queued item to immediate processing via a discreet kebab affordance (already wired in WARP-214).
- Retry cap: **max 3 attempts per rolling 60-minute window** per item. Cap-hit on the daily run is silent skip; on `transcribe-now` is 429 with `Retry-After`.

## 2. Non-goals

Each tracked in a Jira ticket so we don't lose them:

- **Nextcloud-watched audio/video deferral** (WARP-222 — to be filed alongside this PR) — keeps inline today; brain memory only for v1.
- **Adaptive / load-aware scheduler** (WARP-219) — fixed-time first; opportunistic later.
- **Multi-worker parallel transcription** — single-worker, matches the existing WARP-197 ASR queue.
- **Per-user run windows** — one global window for v1.
- **Automatic exponential-backoff retry beyond 3-per-hour** — failures stick until the user explicitly retries OR the daily run picks them up after the window expires.

## 3. Architecture

```
   ┌─── orchestrator ──────────────────────┐
   │  POST /api/files/brain/upload          │
   │     ▼                                   │
   │  if mimeType matches audio/* or video/*:│
   │    INSERT BrainMemoryItem               │
   │    status = 'queued_for_transcription'  │
   │  else:                                  │
   │    status = 'indexing'                  │
   │    (existing path, no change)           │
   │     │                                   │
   │     ▼ MQTT                              │
   │  droplet/files/brain/uploaded           │
   └──────┬──────────────────────────────────┘
          │
          ▼
   ┌─── file-indexer ─────────────────────────────────────────┐
   │  brain_ingest.py:                                          │
   │    if status == 'queued_for_transcription' → log + skip    │
   │    else → existing extract+chunk+embed                     │
   │                                                            │
   │  ┌── apscheduler (NEW) ──────────────────────────────┐    │
   │  │  AsyncIOScheduler                                 │    │
   │  │  CronTrigger(hour=3, minute=0, timezone=LOCAL_TZ) │    │
   │  │  → transcription_worker.run_pass()                │    │
   │  └─────────────┬─────────────────────────────────────┘    │
   │                │                                            │
   │                ▼                                            │
   │  transcription_worker.py (NEW):                            │
   │    SELECT * FROM BrainMemoryItem                            │
   │      WHERE status = 'queued_for_transcription'              │
   │      ORDER BY uploadedAt ASC                                │
   │    for each item:                                           │
   │      if not _claim_attempt(item): skip                     │
   │      UPDATE status = 'indexing'                             │
   │      try:                                                   │
   │        registry.dispatch(storagePath, mimeType)  ← reuses  │
   │        upsert chunks                              ← Phase   │
   │        UPDATE status = 'ready', indexedAt = NOW()    1+2   │
   │        clear retry-window counters                          │
   │      except:                                                │
   │        UPDATE status = 'failed', failureReason = …          │
   │      publish droplet/files/<userId>/brain/indexed           │
   │                                                            │
   │  Subscribes droplet/transcription/run-one (NEW topic)      │
   │    → transcription_worker.run_one(itemId)                  │
   │                                                            │
   │  Startup reconciliation:                                   │
   │    UPDATE BrainMemoryItem                                  │
   │      SET status='queued_for_transcription'                 │
   │      WHERE status='indexing'                               │
   │        AND lastAttemptedAt < NOW() - INTERVAL '6 hours'    │
   │    (catches mid-transcription crash before scheduler runs) │
   └────────────────────────────────────────────────────────────┘
```

**Boundaries:**

- **Orchestrator owns** the upload-route status decision, the `transcribe-now` HTTP route, and the `BrainMemoryItem` schema migration.
- **file-indexer owns** the apscheduler instance, the worker module, the `brain_ingest.py` skip logic, and the startup reconciliation.
- **MQTT** carries status flips (`droplet/files/<userId>/brain/indexed`, existing) and the new run-one command (`droplet/transcription/run-one`). No HTTP between orchestrator and file-indexer; matches existing brain-upload pattern.

## 4. File structure

| Path | Status | Responsibility |
|---|---|---|
| `apps/orchestrator/prisma/schema.prisma` | modify | Add `status`, `failureReason`, `lastAttemptedAt`, `recentAttemptCount`, `recentAttemptWindowStartedAt` columns to `BrainMemoryItem`; add `BrainMemoryItemStatus` enum |
| `apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status/migration.sql` | **new** | Hand-written, IF-NOT-EXISTS-guarded; backfills existing rows (`indexedAt IS NOT NULL` → `ready`; `indexedAt IS NULL` → `indexing`); adds the two new indexes |
| `apps/orchestrator/src/routes/files-brain.ts` | modify | Upload route picks `status` based on MIME class. Add `POST /api/files/brain/:itemId/transcribe-now` route (auth, ownership 404, status-guard 409, rate-limit 429). |
| `apps/orchestrator/src/services/transcription-bus.service.ts` | **new** | Thin wrapper around the existing MQTT client for publishing `droplet/transcription/run-one`. Test seam. |
| `apps/orchestrator/src/__tests__/files-brain.test.ts` | modify | Extend with: status field on GET; audio/video upload sets `queued_for_transcription`; non-audio/video stays `indexing` |
| `apps/orchestrator/src/__tests__/files-brain-transcribe-now.test.ts` | **new** | 401 / 404 / 409 / 429 / 202 paths. MQTT publish verified via mock. |
| `services/file-indexer/transcription_worker.py` | **new** | `run_pass()`, `run_one(itemId)`, `_claim_attempt(item)`, `reconcile_stuck_items()` |
| `services/file-indexer/scheduler_service.py` | **new** | Lifecycle wrapper around `AsyncIOScheduler` + `CronTrigger` from `TRANSCRIPTION_RUN_LOCAL_TIME` env. Initialized from `main.py`. |
| `services/file-indexer/main.py` | modify | Boot the scheduler service after the watcher starts; subscribe to the run-one MQTT topic. |
| `services/file-indexer/brain_ingest.py` | modify | Skip dispatch when row's `status='queued_for_transcription'` |
| `services/file-indexer/requirements.txt` | modify | Add `apscheduler==3.10.4` (canonical version for the project per CLAUDE.md) |
| `services/file-indexer/tests/test_transcription_worker.py` | **new** | All worker behaviors |
| `services/file-indexer/tests/test_scheduler_service.py` | **new** | Scheduler boots with the right CronTrigger; bad env value falls back with a warning |
| `services/file-indexer/tests/test_brain_ingest.py` | modify | Extend with skip-when-queued behavior |
| `CLAUDE.md` | modify | Add the "no guessing, ever" coding standard alongside the no-while-true rule already there |
| `docs/RAG_TESTING.md` | modify | Document the new daily window + manual override + retry cap for operators |

## 5. Schema migration + status state machine

### 5.1 Schema changes

```prisma
model BrainMemoryItem {
  id                String                    @id @default(cuid())
  userId            String
  filename          String
  mimeType          String?
  bytes             BigInt
  storagePath       String
  source            BrainMemorySource
  originatingChatId String?
  uploadedAt        DateTime                  @default(now())
  indexedAt         DateTime?
  extractorWarnings String[]                  @default([])
  hasOriginalBytes  Boolean                   @default(true)

  // WARP-218: explicit status (no guessing from null fields per CLAUDE.md).
  status            BrainMemoryItemStatus     @default(indexing)
  failureReason     String?
  lastAttemptedAt   DateTime?
  // Rolling-hour retry cap (max 3 per 60 minutes).
  recentAttemptCount             Int          @default(0)
  recentAttemptWindowStartedAt   DateTime?

  @@index([userId, uploadedAt])
  @@index([userId, originatingChatId])
  @@index([userId, status])  // dashboard list filtering
  @@index([status])          // worker queue scan
}

enum BrainMemoryItemStatus {
  queued_for_transcription
  indexing
  ready
  failed
}
```

### 5.2 Migration ordering (hand-written SQL)

1. `CREATE TYPE "BrainMemoryItemStatus"` IF NOT EXISTS via DO/EXCEPTION block (matches WARP-203 pattern)
2. `ALTER TABLE "BrainMemoryItem"` ADD COLUMN IF NOT EXISTS each new column
3. **Backfill:**
   - `UPDATE "BrainMemoryItem" SET "status" = 'ready' WHERE "indexedAt" IS NOT NULL`
   - `UPDATE "BrainMemoryItem" SET "status" = 'indexing' WHERE "indexedAt" IS NULL`
   - All audio/video uploads created AFTER the migration take the `queued_for_transcription` path
4. Two new indexes via `CREATE INDEX IF NOT EXISTS`

The `indexedAt` field stays. `status='ready'` is the canonical "done" signal; `indexedAt` is the timestamp. Together — not as state proxies for each other.

### 5.3 State machine

```
                             ┌──────────────────────┐
                             │   <upload arrives>   │
                             └──────────┬───────────┘
                                        │
                  audio/* OR video/*?   │
                          │             │
                ┌─────────┴─────────────┴─┐
                ▼                          ▼
   queued_for_transcription            indexing
        │                                  │
        ├─ daily worker / transcribe-now  ├─ brain_ingest finishes / fails
        │                                  │
        ▼                                  │
   indexing  ◄─────────────────────────────┘
        │
        ├─ success                    ├─ exception
        ▼                              ▼
      ready                         failed
        │                              │
        │ (terminal)                   ├─ user clicks "retry" → transcribe-now
        │                              │
        │                              ▼
        │                         queued_for_transcription
        │                              │
        ▼                              ▼
       (no further transitions)   (loop back)
```

Allowed transitions (enforced in worker + orchestrator):

| From | To | Trigger |
|---|---|---|
| (insert) | `queued_for_transcription` | upload of audio/video MIME |
| (insert) | `indexing` | upload of any other MIME (existing path) |
| `queued_for_transcription` | `indexing` | daily worker dequeues OR `transcribe-now` fires |
| `indexing` | `ready` | extractor pipeline succeeds + chunks land |
| `indexing` | `failed` | extractor or chunker raises |
| `failed` | `queued_for_transcription` | dashboard "Retry" → `transcribe-now` |
| `ready` | (terminal) | no transitions out — re-indexing requires deleting the item |

## 6. Data flow + control plane

### 6.1 Daily run

APScheduler fires at `LOCAL_TZ` `hour=3, minute=0` →
`transcription_worker.run_pass()` →
`SELECT * FROM "BrainMemoryItem" WHERE status = 'queued_for_transcription' ORDER BY uploadedAt ASC` →
For each item:
1. `_claim_attempt(item)` checks the rolling-hour retry cap (§7); if False, skip silently
2. `UPDATE status='indexing', lastAttemptedAt=NOW()`; publish status flip
3. `extractors.registry.dispatch(storagePath, mimeType, depth=0)` → chunker → embedder → upsert chunks
4. On success: `UPDATE status='ready', indexedAt=NOW(), recentAttemptCount=0, recentAttemptWindowStartedAt=NULL, failureReason=NULL`
5. On exception: `UPDATE status='failed', failureReason=<truncated 200 chars>`
6. Publish final status flip via MQTT

Single-worker (sequential). The existing WARP-197 audio extractor's `threading.Lock` still serializes the actual ASR call.

### 6.2 Manual override (`transcribe-now`)

```
Dashboard kebab → POST /api/files/brain/:itemId/transcribe-now
   │
   ▼
orchestrator route:
   - 401 if no auth
   - 404 if item.userId != caller (no existence leak)
   - 409 if status NOT IN ('queued_for_transcription', 'failed')
   - 429 + Retry-After if recentAttemptCount >= 3 within last hour
   - else: publish droplet/transcription/run-one { itemId, userId }
   - return 202 { itemId, status: 'queued' }
   │
   ▼ MQTT
file-indexer subscribes droplet/transcription/run-one
   │
   ▼
transcription_worker.run_one(itemId)
   - Same body as the daily-run inner loop
   - _claim_attempt still applies (defense-in-depth)
   - Re-uses the same status transitions + MQTT status flips
```

### 6.3 Startup reconciliation

On file-indexer boot, before the scheduler starts ticking:

```sql
UPDATE "BrainMemoryItem"
   SET "status" = 'queued_for_transcription'
 WHERE "status" = 'indexing'
   AND "lastAttemptedAt" < NOW() - INTERVAL '6 hours';
```

Catches mid-transcription crash. 6 hours is conservative — much longer than any realistic single-file run, even on a CPU-only Jetson with `large-v3`. Items reset to queued get picked up on the next daily run (or via manual `transcribe-now`).

## 7. Retry cap (max 3 attempts per rolling hour)

Worker-side `_claim_attempt(item)` runs immediately before the status transition to `'indexing'`:

```python
def _claim_attempt(item) -> bool:
    """True if we may attempt now; False if cap hit.

    Three attempts per rolling 60-minute window. Window starts on first
    attempt after a >1h gap (or on a fresh row).
    """
    now = datetime.now(tz=UTC)
    started = item.recentAttemptWindowStartedAt
    if started is None or (now - started) > timedelta(hours=1):
        item.recentAttemptCount = 1
        item.recentAttemptWindowStartedAt = now
        item.lastAttemptedAt = now
        return True
    if item.recentAttemptCount < 3:
        item.recentAttemptCount += 1
        item.lastAttemptedAt = now
        return True
    return False
```

**Cap-hit behavior:**

| Trigger | Response |
|---|---|
| Daily worker dequeues, cap is hit | Skip silently; log info ("3 attempts in last hour for itemId=X — skipping until window expires"). Item stays at current status. Next day's run typically succeeds because the window has rolled. |
| `POST /api/files/brain/:itemId/transcribe-now`, cap hit | **429 Too Many Requests** with `Retry-After: <seconds>` header and body `{ error: "rate_limited", retryAfterSeconds: N, attemptsInWindow: 3 }`. Dashboard shows: "Already retried 3 times this hour. Try again in N minutes." |

**Reset on success:** `recentAttemptCount=0, recentAttemptWindowStartedAt=NULL`. A failed→retry→succeed→fail-again sequence gets a fresh window.

## 8. Error handling

| Failure | Worker behavior |
|---|---|
| Extractor raises | `status='failed'`, `failureReason=<exc>[:200]`. MQTT publishes failure. Worker continues to next item. |
| Chunker / embedder raises | Same as above. |
| ai-gateway down / gRPC UNAVAILABLE | `status='failed'`, `failureReason='embedding service unavailable'`. Next daily run retries (when the rolling-hour window allows). |
| Database transaction fails | Worker logs + bails on this item; next item proceeds. Row stays in whatever status it was at. |
| `storagePath` missing on disk | `status='failed'`, `failureReason='source file missing'`. Doesn't auto-retry. |
| Worker process crashes mid-item | Startup reconciliation (§6.3) flips back to queued after 6h. |
| MQTT broker unavailable when publishing status | DB write is the source of truth; status persists. Dashboard's WARP-214 5-sec poll fallback catches up when MQTT recovers. |
| `transcribe-now` MQTT message lost | User clicks again; idempotent. |

No automatic exponential-backoff. Beyond the 3-per-hour cap, failed items stay failed until the user retries or the next daily run picks them up after the window expires.

## 9. Testing

### 9.1 Unit tests in `services/file-indexer/tests/`

- `test_transcription_worker.py` (new):
  - `run_pass` selects only `queued_for_transcription` items in `uploadedAt ASC` order
  - Status transitions: queued → indexing → ready (success); queued → indexing → failed (extractor raises)
  - MQTT publishes fire on each transition
  - `run_one(itemId)` bypasses `uploadedAt ASC` (single item, by id)
  - **Retry cap behaviors** (5 cases): first attempt opens window, second within window, third caps out, window rolls over after 1h, success resets window
  - Stuck-item reconciliation: rows with `status='indexing'` AND `lastAttemptedAt < NOW() - INTERVAL '6 hours'` flip back to queued

- `test_scheduler_service.py` (new):
  - Boots `AsyncIOScheduler` with the right `CronTrigger` from `TRANSCRIPTION_RUN_LOCAL_TIME` env (default `03:00`)
  - Invalid env value (`"99:99"`, `"banana"`) → falls back to default with warning
  - Lifecycle: `start()` / `shutdown()` work cleanly

- `test_brain_ingest.py` (extend):
  - When MQTT message arrives for an item with `status='queued_for_transcription'`, the ingest skips and logs; doesn't dispatch.

### 9.2 Unit tests in `apps/orchestrator/src/__tests__/`

- `files-brain.test.ts` (extend):
  - Audio/video uploads insert with `status='queued_for_transcription'`
  - Other MIMEs insert with `status='indexing'`
  - GET response includes `status` + `failureReason` + retry-window fields per item

- `files-brain-transcribe-now.test.ts` (new):
  - 401 (no auth)
  - 404 (cross-user — no existence leak)
  - 409 (item already `indexing` or `ready`)
  - 429 (`recentAttemptCount >= 3` in window) — verify `Retry-After` header
  - 202 (success path) — verify MQTT publish via mock

### 9.3 Integration

No new file. Extend `tests/rag-brain-upload.integration.test.ts`:
- Audio/video upload lands at `queued_for_transcription` (not `indexing`).
- Daily-run live-firing isn't tested in the gated integration suite (5-min CI budget per user direction). The post-build manual smoke covers it.

### 9.4 Manual smoke (post-build)

1. `./scripts/test-rag.sh --no-down` to bring up Compose
2. Upload `meeting.wav` via brain-upload API. Verify DB row has `status='queued_for_transcription'`.
3. `POST /api/files/brain/:itemId/transcribe-now`. Watch file-indexer logs; verify status flips through `indexing` → `ready`.
4. Confirm `FileContentChunk` rows landed.
5. Set `TRANSCRIPTION_RUN_LOCAL_TIME=$(date -d '+2 minutes' +'%H:%M')`, restart file-indexer, wait 2 min, verify scheduled run fires for any remaining queued item.
6. Force a failure: temporarily break `ai-gateway` (kill the container), trigger `transcribe-now`, verify `status='failed'` + `failureReason` populated. Repeat 3× in succession; verify the third call returns 429.
7. Document the result in the PR body.

## 10. Phasing & dependencies

**Single PR.** ~10 files touched, ~600 LoC including tests. Estimated 4–6 hours of agent time end-to-end.

Order within the PR:
1. CLAUDE.md "no guessing, ever" addendum (codifies the rule that drove §5)
2. Prisma schema + migration + backfill
3. Orchestrator: upload-route status decision; `transcribe-now` route; `BrainMemoryItem` query updates
4. Transcription bus service (MQTT publish wrapper)
5. file-indexer: `transcription_worker.py` + `scheduler_service.py` + `brain_ingest.py` skip + startup reconciliation
6. MQTT subscribe wiring for the run-one topic
7. Unit tests on both sides
8. Manual smoke
9. PR

**Blocks:** nothing. WARP-214 already renders the chip.

**Unblocks:** WARP-219 (adaptive scheduler — replaces the `CronTrigger` with idle-aware logic), WARP-221 (cleanup of remaining while-true loops, follows this PR's apscheduler precedent).

**Filed alongside this PR:**
- WARP-222 — Nextcloud-watched audio/video deferral (out of scope here)

## 11. Open questions

None. Q1–Q3 of the brainstorm + the retry-cap follow-up resolved them all:

- Q1 — Nextcloud watcher deferral → out of scope (WARP-222 follow-up)
- Q2 — scheduler library → apscheduler in-process (precedent for WARP-221)
- Q3 — status persistence → explicit enum column + `failureReason` + retry-window fields (no derivation)
- Retry policy → max 3 per rolling 60 minutes; reset on success

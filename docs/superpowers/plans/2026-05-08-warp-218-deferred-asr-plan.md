# WARP-218 — Deferred ASR + daily transcription window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Defer audio + video transcription on chat-attached uploads to a daily run at a configurable local time, with a manual "Transcribe now" override and a per-item rolling-hour retry cap (max 3 attempts/hour). Brain memory only — Nextcloud watcher path stays inline (WARP-222 follow-up).

**Architecture:** Persistent `BrainMemoryItemStatus` enum on `BrainMemoryItem` (no derivation per CLAUDE.md "no guessing" rule). The orchestrator's upload route picks status by MIME on insert; an in-process `AsyncIOScheduler` in the file-indexer fires once daily and calls a new `transcription_worker.run_pass()`; a dashboard kebab → `POST /api/files/brain/:itemId/transcribe-now` → MQTT `droplet/transcription/run-one` → `transcription_worker.run_one(itemId)` for one-off promotions. Status flips publish to the existing per-user WS bridge.

**Tech Stack:** TypeScript (orchestrator), Prisma 5, PostgreSQL, Python 3.12 (file-indexer), apscheduler 3.10.x (`AsyncIOScheduler` + `CronTrigger`), paho-mqtt (existing), pgvector (existing), vitest (orchestrator tests), pytest (file-indexer tests).

**Spec:** [`docs/superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md`](../specs/2026-05-08-warp-218-deferred-asr-design.md)

---

## File map (locked before tasks)

| Path | Status | Responsibility |
|---|---|---|
| `CLAUDE.md` | modify | Add "no guessing, ever" coding standard alongside the no-while-true rule |
| `apps/orchestrator/prisma/schema.prisma` | modify | New enum + 5 new columns on `BrainMemoryItem` |
| `apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status/migration.sql` | **new** | Hand-written, idempotent (DO/EXCEPTION + IF NOT EXISTS), backfills existing rows |
| `apps/orchestrator/src/services/transcription-bus.service.ts` | **new** | Thin wrapper over the existing MQTT publish for `droplet/transcription/run-one` |
| `apps/orchestrator/src/__tests__/transcription-bus.service.test.ts` | **new** | Unit test for the publish wrapper |
| `apps/orchestrator/src/routes/files-brain.ts` | modify | Upload route picks status by MIME; GET includes new fields; new `POST /:itemId/transcribe-now` route |
| `apps/orchestrator/src/__tests__/files-brain.test.ts` | modify | Extend with status assertions on POST/GET |
| `apps/orchestrator/src/__tests__/files-brain-transcribe-now.test.ts` | **new** | Auth/ownership/state-guard/rate-limit/success tests |
| `services/file-indexer/requirements.txt` | modify | Add `apscheduler` + `tzlocal` (apscheduler dep, but explicit pin avoids ambiguity) |
| `services/file-indexer/transcription_worker.py` | **new** | `run_pass`, `run_one(itemId)`, `_claim_attempt(item)`, `reconcile_stuck_items()` |
| `services/file-indexer/scheduler_service.py` | **new** | Lifecycle wrapper around `AsyncIOScheduler` + `CronTrigger` from `TRANSCRIPTION_RUN_LOCAL_TIME` env |
| `services/file-indexer/brain_ingest.py` | modify | Skip dispatch when row's `status='queued_for_transcription'` |
| `services/file-indexer/main.py` | modify | Boot scheduler + subscribe to run-one MQTT topic; reconcile stuck items |
| `services/file-indexer/db.py` | modify | New helpers: `select_queued_items`, `update_item_status`, `claim_attempt`, `reconcile_stuck` |
| `services/file-indexer/tests/test_transcription_worker.py` | **new** | All worker behaviors (12 cases) |
| `services/file-indexer/tests/test_scheduler_service.py` | **new** | Scheduler boots with right CronTrigger; bad env → default + warning |
| `services/file-indexer/tests/test_brain_ingest.py` | modify | Skip-when-queued behavior |
| `docs/RAG_TESTING.md` | modify | Operator notes for the daily window + manual override + retry cap |

---

## Phase 1 — Migration + types

### Task 1.1: Codify the "no guessing, ever" coding standard

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the standard alongside the existing no-while-true rule**

Open `CLAUDE.md` and find the existing "Coding standards" section (the no-while-true rule). Add a second bullet directly under it:

```markdown
- **No guessing, ever.** Persistent state lives in explicit columns, not in
  the absence of other columns. If `status` is a property of a row, declare
  it as `status: SomeEnum`; do not derive it from `indexedAt IS NULL` or
  similar absence patterns. Querying for "all failed transcripts" should be
  `WHERE status = 'failed'` — direct, indexable, no joins, no compound
  predicates over nullable fields. Adding a column for the canonical
  representation is cheaper than every reader having to remember the
  derivation rule. WARP-218's `BrainMemoryItemStatus` enum is the canonical
  example; copy that pattern.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: codify 'no guessing, ever' coding standard (WARP-218)"
```

### Task 1.2: Prisma schema — add enum + columns + indexes

**Files:**
- Modify: `apps/orchestrator/prisma/schema.prisma`

- [ ] **Step 1: Read the existing `BrainMemoryItem` model**

```bash
grep -nB1 -A 25 "^model BrainMemoryItem" apps/orchestrator/prisma/schema.prisma
```

Note the current end of the model (the closing `}` before the `enum BrainMemorySource`).

- [ ] **Step 2: Edit the schema**

Add the new enum directly under `enum BrainMemorySource` and extend the model. The diff:

```prisma
model BrainMemoryItem {
  id                            String                    @id @default(cuid())
  userId                        String
  filename                      String
  mimeType                      String?
  bytes                         BigInt
  storagePath                   String
  source                        BrainMemorySource
  originatingChatId             String?
  uploadedAt                    DateTime                  @default(now())
  indexedAt                     DateTime?
  extractorWarnings             String[]                  @default([])
  hasOriginalBytes              Boolean                   @default(true)

  // WARP-218: explicit status (no guessing per CLAUDE.md). The worker
  // updates this; readers query directly. `failureReason` is non-null
  // only when status='failed'. Retry-window fields enforce the
  // max-3-per-rolling-hour cap (see worker's _claim_attempt).
  status                        BrainMemoryItemStatus     @default(indexing)
  failureReason                 String?
  lastAttemptedAt               DateTime?
  recentAttemptCount            Int                       @default(0)
  recentAttemptWindowStartedAt  DateTime?

  @@index([userId, uploadedAt])
  @@index([userId, originatingChatId])
  @@index([userId, status])
  @@index([status])
}

enum BrainMemorySource {
  chat_attachment
}

enum BrainMemoryItemStatus {
  queued_for_transcription
  indexing
  ready
  failed
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/prisma/schema.prisma
git commit -m "feat(orchestrator): BrainMemoryItemStatus enum + retry-window columns (WARP-218)"
```

### Task 1.3: Hand-written migration with idempotent guards + backfill

**Files:**
- Create: `apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status/migration.sql`

- [ ] **Step 1: Create the migration file**

```bash
mkdir -p apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status
```

- [ ] **Step 2: Write the migration**

Create `apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status/migration.sql`:

```sql
-- WARP-218: explicit BrainMemoryItem status enum + retry-window columns.
--
-- Per spec §5 (docs/superpowers/specs/2026-05-08-warp-218-deferred-asr-design.md):
--
--   - New `BrainMemoryItemStatus` enum (queued_for_transcription | indexing
--     | ready | failed) — replaces ad-hoc derivation from `indexedAt IS NULL`.
--   - Five new columns on `BrainMemoryItem`: status, failureReason,
--     lastAttemptedAt, recentAttemptCount, recentAttemptWindowStartedAt.
--   - Backfill: every existing row gets a status that mirrors its current
--     observable state — `indexedAt IS NOT NULL` → 'ready', else 'indexing'.
--     Audio/video uploads created AFTER this migration take the
--     'queued_for_transcription' path via the orchestrator route logic.
--   - Two new indexes: (userId, status) for dashboard list filters,
--     (status) for the worker's queue scan.
--
-- Re-runnable: every CREATE uses DO/EXCEPTION (enums) or IF NOT EXISTS
-- (columns/indexes). Re-running on a populated db must not change row counts.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "BrainMemoryItemStatus" AS ENUM (
        'queued_for_transcription',
        'indexing',
        'ready',
        'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── BrainMemoryItem additions ──

ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "status"
        "BrainMemoryItemStatus" NOT NULL DEFAULT 'indexing';
ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "lastAttemptedAt" TIMESTAMP(3);
ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "recentAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "recentAttemptWindowStartedAt" TIMESTAMP(3);

-- ── Backfill ──
-- The DEFAULT 'indexing' on the column above already covers rows that are
-- still null-indexedAt today. Flip rows that are already indexed → 'ready'.

UPDATE "BrainMemoryItem"
   SET "status" = 'ready'
 WHERE "indexedAt" IS NOT NULL
   AND "status" = 'indexing';

-- ── Indexes ──

CREATE INDEX IF NOT EXISTS "BrainMemoryItem_userId_status_idx"
    ON "BrainMemoryItem"("userId", "status");

CREATE INDEX IF NOT EXISTS "BrainMemoryItem_status_idx"
    ON "BrainMemoryItem"("status");
```

- [ ] **Step 3: Apply the migration locally**

```bash
cd apps/orchestrator
npx prisma migrate dev
```

Expected: "All migrations have been successfully applied" + Prisma client regenerates without errors. If a working `db` container isn't up, skip this step and rely on CI.

- [ ] **Step 4: Verify the column + enum exist (only if step 3 ran)**

```bash
docker compose -f docker/docker-compose.yml exec -T db psql -U droplet -d droplet \
  -c "\d \"BrainMemoryItem\"" 2>&1 | grep -E "status|failureReason|recentAttempt"
```

Expected: 5 rows, including `status | BrainMemoryItemStatus`.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/prisma/migrations/20260508120000_brain_memory_status/migration.sql
git commit -m "feat(orchestrator): migration for BrainMemoryItemStatus + retry-window columns (WARP-218)"
```

### Task 1.4: Regenerate Prisma client

**Files:** (no source changes — generated output)

- [ ] **Step 1: Regenerate**

```bash
cd apps/orchestrator
npx prisma generate
```

Expected: "✔ Generated Prisma Client" — the new fields show up in the generated TypeScript types so subsequent tasks can import `BrainMemoryItemStatus`.

- [ ] **Step 2: TypeScript sanity check**

```bash
cd apps/orchestrator
npx tsc --noEmit 2>&1 | tail -10
```

Expected: no errors. Existing call sites that don't reference the new fields keep compiling because all new fields have defaults.

- [ ] **Step 3: No commit**

Generated artifacts aren't checked in (the `.gitignore` covers `node_modules/.prisma`).

---

## Phase 2 — Orchestrator: transcription bus + routes

### Task 2.1: Transcription bus service (MQTT publish wrapper)

**Files:**
- Create: `apps/orchestrator/src/services/transcription-bus.service.ts`
- Create: `apps/orchestrator/src/__tests__/transcription-bus.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/transcription-bus.service.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { publishRunOne, type TranscriptionPublisher } from "../services/transcription-bus.service.js";

describe("transcription-bus.service", () => {
  it("publishes droplet/transcription/run-one with itemId + userId", () => {
    const calls: Array<{ topic: string; payload: unknown }> = [];
    const publisher: TranscriptionPublisher = {
      publish: (topic, payload) => calls.push({ topic, payload }),
    };

    publishRunOne(publisher, { itemId: "bmi-1", userId: "alice" });

    expect(calls).toHaveLength(1);
    expect(calls[0].topic).toBe("droplet/transcription/run-one");
    expect(calls[0].payload).toEqual({ itemId: "bmi-1", userId: "alice" });
  });

  it("throws when itemId is empty", () => {
    const publisher: TranscriptionPublisher = { publish: vi.fn() };
    expect(() =>
      publishRunOne(publisher, { itemId: "", userId: "alice" })
    ).toThrow(/itemId required/);
  });

  it("throws when userId is empty", () => {
    const publisher: TranscriptionPublisher = { publish: vi.fn() };
    expect(() =>
      publishRunOne(publisher, { itemId: "bmi-1", userId: "" })
    ).toThrow(/userId required/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/transcription-bus.service.test.ts 2>&1 | tail -10
```

Expected: import error — module doesn't exist yet.

- [ ] **Step 3: Create the module**

Create `apps/orchestrator/src/services/transcription-bus.service.ts`:

```typescript
/**
 * WARP-218 — thin wrapper around MQTT publish for the file-indexer's
 * "run one transcription now" command path.
 *
 * The orchestrator's `transcribe-now` route validates the request
 * (auth, ownership, state, retry cap) and then calls into here. The
 * file-indexer subscribes to `droplet/transcription/run-one` and runs
 * the worker against the named itemId out-of-band from the daily
 * scheduled run.
 *
 * Keeping the publish behind a TranscriptionPublisher interface lets
 * tests swap a captured-array fake for the real MQTT client.
 */

export const RUN_ONE_TOPIC = "droplet/transcription/run-one";

export interface TranscriptionPublisher {
  publish(topic: string, payload: unknown): void;
}

export interface RunOnePayload {
  itemId: string;
  userId: string;
}

export function publishRunOne(
  publisher: TranscriptionPublisher,
  payload: RunOnePayload,
): void {
  if (!payload.itemId) {
    throw new Error("publishRunOne: itemId required");
  }
  if (!payload.userId) {
    throw new Error("publishRunOne: userId required");
  }
  publisher.publish(RUN_ONE_TOPIC, payload);
}
```

- [ ] **Step 4: Run tests to confirm green**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/transcription-bus.service.test.ts 2>&1 | tail -10
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/services/transcription-bus.service.ts \
        apps/orchestrator/src/__tests__/transcription-bus.service.test.ts
git commit -m "feat(orchestrator): transcription-bus service for run-one MQTT publish (WARP-218)"
```

### Task 2.2: Upload route picks status by MIME

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Find the upload-route insert**

```bash
grep -nE "prisma.brainMemoryItem.create|status:|mimeType" apps/orchestrator/src/routes/files-brain.ts | head -10
```

Find the `prisma.brainMemoryItem.create({ data: {...} })` call inside `POST /api/files/brain/upload`.

- [ ] **Step 2: Write a failing test**

Open `apps/orchestrator/src/__tests__/files-brain.test.ts`. Find the existing audio-upload test (it asserts a 202 response). Extend it:

```typescript
import { BrainMemoryItemStatus } from "@prisma/client";

it("audio uploads insert with status=queued_for_transcription (WARP-218)", async () => {
  const fakeBytes = Buffer.alloc(64);
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", fakeBytes, { filename: "memo.wav", contentType: "audio/wav" });
  expect(res.status).toBe(202);

  // The mocked create captures the data arg — assert status was set
  // to queued_for_transcription (not 'indexing').
  const createCall = (prismaMock.brainMemoryItem.create as ReturnType<typeof vi.fn>)
    .mock.calls.at(-1)?.[0];
  expect(createCall?.data?.status).toBe(BrainMemoryItemStatus.queued_for_transcription);
});

it("video uploads insert with status=queued_for_transcription (WARP-218)", async () => {
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", Buffer.alloc(64), { filename: "demo.mp4", contentType: "video/mp4" });
  expect(res.status).toBe(202);
  const createCall = (prismaMock.brainMemoryItem.create as ReturnType<typeof vi.fn>)
    .mock.calls.at(-1)?.[0];
  expect(createCall?.data?.status).toBe(BrainMemoryItemStatus.queued_for_transcription);
});

it("document uploads keep status=indexing (existing path) (WARP-218)", async () => {
  const res = await request(app)
    .post("/api/files/brain/upload")
    .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });
  expect(res.status).toBe(202);
  const createCall = (prismaMock.brainMemoryItem.create as ReturnType<typeof vi.fn>)
    .mock.calls.at(-1)?.[0];
  expect(createCall?.data?.status).toBe(BrainMemoryItemStatus.indexing);
});
```

(If the test file uses a different mock name than `prismaMock`, match it. The existing files-brain tests have an established pattern — extend it, don't restructure.)

- [ ] **Step 3: Run to confirm failure**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain.test.ts -t "WARP-218" 2>&1 | tail -10
```

Expected: 3 failures — `status` is undefined or wrong on the captured create call.

- [ ] **Step 4: Modify the upload route**

In `apps/orchestrator/src/routes/files-brain.ts`, find the `data: { ... }` object passed to `prisma.brainMemoryItem.create`. Add a status decision based on the detected MIME:

```typescript
import { BrainMemoryItemStatus } from "@prisma/client";

// Inside the handler, after MIME detection (but before the create call):
const isAudioOrVideo =
  detectedMime.startsWith("audio/") || detectedMime.startsWith("video/");
const initialStatus: BrainMemoryItemStatus = isAudioOrVideo
  ? BrainMemoryItemStatus.queued_for_transcription
  : BrainMemoryItemStatus.indexing;

const item = await prisma.brainMemoryItem.create({
  data: {
    // ... existing fields unchanged ...
    status: initialStatus,
  },
});
```

- [ ] **Step 5: Run tests to confirm green**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain.test.ts 2>&1 | tail -10
```

Expected: all green, including the 3 new WARP-218 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/routes/files-brain.ts \
        apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): upload route picks status by MIME (WARP-218)"
```

### Task 2.3: GET response includes new status fields

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Modify: `apps/orchestrator/src/__tests__/files-brain.test.ts`

- [ ] **Step 1: Locate the GET serializer**

```bash
grep -nE "brainMemoryItem.findMany|GET.*\(.*\/api\/files\/brain" apps/orchestrator/src/routes/files-brain.ts | head
```

Find the function that maps the Prisma row to the JSON response (likely a `serializeItem(row)` helper).

- [ ] **Step 2: Write the failing test**

In `apps/orchestrator/src/__tests__/files-brain.test.ts`:

```typescript
it("GET /api/files/brain surfaces status, failureReason, retry-window fields (WARP-218)", async () => {
  prismaMock.brainMemoryItem.findMany.mockResolvedValue([
    {
      id: "bmi-1",
      userId: "dev",
      filename: "x.wav",
      mimeType: "audio/wav",
      bytes: 100n,
      storagePath: "/data/brain-memory/dev/bmi-1/x.wav",
      source: "chat_attachment",
      originatingChatId: null,
      uploadedAt: new Date("2026-05-01"),
      indexedAt: null,
      extractorWarnings: [],
      hasOriginalBytes: true,
      status: BrainMemoryItemStatus.queued_for_transcription,
      failureReason: null,
      lastAttemptedAt: null,
      recentAttemptCount: 0,
      recentAttemptWindowStartedAt: null,
    },
    {
      id: "bmi-2",
      userId: "dev",
      filename: "y.mp4",
      mimeType: "video/mp4",
      bytes: 200n,
      storagePath: "/data/brain-memory/dev/bmi-2/y.mp4",
      source: "chat_attachment",
      originatingChatId: null,
      uploadedAt: new Date("2026-05-02"),
      indexedAt: null,
      extractorWarnings: [],
      hasOriginalBytes: true,
      status: BrainMemoryItemStatus.failed,
      failureReason: "ffmpeg exit 1",
      lastAttemptedAt: new Date("2026-05-02T03:00:00Z"),
      recentAttemptCount: 1,
      recentAttemptWindowStartedAt: new Date("2026-05-02T03:00:00Z"),
    },
  ]);

  const res = await request(app).get("/api/files/brain");
  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
  expect(res.body.items[0].status).toBe("queued_for_transcription");
  expect(res.body.items[1].status).toBe("failed");
  expect(res.body.items[1].failureReason).toBe("ffmpeg exit 1");
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain.test.ts -t "surfaces status" 2>&1 | tail -10
```

Expected: failure — `status`, `failureReason` are undefined in the response.

- [ ] **Step 4: Update the serializer**

Find the response-shape helper (or the inline `.map(...)` over the findMany rows) and add the new fields:

```typescript
function serializeBrainItem(row: Prisma.BrainMemoryItem) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.bytes),
    uploadedAt: row.uploadedAt.toISOString(),
    originatingChatId: row.originatingChatId,
    // WARP-218: explicit status + failure context for the dashboard chip.
    status: row.status,
    failureReason: row.failureReason,
    // The retry-window fields are intentionally NOT exposed on the wire —
    // they are internal to the worker's _claim_attempt logic and the
    // transcribe-now 429 response. Surfacing them would just leak
    // implementation detail.
  };
}
```

- [ ] **Step 5: Run tests + full files-brain suite**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain.test.ts 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/routes/files-brain.ts \
        apps/orchestrator/src/__tests__/files-brain.test.ts
git commit -m "feat(orchestrator): GET /api/files/brain returns status + failureReason (WARP-218)"
```

### Task 2.4: `POST /api/files/brain/:itemId/transcribe-now` route

**Files:**
- Modify: `apps/orchestrator/src/routes/files-brain.ts`
- Create: `apps/orchestrator/src/__tests__/files-brain-transcribe-now.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/orchestrator/src/__tests__/files-brain-transcribe-now.test.ts`:

```typescript
/**
 * WARP-218 — POST /api/files/brain/:itemId/transcribe-now route.
 *
 * Promotes a queued_for_transcription (or failed) item to immediate
 * processing by publishing droplet/transcription/run-one. Validates auth,
 * ownership, state, and the per-item rolling-hour retry cap (max 3 in
 * the last 60 minutes; cap-hit returns 429 + Retry-After header).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { BrainMemoryItemStatus } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
  },
}));

const { findUniqueMock, updateMock, publishMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock("@prisma/client", async () => {
  const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
  return {
    ...actual,
    PrismaClient: vi.fn(() => ({
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      brainMemoryItem: {
        findUnique: findUniqueMock,
        update: updateMock,
      },
      device: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
      fileContentChunk: { findMany: vi.fn().mockResolvedValue([]) },
    })),
  };
});

vi.mock("../services/mqtt.service.js", () => ({
  publish: (topic: string, payload: unknown) => publishMock(topic, payload),
}));

import { createApp } from "../app.js";
import { PrismaClient } from "@prisma/client";
import { initDeviceService } from "../services/device.service.js";

describe("POST /api/files/brain/:itemId/transcribe-now", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    findUniqueMock.mockReset();
    updateMock.mockReset();
    publishMock.mockReset();
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  function makeRow(overrides: Partial<any> = {}) {
    return {
      id: "bmi-1",
      userId: "dev",
      filename: "x.wav",
      mimeType: "audio/wav",
      bytes: 100n,
      storagePath: "/data/brain-memory/dev/bmi-1/x.wav",
      source: "chat_attachment",
      originatingChatId: null,
      uploadedAt: new Date("2026-05-01"),
      indexedAt: null,
      extractorWarnings: [],
      hasOriginalBytes: true,
      status: BrainMemoryItemStatus.queued_for_transcription,
      failureReason: null,
      lastAttemptedAt: null,
      recentAttemptCount: 0,
      recentAttemptWindowStartedAt: null,
      ...overrides,
    };
  }

  it("returns 404 when the item belongs to another user (no existence leak)", async () => {
    findUniqueMock.mockResolvedValue(makeRow({ userId: "alice" }));
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the item doesn't exist", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(app).post("/api/files/brain/missing/transcribe-now");
    expect(res.status).toBe(404);
  });

  it("returns 409 when status is already 'indexing'", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({ status: BrainMemoryItemStatus.indexing })
    );
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already_processing|invalid_state/);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 409 when status is 'ready' (terminal)", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({ status: BrainMemoryItemStatus.ready })
    );
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
  });

  it("returns 429 when 3 attempts already happened in the last hour", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({
        status: BrainMemoryItemStatus.failed,
        recentAttemptCount: 3,
        recentAttemptWindowStartedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
        lastAttemptedAt: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.attemptsInWindow).toBe(3);
    expect(typeof res.body.retryAfterSeconds).toBe("number");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("ALLOWS retry when 3 attempts happened but the window is older than 1h", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({
        status: BrainMemoryItemStatus.failed,
        recentAttemptCount: 3,
        // Window opened 90 min ago; >1h means it's expired.
        recentAttemptWindowStartedAt: new Date(Date.now() - 90 * 60 * 1000),
        lastAttemptedAt: new Date(Date.now() - 90 * 60 * 1000),
      })
    );
    updateMock.mockResolvedValue(undefined);
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "bmi-1", userId: "dev" }
    );
  });

  it("returns 202 + publishes for a valid queued item", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({ status: BrainMemoryItemStatus.queued_for_transcription })
    );
    updateMock.mockResolvedValue(undefined);
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(res.body.itemId).toBe("bmi-1");
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("returns 202 + publishes for a failed item below the cap", async () => {
    findUniqueMock.mockResolvedValue(
      makeRow({
        status: BrainMemoryItemStatus.failed,
        recentAttemptCount: 1,
        recentAttemptWindowStartedAt: new Date(Date.now() - 5 * 60 * 1000),
      })
    );
    updateMock.mockResolvedValue(undefined);
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain-transcribe-now.test.ts 2>&1 | tail -10
```

Expected: 8 failures — route doesn't exist yet.

- [ ] **Step 3: Implement the route**

In `apps/orchestrator/src/routes/files-brain.ts`, add the new route handler. Place it after the existing `GET /api/files/brain/:itemId` route. Imports go at the top of the file:

```typescript
import {
  BrainMemoryItemStatus,
  type BrainMemoryItem,
} from "@prisma/client";
import { publish as mqttPublish } from "../services/mqtt.service.js";
import { publishRunOne } from "../services/transcription-bus.service.js";

const TRANSCRIBE_NOW_RETRY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const TRANSCRIBE_NOW_RETRY_CAP = 3;

interface CapState {
  windowStartedAt: Date | null;
  attemptCount: number;
}

function isCapHit(state: CapState, now: Date = new Date()): {
  capped: boolean;
  retryAfterSeconds: number;
} {
  if (
    state.windowStartedAt === null ||
    now.getTime() - state.windowStartedAt.getTime() > TRANSCRIBE_NOW_RETRY_WINDOW_MS
  ) {
    return { capped: false, retryAfterSeconds: 0 };
  }
  if (state.attemptCount >= TRANSCRIBE_NOW_RETRY_CAP) {
    const windowExpiresAt =
      state.windowStartedAt.getTime() + TRANSCRIBE_NOW_RETRY_WINDOW_MS;
    return {
      capped: true,
      retryAfterSeconds: Math.max(1, Math.ceil((windowExpiresAt - now.getTime()) / 1000)),
    };
  }
  return { capped: false, retryAfterSeconds: 0 };
}

router.post(
  "/api/files/brain/:itemId/transcribe-now",
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "unauthenticated" });
      }
      const { itemId } = req.params;

      const row = await prisma.brainMemoryItem.findUnique({
        where: { id: itemId },
      });

      // 404 on cross-user (no existence leak — same pattern as WARP-205).
      if (!row || row.userId !== userId) {
        return res.status(404).json({ error: "not_found" });
      }

      // 409 on terminal / mid-flight states.
      if (
        row.status !== BrainMemoryItemStatus.queued_for_transcription &&
        row.status !== BrainMemoryItemStatus.failed
      ) {
        return res.status(409).json({
          error: "invalid_state",
          status: row.status,
        });
      }

      // 429 if rolling-hour retry cap is hit.
      const cap = isCapHit({
        windowStartedAt: row.recentAttemptWindowStartedAt,
        attemptCount: row.recentAttemptCount,
      });
      if (cap.capped) {
        res.setHeader("Retry-After", String(cap.retryAfterSeconds));
        return res.status(429).json({
          error: "rate_limited",
          attemptsInWindow: row.recentAttemptCount,
          retryAfterSeconds: cap.retryAfterSeconds,
        });
      }

      // Flip a failed item back to queued (lets the worker pick it up).
      // Queued rows stay queued — the publish below just promotes them.
      if (row.status === BrainMemoryItemStatus.failed) {
        await prisma.brainMemoryItem.update({
          where: { id: itemId },
          data: { status: BrainMemoryItemStatus.queued_for_transcription },
        });
      }

      publishRunOne({ publish: mqttPublish }, { itemId, userId });

      return res.status(202).json({
        itemId,
        status: BrainMemoryItemStatus.queued_for_transcription,
      });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 4: Run tests**

```bash
cd apps/orchestrator
npx vitest run src/__tests__/files-brain-transcribe-now.test.ts 2>&1 | tail -10
```

Expected: 8 passed.

- [ ] **Step 5: Run the full files-brain suite**

```bash
cd apps/orchestrator
npm test -- files-brain 2>&1 | tail -10
```

Expected: green across all files-brain tests.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/routes/files-brain.ts \
        apps/orchestrator/src/__tests__/files-brain-transcribe-now.test.ts
git commit -m "feat(orchestrator): POST /transcribe-now route with retry cap (WARP-218)"
```

---

## Phase 3 — file-indexer: scheduler + worker + ingest

### Task 3.1: Add apscheduler to requirements

**Files:**
- Modify: `services/file-indexer/requirements.txt`
- Modify: `services/file-indexer/requirements-dev.txt`

- [ ] **Step 1: Read the existing requirements**

```bash
cat services/file-indexer/requirements.txt | tail -10
```

- [ ] **Step 2: Append apscheduler**

Append to `services/file-indexer/requirements.txt`:

```
# WARP-218 — daily scheduling for the deferred-ASR worker. AsyncIOScheduler
# fires `transcription_worker.run_pass()` once per day at
# TRANSCRIPTION_RUN_LOCAL_TIME (default 03:00 local). Pinned because
# apscheduler 3.x and 4.x have incompatible APIs.
apscheduler==3.10.4
```

Append to `services/file-indexer/requirements-dev.txt`:

```
apscheduler==3.10.4
```

(The unit tests need to import apscheduler classes for type hints.)

- [ ] **Step 3: Verify install path**

```bash
cd services/file-indexer
pip install --dry-run -r requirements-dev.txt 2>&1 | grep -iE "apscheduler|tzlocal" | head
```

Expected: `apscheduler-3.10.4` shows ready to install (and `tzlocal` as a transitive dep — needed for `timezone` resolution in the `CronTrigger`).

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/requirements.txt services/file-indexer/requirements-dev.txt
git commit -m "deps(file-indexer): add apscheduler for the daily ASR worker (WARP-218)"
```

### Task 3.2: db.py helpers — `select_queued_items`, `update_item_status`, `claim_attempt`, `reconcile_stuck`

**Files:**
- Modify: `services/file-indexer/db.py`
- Create: `services/file-indexer/tests/test_brain_status_db.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_brain_status_db.py`:

```python
"""WARP-218: db helpers for the BrainMemoryItem status surface."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from db import (
    select_queued_items,
    update_item_status,
    claim_attempt,
    reconcile_stuck_items,
)


def _fake_conn():
    conn = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    return conn, cursor


def test_select_queued_items_filters_by_status_and_orders_oldest_first():
    conn, cur = _fake_conn()
    cur.fetchall.return_value = []
    select_queued_items(conn, limit=50)
    sql = cur.execute.call_args[0][0]
    assert "status" in sql
    assert "queued_for_transcription" in sql
    assert "ORDER BY" in sql.upper()
    assert "uploadedAt" in sql or '"uploadedAt"' in sql


def test_update_item_status_writes_status_and_failure_reason():
    conn, cur = _fake_conn()
    update_item_status(
        conn,
        item_id="bmi-1",
        status="ready",
        failure_reason=None,
    )
    sql = cur.execute.call_args[0][0]
    binds = cur.execute.call_args[0][1]
    assert "UPDATE" in sql.upper()
    assert "status" in sql
    assert "ready" in binds
    assert "bmi-1" in binds


def test_update_item_status_sets_indexed_at_when_ready():
    """status='ready' transitions also set indexedAt + clear retry-window fields."""
    conn, cur = _fake_conn()
    update_item_status(
        conn,
        item_id="bmi-1",
        status="ready",
    )
    sql = cur.execute.call_args[0][0]
    assert "indexedAt" in sql
    assert "recentAttemptCount" in sql  # reset to 0


def test_claim_attempt_first_attempt_opens_window():
    """fresh row → claim_attempt returns True, opens new window."""
    conn, cur = _fake_conn()
    # The implementation reads-then-writes; first-attempt path returns the
    # SQL that updates count=1, windowStartedAt=NOW(). We assert that the
    # write SQL contains the right shape.
    cur.fetchone.return_value = (None, 0)  # (windowStartedAt=NULL, count=0)
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True
    # Two queries fired: SELECT then UPDATE
    assert cur.execute.call_count >= 2
    update_sql = cur.execute.call_args_list[-1][0][0]
    assert "recentAttemptCount" in update_sql
    assert "= 1" in update_sql or "%s" in update_sql  # depending on impl shape


def test_claim_attempt_within_window_increments():
    """Window open, count<3 → returns True, increments to count+1."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(minutes=10),
        2,
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True


def test_claim_attempt_caps_out_at_3_within_window():
    """Window open, count=3 → returns False, no UPDATE fired."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(minutes=10),
        3,
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is False
    # Only the SELECT, no UPDATE.
    assert cur.execute.call_count == 1


def test_claim_attempt_resets_window_after_1_hour():
    """Window opened 90 min ago → fresh window, count=1."""
    conn, cur = _fake_conn()
    cur.fetchone.return_value = (
        datetime.now(tz=timezone.utc) - timedelta(hours=2),
        3,  # would have been capped if window were still open
    )
    ok = claim_attempt(conn, item_id="bmi-1")
    assert ok is True


def test_reconcile_stuck_items_flips_indexing_older_than_6h_back_to_queued():
    conn, cur = _fake_conn()
    cur.rowcount = 2
    n = reconcile_stuck_items(conn, stuck_after_hours=6)
    sql = cur.execute.call_args[0][0]
    assert "UPDATE" in sql.upper()
    assert "queued_for_transcription" in sql
    assert "indexing" in sql
    assert "lastAttemptedAt" in sql
    assert n == 2
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_brain_status_db.py -v 2>&1 | tail -10
```

Expected: ImportError — those helpers don't exist on `db.py` yet.

- [ ] **Step 3: Implement the helpers**

In `services/file-indexer/db.py`, append:

```python
# WARP-218: BrainMemoryItem status helpers used by the transcription worker.
# These do plain psycopg parametrised SQL — same style as upsert_chunk.

def select_queued_items(conn, *, limit: int = 50) -> list[dict]:
    """Return BrainMemoryItem rows with status='queued_for_transcription',
    oldest-first by uploadedAt. Each dict has id, userId, storagePath, mimeType.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "id", "userId", "storagePath", "mimeType"
              FROM "BrainMemoryItem"
             WHERE "status" = 'queued_for_transcription'
             ORDER BY "uploadedAt" ASC
             LIMIT %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {"id": r[0], "userId": r[1], "storagePath": r[2], "mimeType": r[3]}
        for r in rows
    ]


def update_item_status(
    conn,
    *,
    item_id: str,
    status: str,
    failure_reason: str | None = None,
) -> None:
    """Update BrainMemoryItem.status (+ side-effects per the state machine).

    Side effects:
      - status='ready'  → indexedAt = NOW(), failureReason = NULL,
                           recentAttemptCount = 0,
                           recentAttemptWindowStartedAt = NULL
      - status='failed' → failureReason set
      - other transitions → just status (no side effects)
    """
    if status == "ready":
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "status" = %s,
                       "indexedAt" = NOW(),
                       "failureReason" = NULL,
                       "recentAttemptCount" = 0,
                       "recentAttemptWindowStartedAt" = NULL
                 WHERE "id" = %s
                """,
                (status, item_id),
            )
    elif status == "failed":
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "status" = %s,
                       "failureReason" = %s
                 WHERE "id" = %s
                """,
                (status, (failure_reason or "")[:200], item_id),
            )
    else:
        with conn.cursor() as cur:
            cur.execute(
                'UPDATE "BrainMemoryItem" SET "status" = %s WHERE "id" = %s',
                (status, item_id),
            )
    conn.commit()


def claim_attempt(conn, *, item_id: str) -> bool:
    """Apply the rolling-hour retry cap (max 3 / 60 min). Returns True if
    we may proceed (and bumps the counter); False if cap is hit.
    Atomically reads + writes within a single conn transaction.
    """
    from datetime import datetime, timedelta, timezone

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "recentAttemptWindowStartedAt", "recentAttemptCount"
              FROM "BrainMemoryItem"
             WHERE "id" = %s
            """,
            (item_id,),
        )
        row = cur.fetchone()
        if row is None:
            return False
        window_started_at, count = row
        now = datetime.now(tz=timezone.utc)
        # If window expired (>1h since opened) OR never opened → fresh slot.
        if window_started_at is None or (now - window_started_at) > timedelta(hours=1):
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "recentAttemptCount" = 1,
                       "recentAttemptWindowStartedAt" = %s,
                       "lastAttemptedAt" = %s
                 WHERE "id" = %s
                """,
                (now, now, item_id),
            )
            conn.commit()
            return True
        # Window open + count < 3 → bump.
        if count < 3:
            cur.execute(
                """
                UPDATE "BrainMemoryItem"
                   SET "recentAttemptCount" = "recentAttemptCount" + 1,
                       "lastAttemptedAt" = %s
                 WHERE "id" = %s
                """,
                (now, item_id),
            )
            conn.commit()
            return True
        # Cap hit.
        return False


def reconcile_stuck_items(conn, *, stuck_after_hours: int = 6) -> int:
    """Flip rows stuck in 'indexing' (presumably crashed mid-transcription)
    back to 'queued_for_transcription' so the next run picks them up.
    Returns the number of rows updated.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "BrainMemoryItem"
               SET "status" = 'queued_for_transcription'
             WHERE "status" = 'indexing'
               AND "lastAttemptedAt" < NOW() - (%s || ' hours')::interval
            """,
            (str(stuck_after_hours),),
        )
        n = cur.rowcount
    conn.commit()
    return n
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_brain_status_db.py -v 2>&1 | tail -15
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/db.py services/file-indexer/tests/test_brain_status_db.py
git commit -m "feat(file-indexer): db helpers for BrainMemoryItem status + retry cap (WARP-218)"
```

### Task 3.3: `transcription_worker.py` — `run_one(itemId)` + `run_pass()`

**Files:**
- Create: `services/file-indexer/transcription_worker.py`
- Create: `services/file-indexer/tests/test_transcription_worker.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_transcription_worker.py`:

```python
"""WARP-218: transcription worker — daily run + manual override.

Mocks db helpers + the registry dispatch so we can test the worker's
state transitions without spinning up the full Compose stack.
"""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest

import transcription_worker as worker


def _fake_dispatch_returns_doc():
    """Stub registry.dispatch returning a minimal ExtractedDoc."""
    return MagicMock(return_value={
        "text": "transcript",
        "page_breaks": [],
        "language": "en",
        "metadata": {},
        "warnings": [],
    })


def _fake_dispatch_raises(exc=RuntimeError("boom")):
    return MagicMock(side_effect=exc)


def test_run_one_happy_path_transitions_queued_to_ready():
    """Successful run flips status to ready + publishes MQTT."""
    conn = MagicMock()
    publish = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=True), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status") as upd, \
         patch.object(worker, "_dispatch_and_index", _fake_dispatch_returns_doc()), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    # Two updates: queued→indexing, then indexing→ready.
    statuses = [c.kwargs["status"] for c in upd.call_args_list]
    assert statuses == ["indexing", "ready"]
    # Final MQTT publish carries status=ready.
    last_publish = publish.call_args_list[-1]
    assert last_publish[0][0] == "droplet/files/alice/brain/indexed"
    assert last_publish[0][1]["status"] == "ready"


def test_run_one_extractor_raises_transitions_to_failed():
    """Exception in dispatch flips status to failed + records reason."""
    conn = MagicMock()
    publish = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=True), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status") as upd, \
         patch.object(worker, "_dispatch_and_index",
                      _fake_dispatch_raises(RuntimeError("ffmpeg fail"))), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    # Final status: failed; failure_reason includes the exception text.
    failed_call = [c for c in upd.call_args_list if c.kwargs["status"] == "failed"][0]
    assert "ffmpeg fail" in (failed_call.kwargs.get("failure_reason") or "")
    assert publish.call_args_list[-1][0][1]["status"] == "failed"


def test_run_one_skips_when_claim_attempt_returns_false():
    """Cap-hit → no status update, no dispatch, log only."""
    conn = MagicMock()
    publish = MagicMock()
    upd = MagicMock()
    dispatch = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "claim_attempt", return_value=False), \
         patch.object(worker, "fetch_item", return_value={
             "id": "bmi-1", "userId": "alice",
             "storagePath": "/tmp/x.wav", "mimeType": "audio/wav",
         }), \
         patch.object(worker, "update_item_status", upd), \
         patch.object(worker, "_dispatch_and_index", dispatch), \
         patch.object(worker.mqtt_client, "publish", publish):
        worker.run_one("bmi-1")

    upd.assert_not_called()
    dispatch.assert_not_called()
    publish.assert_not_called()


def test_run_pass_processes_all_queued_items_oldest_first():
    """run_pass() iterates select_queued_items and calls run_one for each."""
    conn = MagicMock()
    items = [
        {"id": "bmi-1", "userId": "alice", "storagePath": "/tmp/a.wav", "mimeType": "audio/wav"},
        {"id": "bmi-2", "userId": "bob",   "storagePath": "/tmp/b.mp4", "mimeType": "video/mp4"},
    ]
    run_one_calls: list[str] = []
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "select_queued_items", return_value=items), \
         patch.object(worker, "run_one", side_effect=lambda i: run_one_calls.append(i)):
        worker.run_pass()
    assert run_one_calls == ["bmi-1", "bmi-2"]


def test_reconcile_runs_at_startup():
    """reconcile_stuck_items() flips indexing→queued for items >6h old."""
    conn = MagicMock()
    with patch.object(worker, "_get_conn", return_value=conn), \
         patch.object(worker, "reconcile_stuck_items", return_value=3) as rec:
        worker.reconcile_at_startup()
    rec.assert_called_once()
    assert rec.call_args.kwargs["stuck_after_hours"] == 6
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_transcription_worker.py -v 2>&1 | tail -10
```

Expected: ModuleNotFoundError for `transcription_worker`.

- [ ] **Step 3: Implement the worker**

Create `services/file-indexer/transcription_worker.py`:

```python
"""WARP-218 — daily / manual transcription worker for queued
BrainMemoryItem rows (audio + video).

Two entry points:

  - run_pass()      — iterates ALL items where status='queued_for_transcription'.
                      Called by the AsyncIOScheduler in scheduler_service.py
                      once per day at TRANSCRIPTION_RUN_LOCAL_TIME.
  - run_one(itemId) — single-item promotion. Called from the MQTT subscriber
                      on `droplet/transcription/run-one` (orchestrator's
                      transcribe-now route publishes there).

Both go through the same per-item path:

  1. claim_attempt() — applies the rolling-hour retry cap. False → skip.
  2. update_item_status('indexing') + publish MQTT
  3. dispatch through extractors.registry → chunker → embedder → upsert
  4. on success: update_item_status('ready')
     on exception: update_item_status('failed', failure_reason=<exc>[:200])
  5. publish final status

Single-worker — sequential. The audio extractor's threading.Lock still
serializes the actual ASR call within the dispatcher.

reconcile_at_startup() runs once before the scheduler ticks — it flips any
row stuck in 'indexing' for >6h back to 'queued_for_transcription' so a
crashed mid-transcription doesn't sit forever.
"""
from __future__ import annotations

import logging

import db
import mqtt_client
from db import (
    claim_attempt,
    fetch_item,
    reconcile_stuck_items,
    select_queued_items,
    update_item_status,
)

logger = logging.getLogger(__name__)


def _get_conn():
    """Returns a fresh psycopg connection. Test seam — patched in unit tests."""
    return db.get_conn()


def _publish_status(user_id: str, item_id: str, status: str, reason: str | None = None) -> None:
    """Publish to the per-user WS bridge so the dashboard's useBrainStatus
    hook flips the chip without waiting for a poll."""
    payload = {"itemId": item_id, "status": status}
    if reason is not None:
        payload["reason"] = reason
    mqtt_client.publish(f"droplet/files/{user_id}/brain/indexed", payload)


def _dispatch_and_index(item: dict) -> None:
    """Run the full extractor → chunker → embedder → upsert pipeline.
    Imports lazily so the module is cheap to load in tests that mock it.
    """
    from extractors.registry import dispatch
    from chunker import chunk_text
    from embedder import embed_texts

    storage_path = item["storagePath"]
    mime = item["mimeType"]
    user_id = item["userId"]
    item_id = item["id"]

    doc = dispatch(storage_path, mime, depth=0)
    if doc is None:
        raise RuntimeError(f"extractor refused mime={mime}")

    chunks = chunk_text(doc.get("text", ""))
    if not chunks:
        # Empty transcript is fine — extractor succeeded but produced no text.
        return

    vectors = embed_texts(chunks)
    conn = _get_conn()
    try:
        # Synthetic ncFileId is md5 of (userId, itemId, chunkIdx) — matches
        # the existing brain_ingest convention.
        from brain_ingest import _synthetic_nc_file_id
        for idx, (chunk, vec) in enumerate(zip(chunks, vectors)):
            db.upsert_chunk(
                conn,
                user_id=user_id,
                nc_file_id=_synthetic_nc_file_id(user_id, item_id, idx),
                path=item_id,
                chunk_idx=idx,
                text=chunk,
                embedding=vec,
                source="brain",
                brain_item_id=item_id,
                page_number=None,
                warnings=doc.get("warnings", []) or [],
                metadata=doc.get("metadata"),
            )
    finally:
        conn.close()


def run_one(item_id: str) -> None:
    """Process a single item end-to-end. Catches all exceptions and
    transitions status accordingly — never raises out."""
    conn = _get_conn()
    try:
        item = fetch_item(conn, item_id=item_id)
        if item is None:
            logger.info("transcription_worker.run_one: item %s not found, skipping", item_id)
            return
        if not claim_attempt(conn, item_id=item_id):
            logger.info(
                "transcription_worker.run_one: cap hit for %s (3 attempts in last hour) — skipping",
                item_id,
            )
            return

        update_item_status(conn, item_id=item_id, status="indexing")
        _publish_status(item["userId"], item_id, "indexing")
    finally:
        conn.close()

    # Dispatch outside the conn block so the connection isn't held during
    # what may be a long-running ASR call.
    try:
        _dispatch_and_index(item)
    except Exception as exc:  # noqa: BLE001 — any failure transitions to 'failed'
        logger.exception("transcription_worker: %s failed", item_id)
        c2 = _get_conn()
        try:
            update_item_status(c2, item_id=item_id, status="failed", failure_reason=str(exc))
        finally:
            c2.close()
        _publish_status(item["userId"], item_id, "failed", reason=str(exc))
        return

    c2 = _get_conn()
    try:
        update_item_status(c2, item_id=item_id, status="ready")
    finally:
        c2.close()
    _publish_status(item["userId"], item_id, "ready")


def run_pass() -> None:
    """Process every queued item. Called once daily by the scheduler."""
    conn = _get_conn()
    try:
        items = select_queued_items(conn, limit=100)
    finally:
        conn.close()

    if not items:
        logger.info("transcription_worker.run_pass: no queued items")
        return

    logger.info("transcription_worker.run_pass: processing %d items", len(items))
    for item in items:
        run_one(item["id"])


def reconcile_at_startup() -> None:
    """Flip 'indexing' rows stuck >6h back to queued. Called from main.py
    once before the scheduler starts ticking."""
    conn = _get_conn()
    try:
        n = reconcile_stuck_items(conn, stuck_after_hours=6)
    finally:
        conn.close()
    if n > 0:
        logger.warning(
            "transcription_worker.reconcile: flipped %d stuck rows back to queued", n
        )
```

You'll also need a `fetch_item` helper in `db.py` (the test mocks it). Add to `db.py`:

```python
def fetch_item(conn, *, item_id: str) -> dict | None:
    """Return BrainMemoryItem fields the worker needs, or None."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "id", "userId", "storagePath", "mimeType"
              FROM "BrainMemoryItem"
             WHERE "id" = %s
            """,
            (item_id,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return {"id": row[0], "userId": row[1], "storagePath": row[2], "mimeType": row[3]}
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_transcription_worker.py -v 2>&1 | tail -10
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/transcription_worker.py \
        services/file-indexer/db.py \
        services/file-indexer/tests/test_transcription_worker.py
git commit -m "feat(file-indexer): transcription_worker run_one + run_pass + reconcile (WARP-218)"
```

### Task 3.4: `scheduler_service.py` — apscheduler wiring

**Files:**
- Create: `services/file-indexer/scheduler_service.py`
- Create: `services/file-indexer/tests/test_scheduler_service.py`

- [ ] **Step 1: Write the failing test**

Create `services/file-indexer/tests/test_scheduler_service.py`:

```python
"""WARP-218: AsyncIOScheduler wiring — verifies the cron trigger
boots from TRANSCRIPTION_RUN_LOCAL_TIME with sane defaults.
"""
from __future__ import annotations

import os
from unittest.mock import patch

import pytest

import scheduler_service


def test_parse_run_time_default_is_03_00():
    """No env var → default 03:00."""
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("TRANSCRIPTION_RUN_LOCAL_TIME", None)
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0


def test_parse_run_time_honors_env_var():
    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "02:30"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 2 and m == 30


def test_parse_run_time_falls_back_on_garbage(caplog):
    """Garbage env var → default + warning logged."""
    caplog.set_level("WARNING", logger="scheduler_service")
    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "banana"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0
    assert any("TRANSCRIPTION_RUN_LOCAL_TIME" in r.message for r in caplog.records)


def test_parse_run_time_falls_back_on_out_of_range(caplog):
    caplog.set_level("WARNING", logger="scheduler_service")
    with patch.dict(os.environ, {"TRANSCRIPTION_RUN_LOCAL_TIME": "99:99"}):
        h, m = scheduler_service._parse_run_time()
    assert h == 3 and m == 0


def test_build_scheduler_registers_run_pass():
    """build_scheduler() returns a started AsyncIOScheduler with
    one CronTrigger job pointing at transcription_worker.run_pass."""
    sched = scheduler_service.build_scheduler()
    try:
        jobs = sched.get_jobs()
        assert len(jobs) == 1
        # The trigger string includes 'cron' and the right hour.
        assert "cron" in str(jobs[0].trigger).lower()
    finally:
        sched.shutdown(wait=False)
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_scheduler_service.py -v 2>&1 | tail -10
```

Expected: ModuleNotFoundError.

- [ ] **Step 3: Implement the service**

Create `services/file-indexer/scheduler_service.py`:

```python
"""WARP-218 — apscheduler wiring for the daily transcription run.

Single AsyncIOScheduler instance owned by main.py. Reads
TRANSCRIPTION_RUN_LOCAL_TIME (default '03:00') and registers a single
CronTrigger that calls transcription_worker.run_pass() once per day in the
machine's local timezone.

Lifecycle:
  - build_scheduler() — returns a started scheduler (call shutdown() on exit)
  - on parse failures of the env var, we log a warning and fall back to 03:00
    — better than crashing the file-indexer at startup over a typo
"""
from __future__ import annotations

import logging
import os

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from tzlocal import get_localzone

import transcription_worker

logger = logging.getLogger(__name__)

DEFAULT_HOUR = 3
DEFAULT_MINUTE = 0


def _parse_run_time() -> tuple[int, int]:
    """Parse TRANSCRIPTION_RUN_LOCAL_TIME=HH:MM with safe fallback."""
    raw = os.environ.get("TRANSCRIPTION_RUN_LOCAL_TIME", "").strip()
    if not raw:
        return DEFAULT_HOUR, DEFAULT_MINUTE
    try:
        h_str, m_str = raw.split(":", 1)
        h, m = int(h_str), int(m_str)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError(f"out-of-range hh:mm: {raw}")
        return h, m
    except Exception as exc:
        logger.warning(
            "TRANSCRIPTION_RUN_LOCAL_TIME=%r is invalid (%s); falling back to %02d:%02d",
            raw,
            exc,
            DEFAULT_HOUR,
            DEFAULT_MINUTE,
        )
        return DEFAULT_HOUR, DEFAULT_MINUTE


def build_scheduler() -> AsyncIOScheduler:
    """Build + start a scheduler with one CronTrigger for run_pass()."""
    h, m = _parse_run_time()
    tz = get_localzone()
    scheduler = AsyncIOScheduler(timezone=tz)
    scheduler.add_job(
        transcription_worker.run_pass,
        trigger=CronTrigger(hour=h, minute=m, timezone=tz),
        id="transcription_daily_run",
        name="Daily ASR transcription run",
        replace_existing=True,
        coalesce=True,  # if missed (e.g. process was down at 03:00), run once
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        "Transcription scheduler started — daily run at %02d:%02d %s",
        h, m, str(tz),
    )
    return scheduler
```

- [ ] **Step 4: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_scheduler_service.py -v 2>&1 | tail -10
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add services/file-indexer/scheduler_service.py \
        services/file-indexer/tests/test_scheduler_service.py
git commit -m "feat(file-indexer): scheduler_service for daily ASR run (WARP-218)"
```

### Task 3.5: `brain_ingest.py` — skip when status is queued

**Files:**
- Modify: `services/file-indexer/brain_ingest.py`
- Modify: `services/file-indexer/tests/test_brain_ingest.py`

- [ ] **Step 1: Find the existing handler**

```bash
grep -nB1 -A 25 "handle_brain_uploaded\b" services/file-indexer/brain_ingest.py | head -40
```

Locate the function that consumes `droplet/files/brain/uploaded` MQTT messages and dispatches to extractors.

- [ ] **Step 2: Write the failing test**

In `services/file-indexer/tests/test_brain_ingest.py`, add:

```python
def test_handle_uploaded_skips_when_status_is_queued_for_transcription():
    """WARP-218: when the BrainMemoryItem row's status is
    'queued_for_transcription' (audio/video uploads), the handler logs and
    returns without dispatching the extractor.
    """
    from unittest.mock import patch
    from brain_ingest import handle_brain_uploaded

    payload = {"itemId": "bmi-1", "userId": "alice", "path": "/tmp/x.wav"}

    fetch_returns = {
        "id": "bmi-1",
        "userId": "alice",
        "storagePath": "/tmp/x.wav",
        "mimeType": "audio/wav",
        "status": "queued_for_transcription",
    }

    with patch("brain_ingest._fetch_item_status", return_value="queued_for_transcription"), \
         patch("brain_ingest.dispatch") as dispatch_mock, \
         patch("brain_ingest.publish") as publish_mock:
        handle_brain_uploaded(payload)

    dispatch_mock.assert_not_called()
    # No "indexed" status publish — the daily worker will fire one later.
    publish_mock.assert_not_called()
```

- [ ] **Step 3: Run to confirm failure**

```bash
cd services/file-indexer
python -m pytest tests/test_brain_ingest.py::test_handle_uploaded_skips_when_status_is_queued_for_transcription -v 2>&1 | tail -10
```

Expected: AttributeError on `brain_ingest._fetch_item_status` (helper doesn't exist) OR assertion failure (dispatch was called).

- [ ] **Step 4: Modify brain_ingest.py**

Open `services/file-indexer/brain_ingest.py`. Add a small helper at the top:

```python
def _fetch_item_status(item_id: str) -> str | None:
    """Look up BrainMemoryItem.status. Returns None if the row is missing."""
    import db
    conn = db.get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "status" FROM "BrainMemoryItem" WHERE "id" = %s',
                (item_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    return row[0] if row else None
```

Then near the top of `handle_brain_uploaded`, after parsing the payload but before the dispatch:

```python
def handle_brain_uploaded(payload: dict) -> None:
    item_id = payload.get("itemId")
    user_id = payload.get("userId")
    path    = payload.get("path")
    # ... existing validation ...

    # WARP-218: audio/video uploads are queued for the daily transcription
    # run. brain_ingest is the synchronous path; we MUST NOT dispatch here
    # for queued items — the worker will pick them up.
    status = _fetch_item_status(item_id)
    if status == "queued_for_transcription":
        logger.info(
            "brain_ingest: itemId=%s is queued_for_transcription, skipping inline dispatch",
            item_id,
        )
        return

    # Existing dispatch path:
    doc = dispatch(path, mime)
    # ... rest unchanged ...
```

- [ ] **Step 5: Run tests**

```bash
cd services/file-indexer
python -m pytest tests/test_brain_ingest.py -v 2>&1 | tail -10
```

Expected: existing tests + the new one all pass.

- [ ] **Step 6: Commit**

```bash
git add services/file-indexer/brain_ingest.py \
        services/file-indexer/tests/test_brain_ingest.py
git commit -m "feat(file-indexer): brain_ingest skips queued-for-transcription items (WARP-218)"
```

### Task 3.6: `main.py` — boot scheduler + subscribe to run-one

**Files:**
- Modify: `services/file-indexer/main.py`

- [ ] **Step 1: Read the existing main()**

```bash
grep -nA 60 "^def main" services/file-indexer/main.py | head -80
```

Find where the watcher is started, where MQTT subscriptions are registered, and where the process blocks (signal-driven).

- [ ] **Step 2: Wire scheduler + run-one subscriber**

In `services/file-indexer/main.py`'s `main()`, after the existing watcher + brain-ingest subscription setup but before the signal-driven block:

```python
import asyncio

# ... existing imports unchanged ...
import scheduler_service
import transcription_worker
from mqtt_client import subscribe


def _handle_run_one(payload: dict) -> None:
    """Dispatch a single transcription on demand from the orchestrator's
    transcribe-now route."""
    item_id = payload.get("itemId")
    if not item_id or not isinstance(item_id, str):
        logger.warning("run_one: missing or invalid itemId in payload: %r", payload)
        return
    transcription_worker.run_one(item_id)


def main():
    # ... existing startup ...

    # WARP-218: reconcile any items stuck mid-transcription before the
    # scheduler starts, so a crashed run doesn't leave rows in 'indexing'.
    transcription_worker.reconcile_at_startup()

    # WARP-218: subscribe to the orchestrator's "run one" command topic.
    subscribe("droplet/transcription/run-one", _handle_run_one)

    # WARP-218: start the daily scheduler. Per CLAUDE.md, scheduling work
    # uses apscheduler — never while-True loops.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    scheduler = scheduler_service.build_scheduler()

    def shutdown(*_):
        # ... existing shutdown logic ...
        scheduler.shutdown(wait=False)
        loop.stop()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # The scheduler runs on the asyncio loop; the watcher runs on its own
    # threading.Observer. Both keep the process alive until shutdown().
    try:
        loop.run_forever()
    finally:
        loop.close()
```

(If `main.py` is structured differently — e.g. it uses a watchdog Observer's `.join()` to block — wrap the asyncio loop in a daemon thread instead. The exact integration depends on the existing pattern; the goal is: scheduler running + watcher running + signals handled.)

- [ ] **Step 3: Sanity-check imports**

```bash
cd services/file-indexer
python -c "import main" 2>&1 | tail -5
```

Expected: no ImportError. (Runtime errors are fine — we're not running the daemon, just checking the import graph.)

- [ ] **Step 4: Commit**

```bash
git add services/file-indexer/main.py
git commit -m "feat(file-indexer): main.py boots scheduler + run-one subscriber (WARP-218)"
```

---

## Phase 4 — Docs + final smoke

### Task 4.1: `docs/RAG_TESTING.md` updates

**Files:**
- Modify: `docs/RAG_TESTING.md`

- [ ] **Step 1: Add a "Deferred ASR (WARP-218)" section**

Open `docs/RAG_TESTING.md`. Append a new section near the bottom (before the troubleshooting entries):

```markdown
## Deferred ASR (WARP-218)

Audio + video uploads via the chat-attachment path are no longer transcribed
synchronously. They land in `BrainMemoryItem.status='queued_for_transcription'`
and a daily APScheduler job in the file-indexer dequeues them once per day at
`TRANSCRIPTION_RUN_LOCAL_TIME` (env, default `03:00` local).

### Manual override

Operators (and the dashboard's kebab → "Transcribe now") can promote one
item to immediate processing:

    POST /api/files/brain/:itemId/transcribe-now

Response codes:

  - 202 → MQTT publish fired; worker picks up out-of-band
  - 401 → no auth
  - 404 → cross-user (no existence leak)
  - 409 → status is already 'indexing' or 'ready'
  - 429 → 3 attempts in last 60 minutes; check `Retry-After`

### Retry cap

Per item, max **3 attempts per rolling 60-minute window**. The window opens
on the first attempt; the cap is enforced both by the worker (silent skip
on the daily run) and the orchestrator route (429 + Retry-After). On
success the window resets so a transient retry doesn't penalize a future
one.

### Stuck-item reconciliation

On file-indexer startup, every row in `status='indexing'` with
`lastAttemptedAt < NOW() - INTERVAL '6 hours'` flips back to
`queued_for_transcription`. Catches mid-transcription crashes — without it,
those rows would sit in 'indexing' forever.

### Failure-mode cheatsheet

  - Audio/video upload → `BrainMemoryItem.status` = `queued_for_transcription`.
    File-indexer logs `brain_ingest: itemId=… is queued_for_transcription,
    skipping inline dispatch`.
  - Dashboard chip should read "Queued for transcription · runs nightly"
    until the daily run flips it.
  - Force the run early: `TRANSCRIPTION_RUN_LOCAL_TIME=$(date -d '+2 minutes' +'%H:%M')`,
    restart file-indexer, watch the worker logs.
  - Force a failure: stop the ai-gateway container, then `transcribe-now`.
    Status should land at `failed` with a populated `failureReason`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/RAG_TESTING.md
git commit -m "docs(rag): operator notes for deferred ASR + manual override (WARP-218)"
```

### Task 4.2: Manual smoke + push

- [ ] **Step 1: Full unit test runs**

```bash
cd apps/orchestrator && npm test 2>&1 | tail -15
cd ../../services/file-indexer && python -m pytest tests/ -v 2>&1 | tail -15
```

Expected: green on both. The new tests are additive; no Phase 1+2 regression.

- [ ] **Step 2: Local-stack smoke (best-effort)**

If a local Docker stack is available:

```bash
./scripts/test-rag.sh --no-down
```

Then via `curl`:
1. Upload an audio file via brain-upload API. Verify the response.
2. `docker compose exec db psql -U droplet -d droplet -c 'SELECT id, status FROM "BrainMemoryItem" ORDER BY "uploadedAt" DESC LIMIT 1;'` — confirm `status='queued_for_transcription'`.
3. `curl -X POST http://localhost:3000/api/files/brain/<id>/transcribe-now` — confirm 202.
4. Watch `docker compose logs -f file-indexer` — confirm worker fires + flips status.
5. `docker compose exec db psql -U droplet -d droplet -c 'SELECT status, indexedAt FROM "BrainMemoryItem" WHERE id = $1;'` — confirm `status='ready'`.
6. Hit the same `transcribe-now` endpoint 3× in a row. Confirm the 4th call returns 429 with `Retry-After`.
7. Tear down: `docker compose -f docker/docker-compose.yml -f docker/docker-compose.test.override.yml down`.

If the local stack isn't available (Docker Desktop bind-mount issues, etc.), document the skip + the unit-test green status in the PR body.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin WARP-218
```

- [ ] **Step 4: Hand off to QA**

Do NOT open the PR. Return a self-assessment with these section headers:

```
## Self-assessment

### What I built
- [files created/modified, line counts per phase]

### Tests
- [unit test counts per file]
- [orchestrator + file-indexer suite results]

### Decisions / deviations
- [anything decided differently from the plan, with rationale]
- [places where the codebase shape differed from what the plan assumed]

### Known limits / follow-ups
- [things noticed but not fixed because out of scope]

### Manager-call items (if any)
- [places where the plan was silent / ambiguous and you made a judgement call]

### Local-validation snapshot
- [output of unit tests + manual smoke if it ran]

### Commit log
- [git log --oneline since branch base]
```

The orchestrator will turn this into the PR body and run QA before merging.

---

## Self-review checklist (run before pushing)

1. **Spec coverage:** every §1–11 section in the spec has a task. §1 goals → Tasks 1.2 / 2.2 / 3.1 / 3.4 (the four goals). §2 non-goals → tickets filed (WARP-219/221/222) referenced in the spec. §3 architecture → diagram in the plan header. §4 file map → reflected in the plan's file table. §5 schema → Tasks 1.2 + 1.3. §6 data flow → Tasks 3.3 + 3.5 + 3.6. §7 retry cap → Tasks 2.4 + 3.2 + 3.3. §8 error handling → Task 3.3 (worker exception path). §9 testing → tests in Tasks 2.1, 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 3.5. §10 phasing → Phases 1–4 in this plan.

2. **No placeholders:** searched for `TODO`, `TBD`, `FIXME`. Only references in the self-review checklist itself (descriptive, not actionable).

3. **Type consistency:** `BrainMemoryItemStatus` enum values (`queued_for_transcription`, `indexing`, `ready`, `failed`) are uniform across schema, migration, orchestrator code, worker code, tests. `_claim_attempt` semantics consistent between orchestrator route (`isCapHit`) and file-indexer (`claim_attempt`). Retry-window field names (`recentAttemptCount`, `recentAttemptWindowStartedAt`, `lastAttemptedAt`) match across migration, schema, and code.

4. **Tests run green at every task** — frequent commits ensure incremental verification.

5. **No forbidden surfaces touched:** no `@droplet/tools-core`, no edits to existing migrations (only adds a new one), no `setup.sh` changes, no production Compose secrets.

6. **CLAUDE.md addition is in scope** (Task 1.1) — codifies the rule that drove §5 schema design.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-warp-218-deferred-asr-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks
2. **Inline Execution** — execute tasks in this session with checkpoints

Same harness pattern that landed Phase 1 + 2 + WARP-214.

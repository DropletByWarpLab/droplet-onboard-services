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

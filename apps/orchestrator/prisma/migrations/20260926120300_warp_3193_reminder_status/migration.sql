-- WARP-3193 QUAL-3 / PERF-14 — explicit Reminder lifecycle status.
--
-- The poller selected `dueAt <= now AND completedAt IS NULL AND
-- notifiedAt IS NULL`: state derived from two nullable timestamps, and no
-- index could serve it (only (userId, dueAt) and (completedAt) existed), so
-- every 30 s tick scanned the table. An explicit status indexed with dueAt
-- makes it `status = 'scheduled' AND dueAt <= now ORDER BY dueAt`, an index
-- range read. CLAUDE.md "no guessing"; WARP-218 BrainMemoryItemStatus is the
-- precedent.
--
-- Idempotent: the enum CREATE is duplicate_object-guarded, DDL uses
-- IF [NOT] EXISTS, and each backfill UPDATE re-writes only what it already
-- wrote.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "ReminderStatus" AS ENUM ('scheduled', 'notified', 'completed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Column ──

ALTER TABLE "Reminder"
    ADD COLUMN IF NOT EXISTS "status" "ReminderStatus" NOT NULL DEFAULT 'scheduled';

-- ── Backfill from the timestamps ──
-- Completed wins over notified: the poller's old predicate excluded any
-- completed row whatever its notifiedAt. Everything else keeps 'scheduled'.

UPDATE "Reminder" SET "status" = 'completed'
    WHERE "completedAt" IS NOT NULL;

UPDATE "Reminder" SET "status" = 'notified'
    WHERE "notifiedAt" IS NOT NULL AND "status" = 'scheduled';

-- ── Indexes ──
-- (status, dueAt) serves the poller. (completedAt) served only the list
-- route's completed filter, which now reads status.

CREATE INDEX IF NOT EXISTS "Reminder_status_dueAt_idx" ON "Reminder"("status", "dueAt");

DROP INDEX IF EXISTS "Reminder_completedAt_idx";

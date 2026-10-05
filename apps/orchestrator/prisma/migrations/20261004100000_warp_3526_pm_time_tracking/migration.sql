-- WARP-3526 (ADR-069 WS-10) — time tracking: worklogs and one running timer per
-- person.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmWorklog — one logged span of work on a work item: who spent it, when it
--      began, how many minutes, an optional note. Additive; nothing existing
--      changes meaning.
--
--   2. PmTimer — the timer a person has running. The PRIMARY KEY is "userId", so
--      a second timer for the same person is a unique violation whichever writer
--      attempts it. "Starting a second timer stops the first" is the service's
--      job (it serialises per person with an advisory lock and writes the first
--      timer's worklog); the key is what keeps the rule true if a writer ever
--      skipped the service.
--
--   3. PmWorklog_minutes_range — a CHECK Prisma's schema language cannot express.
--      One entry is at least a minute and at most a day (1..1440). The route and
--      the service validate the same bounds; this is the backstop for a fix-up
--      script or a future importer, and pm-time.pg.test.ts proves it fires.
--
--   4. Both tables cascade from PmWorkItem, so a timer on a deleted work item
--      (or on any item of a deleted project) is removed with it rather than left
--      pointing at nothing, and the cascade scans are indexed (WARP-845).
--
--   5. PmActivityVerb gains time_logged / time_log_updated / time_log_removed.
--      NOTE: these values are added here but are NOT referenced by any statement
--      in this file. Postgres refuses to USE an enum value added by ALTER TYPE in
--      the same transaction the ALTER ran in, and Prisma applies a migration file
--      inside one transaction. The service writes them at runtime, long after
--      this has committed (same arrangement as 20260904140100_warp_2586).
--
-- Additive and idempotent where it can be: the enum additions are guarded, and
-- there is no seed data to re-run.

-- ── PmActivityVerb: time_logged / time_log_updated / time_log_removed ───────
-- Idempotent guard — ALTER TYPE ... ADD VALUE has no transaction-safe
-- IF NOT EXISTS on every supported PG and re-adding an existing value errors.
-- Same pattern as 20260711000000_warp_884_885_pm_schema_hardening.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'time_logged'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'time_logged';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'time_log_updated'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'time_log_updated';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'time_log_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'time_log_removed';
    END IF;
END $$;

-- ── PmWorklog ───────────────────────────────────────────────────────────────
CREATE TABLE "PmWorklog" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorklog_pkey" PRIMARY KEY ("id")
);

-- ── PmTimer ─────────────────────────────────────────────────────────────────
-- "userId" is the primary key on purpose: it is the whole of the one-running-
-- timer-per-person rule.
CREATE TABLE "PmTimer" (
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmTimer_pkey" PRIMARY KEY ("userId")
);

-- The drawer lists an item's entries newest first; the timesheet reads one
-- person's week; a report reads a window across everyone. One index each.
CREATE INDEX "PmWorklog_workItemId_startedAt_idx" ON "PmWorklog"("workItemId", "startedAt");
CREATE INDEX "PmWorklog_userId_startedAt_idx" ON "PmWorklog"("userId", "startedAt");
CREATE INDEX "PmWorklog_startedAt_idx" ON "PmWorklog"("startedAt");

-- WARP-845: Postgres does not index a foreign-key column, and the cascade from
-- PmWorkItem would scan this table to find the timers to remove.
CREATE INDEX "PmTimer_workItemId_idx" ON "PmTimer"("workItemId");

-- Cascade, not SetNull: a worklog or a timer with no work item has nothing to be
-- reported against, and a timer pointing at a deleted item would be a running
-- clock nobody can stop.
ALTER TABLE "PmWorklog" ADD CONSTRAINT "PmWorklog_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmTimer" ADD CONSTRAINT "PmTimer_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-3526: an entry is 1 minute to 24 hours. Zero and negative entries are
-- meaningless; more than a day is several entries.
ALTER TABLE "PmWorklog"
  ADD CONSTRAINT "PmWorklog_minutes_range"
  CHECK ("minutes" >= 1 AND "minutes" <= 1440);

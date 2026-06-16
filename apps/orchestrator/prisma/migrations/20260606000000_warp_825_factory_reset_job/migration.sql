-- WARP-825: Settings Danger Zone — owner-only factory-reset job state.
--
-- Adds the ResetJob table + the explicit ResetJobStatus enum (handbook rule 10
-- — state is explicit, never derived from absence; canonical precedent WARP-218
-- BrainMemoryItemStatus, BUG-3 PoolStatus).
--
-- This migration SEEDS NOTHING — a fresh box has zero reset jobs and runs fine.
-- Nothing auto-creates a job; only an owner-confirmed POST /api/system/reset does.
--
-- Re-runnable: the CREATE TYPE is guarded by DO/EXCEPTION (duplicate_object) and
-- the table + index use IF NOT EXISTS, so re-running on a populated db is a no-op
-- and must not change row counts.

BEGIN;

-- ── Enum (guarded so a re-run is idempotent) ──

DO $$ BEGIN
    CREATE TYPE "ResetJobStatus" AS ENUM (
        'requested',
        'dispatched',
        'failed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "ResetJob" (
    "id"            TEXT NOT NULL,
    "status"        "ResetJobStatus" NOT NULL DEFAULT 'requested',
    "requestedBy"   TEXT,
    "targetName"    TEXT NOT NULL,
    "failureReason" TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResetJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ResetJob_status_createdAt_idx"
    ON "ResetJob" ("status", "createdAt");

COMMIT;

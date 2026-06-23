-- WARP-882 / WS-4: FileEditSession + enums for in-browser editing / co-authoring.
--
-- Per ADR-027 §WS-4: one row per OPEN in-browser editing session keyed on the
-- Nextcloud numeric fileId (co-authoring is a single shared document session,
-- so the fileId is the natural key). `status` is an EXPLICIT enum column — never
-- derived from absence (handbook "state is explicit"; precedent WARP-218
-- BrainMemoryItemStatus).
--
-- This migration is structured to be SAFE TO RE-RUN: enums use the
-- `DO $$ ... EXCEPTION WHEN duplicate_object` idiom (NOTE: `CREATE TYPE ... IF
-- NOT EXISTS` is INVALID Postgres and must NOT be used), the table uses
-- `CREATE TABLE IF NOT EXISTS`, and indexes use `CREATE INDEX IF NOT EXISTS`.
-- Re-running on a populated db must not change row counts or the schema; the
-- test suite asserts re-run idempotence. Modelled on
-- 20260428000000_brain_memory/migration.sql.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "FileEditSessionMode" AS ENUM ('edit', 'view');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "FileEditSessionStatus" AS ENUM ('open', 'closing', 'closed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── FileEditSession ──

CREATE TABLE IF NOT EXISTS "FileEditSession" (
    "ncFileId"     INTEGER                 NOT NULL,
    "ncUser"       TEXT                    NOT NULL,
    "filePath"     TEXT                    NOT NULL,
    "mode"         "FileEditSessionMode"   NOT NULL,
    "status"       "FileEditSessionStatus" NOT NULL DEFAULT 'open',
    "documentKey"  TEXT                    NOT NULL,
    "openedAt"     TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"     TIMESTAMP(3),

    CONSTRAINT "FileEditSession_pkey" PRIMARY KEY ("ncFileId")
);

CREATE INDEX IF NOT EXISTS "FileEditSession_status_idx"
    ON "FileEditSession"("status");

CREATE INDEX IF NOT EXISTS "FileEditSession_ncUser_status_idx"
    ON "FileEditSession"("ncUser", "status");

-- WARP-3425: File.status, whether Nextcloud still has the file.
--
-- The File registry is written on upload and nothing ever updated it after
-- that, so a delete by any path (the Files page, Nextcloud, a sync client, a
-- trash purge, a wiped group folder) left a row claiming the file existed. On
-- the test box 33 Workspace rows pointed at file ids Nextcloud no longer had.
-- reconcileFileRegistry (file-registry.service.ts) now sets `missing` after a
-- successful read of Nextcloud's file cache shows the id is gone. CLAUDE.md
-- "no guessing": the state is an explicit enum, never inferred from a NULL.
--
-- Idempotent: CREATE TYPE is duplicate_object guarded, ADD COLUMN IF NOT
-- EXISTS. Every existing row takes the default (`live`); the first sweeps
-- after deploy mark the stale ones. No backfill here: this migration cannot
-- see Nextcloud's database.

DO $$ BEGIN
    CREATE TYPE "FileRegistryStatus" AS ENUM ('live', 'missing');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "File"
    ADD COLUMN IF NOT EXISTS "status" "FileRegistryStatus" NOT NULL DEFAULT 'live';

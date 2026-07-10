-- WARP-1139/WARP-1140: explicit per-file indexing status for the
-- file-indexer's Nextcloud watcher corpus.
--
-- Per the CLAUDE.md "no guessing" rule (WARP-218 convention): whether a file
-- has been indexed must live in an explicit status column, not be derived
-- from the ABSENCE of FileContentChunk rows. The file-indexer upserts a row
-- per watched file at each pipeline stage (indexing → ready | skipped |
-- failed); GET /api/files/search/status reads the pending/failed counts so
-- the Files search UI can say "still indexing" instead of "no match".
--
-- Idempotent (same discipline as 20260428000000_brain_memory): CREATEs use
-- IF NOT EXISTS / duplicate_object guards so a re-run is a no-op.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "FileIndexState" AS ENUM ('indexing', 'ready', 'skipped', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "FileIndexStatus" (
    "userId"    TEXT NOT NULL,
    "path"      TEXT NOT NULL,
    "ncFileId"  INTEGER,
    "status"    "FileIndexState" NOT NULL,
    "reason"    TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileIndexStatus_pkey" PRIMARY KEY ("userId", "path")
);

CREATE INDEX IF NOT EXISTS "FileIndexStatus_userId_status_idx"
    ON "FileIndexStatus"("userId", "status");

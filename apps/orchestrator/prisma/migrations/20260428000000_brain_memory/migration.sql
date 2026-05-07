-- WARP-203: BrainMemoryItem + FileContentSource additions.
--
-- Per spec §6.1 (docs/superpowers/specs/2026-04-28-rag-system-design.md):
--
--   - New `FileContentSource` enum (nextcloud | brain) — `FileContentChunk`
--     gains a `source` discriminator so the existing watcher path keeps
--     writing nextcloud chunks while the new brain-upload pipeline writes
--     brain chunks under the SAME table (a single cosine search hits both).
--   - New `BrainMemorySource` enum (chat_attachment) — extension point for
--     future drop sources (mobile share-sheet, etc.).
--   - New `BrainMemoryItem` row: per-user manifest of an uploaded file.
--   - Extra `FileContentChunk` columns + indexes for recency / brain-item
--     join. `pageNumber` and `warnings` carry citation precision through
--     to the dashboard chip.
--
-- This migration is structured to be safe to re-run: every CREATE uses
-- `IF NOT EXISTS` (or `DO $$ ... EXCEPTION WHEN duplicate_object`) and every
-- ALTER uses `ADD COLUMN IF NOT EXISTS`. Re-running on a populated db must
-- not change row counts or the schema; the test suite asserts this.

-- ── Enums ──

DO $$ BEGIN
    CREATE TYPE "FileContentSource" AS ENUM ('nextcloud', 'brain');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "BrainMemorySource" AS ENUM ('chat_attachment');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── FileContentChunk additions ──

ALTER TABLE "FileContentChunk"
    ADD COLUMN IF NOT EXISTS "source"      "FileContentSource" NOT NULL DEFAULT 'nextcloud';
ALTER TABLE "FileContentChunk"
    ADD COLUMN IF NOT EXISTS "brainItemId" TEXT;
ALTER TABLE "FileContentChunk"
    ADD COLUMN IF NOT EXISTS "pageNumber"  INTEGER;
ALTER TABLE "FileContentChunk"
    ADD COLUMN IF NOT EXISTS "warnings"    TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "FileContentChunk_userId_source_indexedAt_idx"
    ON "FileContentChunk"("userId", "source", "indexedAt");

CREATE INDEX IF NOT EXISTS "FileContentChunk_brainItemId_idx"
    ON "FileContentChunk"("brainItemId");

-- ── BrainMemoryItem ──

CREATE TABLE IF NOT EXISTS "BrainMemoryItem" (
    "id"                TEXT                NOT NULL,
    "userId"            TEXT                NOT NULL,
    "filename"          TEXT                NOT NULL,
    "mimeType"          TEXT,
    "bytes"             BIGINT              NOT NULL,
    "storagePath"       TEXT                NOT NULL,
    "source"            "BrainMemorySource" NOT NULL,
    "originatingChatId" TEXT,
    "uploadedAt"        TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexedAt"         TIMESTAMP(3),
    "extractorWarnings" TEXT[]              NOT NULL DEFAULT '{}',
    "hasOriginalBytes"  BOOLEAN             NOT NULL DEFAULT true,

    CONSTRAINT "BrainMemoryItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BrainMemoryItem_userId_uploadedAt_idx"
    ON "BrainMemoryItem"("userId", "uploadedAt");

CREATE INDEX IF NOT EXISTS "BrainMemoryItem_userId_originatingChatId_idx"
    ON "BrainMemoryItem"("userId", "originatingChatId");

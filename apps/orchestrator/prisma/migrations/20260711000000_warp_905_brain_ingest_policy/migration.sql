-- WARP-905: explicit per-item ingest policy for chat-attached brain uploads.
--
-- Today an upload is embedded unconditionally the moment the file-indexer
-- receives `droplet/files/brain/uploaded`. WARP-905 adds an optional
-- "await-approval" mode: the upload is HELD until a human releases it via
-- POST /api/files/brain/:id/approve. Whether an item is held must live in an
-- explicit column (CLAUDE.md "no guessing" rule; WARP-218's
-- BrainMemoryItemStatus is the canonical precedent) — NOT be derived from the
-- absence of chunks or from a status the pipeline never advanced.
--
-- Additive + indexed. The column defaults to 'auto_embed' so every existing
-- row keeps today's behaviour with no backfill. Idempotent (same discipline
-- as 20260709000000_warp_1140_file_index_status): the enum CREATE is
-- duplicate_object-guarded and the DDL uses IF NOT EXISTS.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "BrainIngestPolicy" AS ENUM ('auto_embed', 'await_approval');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Column ──

ALTER TABLE "BrainMemoryItem"
    ADD COLUMN IF NOT EXISTS "ingestPolicy" "BrainIngestPolicy" NOT NULL DEFAULT 'auto_embed';

-- ── Index for the "items awaiting my approval" query ──

CREATE INDEX IF NOT EXISTS "BrainMemoryItem_userId_ingestPolicy_idx"
    ON "BrainMemoryItem"("userId", "ingestPolicy");

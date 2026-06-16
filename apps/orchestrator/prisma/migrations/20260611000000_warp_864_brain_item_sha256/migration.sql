-- WARP-864: content-hash dedup for brain uploads.
--
-- Re-uploading the same file used to create a brand-new BrainMemoryItem
-- every time (new row, new copy of the bytes, full re-ingest into
-- brain_chunks). The upload route now hashes the bytes and reuses the
-- existing row on a (userId, sha256) match.
--
-- UNIQUE rather than a plain index so concurrent identical uploads
-- (double-click submit) cannot race past the pre-insert lookup — the
-- second insert hits the constraint and the route falls back to reuse.
-- Postgres treats NULLs as distinct, so existing rows (which stay NULL
-- until backfilled out-of-band) never collide with each other.
--
-- Idempotent: re-running on a converged DB is a no-op.

ALTER TABLE "BrainMemoryItem" ADD COLUMN IF NOT EXISTS "sha256" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "BrainMemoryItem_userId_sha256_key"
    ON "BrainMemoryItem" ("userId", "sha256");

-- WARP-286: lexical search via Postgres native FTS.
-- Generated tsvector column over FileContentChunk.text. STORED means the
-- value is computed at insert/update time and persisted on disk —
-- no per-query computation cost.
ALTER TABLE "FileContentChunk"
  ADD COLUMN "text_tsv" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("text", '')), 'A')
  ) STORED;

-- GIN index over the tsvector for fast @@ matches.
CREATE INDEX "FileContentChunk_text_tsv_idx"
  ON "FileContentChunk" USING GIN ("text_tsv");

-- Per-user lexical search filter: planner picks this when the user
-- has many chunks and the query is highly selective. With ~100k chunks
-- per user, the cost-based optimizer chooses the right path.
CREATE INDEX "FileContentChunk_userId_lexical_idx"
  ON "FileContentChunk" ("userId");

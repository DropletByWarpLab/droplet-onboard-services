-- WARP-3193 PERF-7 — indexes for the activity feed's filters.
--
-- GET /api/activity pages `ORDER BY "id" DESC LIMIT n` with an optional
-- `kind = $k` and an optional `what ILIKE '%q%' OR sub ILIKE '%q%'`. The
-- existing (at, kind) and (at) indexes serve neither: a sparse kind or a rare
-- search term walked the id index backwards through the whole 90-day
-- retention window, filtering row by row.
--
--   * (kind, id DESC) turns the ?kind= page into an index range read.
--   * Trigram GIN indexes on what/sub let the planner answer the ILIKE with a
--     bitmap scan. A btree cannot serve a leading-wildcard LIKE at all.
--
-- pg_trgm ships in postgres contrib, which the pgvector/pgvector:pg16 image
-- (official postgres:16 + pgvector) includes, and it is a trusted extension
-- since PG13. IF NOT EXISTS keeps a re-run and a box that already has it
-- clean.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ActivityRow_kind_id_idx" ON "ActivityRow"("kind", "id" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ActivityRow_what_idx" ON "ActivityRow" USING GIN ("what" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ActivityRow_sub_idx" ON "ActivityRow" USING GIN ("sub" gin_trgm_ops);

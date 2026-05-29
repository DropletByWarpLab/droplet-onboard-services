-- WARP-473 — Phase G1. File ↔ ChatMessage citation join table.
--
-- One row per tool_result (file_results | code_block) that references a
-- file path. Backs the §2.3 file-detail drawer's "Related chats" section.
--
-- Inserts are fire-and-forget from the agent loop (setImmediate) so this
-- table tolerates duplicates on (filePath, messageId) without enforcing
-- uniqueness — the dashboard de-dupes on render and we'd rather not add
-- a unique constraint that could throw inside a fire-and-forget callback.
--
-- Idempotent: IF NOT EXISTS for the table + index. Same posture as the
-- WARP-456 / WARP-457 / WARP-460 / WARP-461 / WARP-467 / WARP-468 /
-- WARP-470 migrations.

CREATE TABLE IF NOT EXISTS "FileCitation" (
    "id"        TEXT         NOT NULL,
    "filePath"  TEXT         NOT NULL,
    "userId"    TEXT         NOT NULL,
    "threadId"  TEXT         NOT NULL,
    "messageId" TEXT         NOT NULL,
    "citedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileCitation_pkey" PRIMARY KEY ("id")
);

-- Composite range-scan index for the IDOR-safe related-chats query:
--   SELECT … FROM "FileCitation"
--   WHERE "filePath" = $1 AND "userId" = $2
--   ORDER BY "citedAt" DESC
--   LIMIT 20;
-- Owner/admin queries strip the userId predicate but the leading column
-- order still indexes them efficiently.
CREATE INDEX IF NOT EXISTS "FileCitation_filePath_userId_citedAt_idx"
    ON "FileCitation"("filePath", "userId", "citedAt" DESC);

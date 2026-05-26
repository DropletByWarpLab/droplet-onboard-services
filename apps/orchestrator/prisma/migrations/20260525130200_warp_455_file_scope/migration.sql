-- WARP-455: File scope registry + idempotent backfill.
--
-- The orchestrator does not own file bytes — Nextcloud does. The `File`
-- table is a thin scope-bearing registry keyed by Nextcloud's stable
-- `ncFileId`, the same identifier `FileContentChunk.ncFileId` already
-- uses. Scope-filtered file surfaces JOIN one row per logical file
-- instead of scanning per-chunk rows for distinct ncFileIds.
--
-- `scope` is the Scope pgEnum (created in 20260525130100_warp_455_scope_axis)
-- and defaults to 'team' — the household-wide default. Operators tighten
-- the scope from there via the dashboard (follow-up ticket).
--
-- Backfill seeds one File row per distinct (ncFileId, userId) pair already
-- in FileContentChunk so existing indexed files land in the registry at
-- the default scope. ON CONFLICT (ncFileId) DO NOTHING guards the upsert
-- so re-running the migration on a converged DB is a no-op (stable row
-- count) — same hygiene WARP-446's AP migration uses.

-- ── Table ──

CREATE TABLE IF NOT EXISTS "File" (
    "id" TEXT NOT NULL,
    "ncFileId" INTEGER NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "scope" "Scope" NOT NULL DEFAULT 'team',
    "path" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "File_ncFileId_key" ON "File"("ncFileId");
CREATE INDEX IF NOT EXISTS "File_ownerUserId_idx" ON "File"("ownerUserId");
CREATE INDEX IF NOT EXISTS "File_scope_idx" ON "File"("scope");

-- ── Backfill ──
-- Seed one File row per distinct ncFileId already known to the indexer.
-- nextcloud-source chunks are the only ones with a real ncFileId; brain
-- chunks set ncFileId=0 (see schema.prisma comment on FileContentChunk),
-- so the WHERE filters them out.
--
-- ON CONFLICT DO NOTHING + the unique index on ncFileId give us
-- idempotence: re-running this migration on a converged DB inserts zero
-- new rows. gen_random_uuid() is available everywhere on Postgres 13+
-- (no extension required).
--
-- `path` is left NULL on backfill — the file-indexer's MQTT bridge
-- repopulates it on the next indexed event. The dashboard handles a
-- NULL path by falling back to the ncFileId.

-- An ncFileId is unique in the registry, but in FileContentChunk it can
-- have appeared under multiple userIds across re-indexing events. We
-- pick a deterministic owner per ncFileId (MIN(userId)) so the backfill
-- is stable across re-runs and across machines.
INSERT INTO "File" ("id", "ncFileId", "ownerUserId", "scope", "path", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text AS "id",
    "ncFileId",
    MIN("userId") AS "ownerUserId",
    'team'::"Scope" AS "scope",
    NULL AS "path",
    CURRENT_TIMESTAMP AS "createdAt",
    CURRENT_TIMESTAMP AS "updatedAt"
FROM "FileContentChunk"
WHERE "ncFileId" > 0
GROUP BY "ncFileId"
ON CONFLICT ("ncFileId") DO NOTHING;

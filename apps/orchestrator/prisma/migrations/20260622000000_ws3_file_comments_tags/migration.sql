-- WARP-881 / WS-3 (ADR-027): native file comments + tags/metadata.
--
-- Nextcloud stays dumb storage (ADR-013); Droplet owns this metadata in
-- Prisma, exactly like FileCitation / ActivityRow. Both tables are keyed on
-- `ncFileId` (oc:fileid, resolved via ncGetFileId) — the SAME identifier
-- File.ncFileId / FileContentChunk.ncFileId use — so the metadata SURVIVES a
-- rename/move. (Deliberately NOT path-keyed like FileCitation, whose rows go
-- stale on rename.)
--
-- IDOR: FileComment.authorUserId / FileTag.addedByUserId store the LOCAL
-- User.id UUID (req.user.id), NOT the Nextcloud username. The comment read
-- filter scopes a non-privileged user to (ncFileId, authorUserId); tags are
-- file-scoped (every reader sees every tag).
--
-- Additive only: CREATE TABLE / CREATE [UNIQUE] INDEX IF NOT EXISTS. No
-- backfill, no enums. Re-running on a converged DB is a no-op (idempotent).

CREATE TABLE IF NOT EXISTS "FileComment" (
    "id"           TEXT NOT NULL,
    "ncFileId"     INTEGER NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body"         TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FileComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FileComment_ncFileId_createdAt_idx"
    ON "FileComment" ("ncFileId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "FileComment_authorUserId_idx"
    ON "FileComment" ("authorUserId");

CREATE TABLE IF NOT EXISTS "FileTag" (
    "id"            TEXT NOT NULL,
    "ncFileId"      INTEGER NOT NULL,
    "label"         TEXT NOT NULL,
    "addedByUserId" TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileTag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FileTag_ncFileId_label_key"
    ON "FileTag" ("ncFileId", "label");

CREATE INDEX IF NOT EXISTS "FileTag_ncFileId_idx"
    ON "FileTag" ("ncFileId");

CREATE INDEX IF NOT EXISTS "FileTag_addedByUserId_idx"
    ON "FileTag" ("addedByUserId");

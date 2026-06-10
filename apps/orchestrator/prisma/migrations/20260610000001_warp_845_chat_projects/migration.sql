-- WARP-845: per-user chat projects (sidebar folders + default persona).
--
-- Strictly per-user (product call): each ChatProject row is owned by
-- `userId`; there is no sharing surface and owner/admin get no
-- visibility into other users' projects. A project carries an optional
-- default `systemPrompt` that the dashboard seeds into new chats
-- started inside the project.
--
-- ChatSession.projectId is NULLABLE with ON DELETE SET NULL: deleting a
-- project never deletes its chats — they fall back to the ungrouped
-- date list, which is the obviously-safe default for a destructive
-- folder operation.
--
-- GREENFIELD + idempotent: CREATE TABLE/INDEX IF NOT EXISTS, guarded FK
-- add; re-running on a converged DB is a no-op.

CREATE TABLE IF NOT EXISTS "ChatProject" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "systemPrompt" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatProject_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ChatProject_userId_updatedAt_idx"
    ON "ChatProject" ("userId", "updatedAt" DESC);

ALTER TABLE "ChatSession"
    ADD COLUMN IF NOT EXISTS "projectId" TEXT;

DO $$ BEGIN
    ALTER TABLE "ChatSession"
        ADD CONSTRAINT "ChatSession_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "ChatProject"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Postgres doesn't auto-index FK columns; the per-project session
-- counts and the ON DELETE SET NULL cascade both scan on projectId.
CREATE INDEX IF NOT EXISTS "ChatSession_projectId_idx"
    ON "ChatSession" ("projectId");

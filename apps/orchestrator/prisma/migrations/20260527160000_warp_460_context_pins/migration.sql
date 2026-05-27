-- WARP-460 — Context pins per chat session (Phase B3).
--
-- Idempotent: DO block for the enum + IF NOT EXISTS for the table so a
-- second `prisma migrate deploy` is a no-op (same pattern as WARP-456 /
-- WARP-457 migrations).

DO $$
BEGIN
    CREATE TYPE "ContextPinKind" AS ENUM ('folder', 'file', 'email_thread', 'camera', 'camera_window');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "ContextPin" (
    "id"        TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind"      "ContextPinKind" NOT NULL,
    "ref"       TEXT NOT NULL,
    "meta"      JSONB,
    "addedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextPin_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContextPin_sessionId_addedAt_idx"
    ON "ContextPin"("sessionId", "addedAt");

-- ON DELETE CASCADE so deleting a ChatSession drops its pins. Prisma's
-- @relation onDelete: Cascade emits this clause on `prisma migrate dev`
-- but we write the migration by hand so spell it out explicitly.
DO $$
BEGIN
    ALTER TABLE "ContextPin"
        ADD CONSTRAINT "ContextPin_sessionId_fkey"
        FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

-- WARP-461 — Durable per-workspace memory facts (Phase B4).
--
-- Idempotent: DO block for the enum + IF NOT EXISTS for the table so a
-- second `prisma migrate deploy` is a no-op. Same posture as WARP-456 /
-- WARP-457 / WARP-460.

DO $$
BEGIN
    CREATE TYPE "MemoryFactCategory" AS ENUM ('Tone', 'Workflow', 'Scope', 'Schedule', 'Other');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS "MemoryFact" (
    "id"             TEXT NOT NULL,
    "category"       "MemoryFactCategory" NOT NULL,
    "fact"           TEXT NOT NULL,
    "addedBy"        TEXT NOT NULL,
    "evidenceChatId" TEXT,
    "active"         BOOLEAN NOT NULL DEFAULT true,
    "addedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MemoryFact_category_active_idx"
    ON "MemoryFact"("category", "active");

CREATE INDEX IF NOT EXISTS "MemoryFact_active_addedAt_idx"
    ON "MemoryFact"("active", "addedAt" DESC);

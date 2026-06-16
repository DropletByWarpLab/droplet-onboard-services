-- WARP-845: role-scoped memory facts.
--
-- Memory is for DISTRIBUTING knowledge across the household, scoped by
-- role: each fact carries an explicit `audience` (minimum-role ladder
-- owner > admin > family > guest). Visibility rule: a caller sees the
-- fact when their role rank is at or above the audience rank —
-- audience='guest' reaches everyone, audience='owner' stays owner-only.
--
-- DEFAULT 'family' backfills every existing row at ADD COLUMN time:
-- pre-WARP-845 facts were written by household members for household
-- use, so "all members, no guests" preserves their effective reach
-- (guests previously saw them via the unscoped injection; narrowing to
-- family is the deliberate correction this migration exists to make).
--
-- GREENFIELD + idempotent: guarded enum create + ADD COLUMN IF NOT
-- EXISTS; re-running on a converged DB is a no-op.

DO $$ BEGIN
    CREATE TYPE "MemoryFactAudience" AS ENUM ('owner', 'admin', 'family', 'guest');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "MemoryFact"
    ADD COLUMN IF NOT EXISTS "audience" "MemoryFactAudience" NOT NULL DEFAULT 'family';

CREATE INDEX IF NOT EXISTS "MemoryFact_active_audience_idx"
    ON "MemoryFact" ("active", "audience");

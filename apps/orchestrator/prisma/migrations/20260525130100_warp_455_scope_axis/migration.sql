-- WARP-455: Scope axis (second RBAC axis on top of WARP-171's Role).
--
-- Adds:
--   - `Scope` pgEnum with the six canonical values. pgEnum (not a
--     separate Scope table) because the set is small and fully known up
--     front; requireScope() switches on these values directly. Adding a
--     new scope is a schema migration — that's the desired velocity.
--   - `ScopeBinding` join model (User ↔ Scope, many-to-many) with
--     unique compound `(userId, scope)` so the same scope can't be added
--     twice for the same user.
--
-- Idempotent (same posture as the WARP-171 Role enum migration and the
-- WARP-446 ApDevice migration):
--   - Enum creation wrapped in DO/EXCEPTION.
--   - Table creation uses IF NOT EXISTS.
--   - FK adds DO/EXCEPTION-wrapped.

-- ── Scope enum ──

DO $$ BEGIN
    CREATE TYPE "Scope" AS ENUM (
        'team',
        'exec_only',
        'finance',
        'engineering',
        'ops',
        'private'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── ScopeBinding ──

CREATE TABLE IF NOT EXISTS "ScopeBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "Scope" NOT NULL,
    "grantedBy" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScopeBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ScopeBinding_userId_scope_key"
    ON "ScopeBinding"("userId", "scope");
CREATE INDEX IF NOT EXISTS "ScopeBinding_userId_idx"
    ON "ScopeBinding"("userId");
CREATE INDEX IF NOT EXISTS "ScopeBinding_scope_idx"
    ON "ScopeBinding"("scope");

-- ── Foreign key ──

DO $$ BEGIN
    ALTER TABLE "ScopeBinding"
        ADD CONSTRAINT "ScopeBinding_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

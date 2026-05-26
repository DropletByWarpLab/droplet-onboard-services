-- WARP-455: Guest time-box.
--
-- Adds `GuestExpiry` + `GuestExpiryStatus` enum. The nightly cron
-- (cron-runtime `guest-expiry-sweep`) walks ACTIVE rows where
-- `expiresAt < now()` and flips them to EXPIRED. Per the no-guessing
-- rule (CLAUDE.md) `status` is an explicit enum — never derived from
-- `expiresAt < now()` at read time. WARP-218's BrainMemoryItemStatus is
-- the canonical precedent.
--
-- The `(status, expiresAt)` composite index is exactly the cron
-- sweep's WHERE clause; a single-column `expiresAt` index helps the
-- "expiring soon" dashboard read.
--
-- Idempotent: enum CREATE wrapped in DO/EXCEPTION; table uses IF NOT
-- EXISTS; FK DO/EXCEPTION-wrapped. Re-runs on a converged DB are a
-- no-op.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "GuestExpiryStatus" AS ENUM (
        'ACTIVE',
        'EXPIRED'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──

CREATE TABLE IF NOT EXISTS "GuestExpiry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "GuestExpiryStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestExpiry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GuestExpiry_userId_key" ON "GuestExpiry"("userId");
CREATE INDEX IF NOT EXISTS "GuestExpiry_expiresAt_idx" ON "GuestExpiry"("expiresAt");
CREATE INDEX IF NOT EXISTS "GuestExpiry_status_expiresAt_idx"
    ON "GuestExpiry"("status", "expiresAt");

-- ── Foreign key ──

DO $$ BEGIN
    ALTER TABLE "GuestExpiry"
        ADD CONSTRAINT "GuestExpiry_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

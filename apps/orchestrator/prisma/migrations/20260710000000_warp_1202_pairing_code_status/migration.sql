-- WARP-1202: explicit PairingCode lifecycle status.
--
-- PairingCode state was inferred — a `used` boolean + an `expiresAt`
-- comparison + `claimedBy` nullability — which predates the repo's
-- "no guessing" rule (CLAUDE.md; WARP-218's BrainMemoryItemStatus is the
-- canonical precedent). Replace the boolean with an explicit
-- `PairingCodeStatus` column: active | claimed | expired | revoked.
--
-- Idempotent (same discipline as 20260709000000_warp_1140_file_index_status):
-- the enum CREATE is duplicate_object-guarded, DDL uses IF [NOT] EXISTS, and
-- the backfill is guarded on the legacy `used` column still existing — so a
-- re-run after the column drop is a no-op.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "PairingCodeStatus" AS ENUM ('active', 'claimed', 'expired', 'revoked');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Column ──

ALTER TABLE "PairingCode"
    ADD COLUMN IF NOT EXISTS "status" "PairingCodeStatus" NOT NULL DEFAULT 'active';

-- ── Backfill from the legacy inferred state ──
-- used=true → claimed; unclaimed but past expiresAt → expired; everything
-- else keeps the 'active' column default. Runs exactly once: the guard keys
-- on the legacy `used` column, which is dropped below.

DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'PairingCode' AND column_name = 'used'
    ) THEN
        UPDATE "PairingCode" SET "status" = 'claimed' WHERE "used" = true;
        UPDATE "PairingCode" SET "status" = 'expired'
            WHERE "used" = false AND "expiresAt" < CURRENT_TIMESTAMP;
    END IF;
END $$;

-- ── Drop the legacy boolean — `status` is the single source of truth ──

ALTER TABLE "PairingCode" DROP COLUMN IF EXISTS "used";

-- ── Index for the WARP-1203 purge sweep's selection key ──

CREATE INDEX IF NOT EXISTS "PairingCode_status_createdAt_idx"
    ON "PairingCode"("status", "createdAt");

-- ADR-024 (Phase 1): multi-backend coverage-AP onboarding.
--
-- Adds the `ApOnboardBackend` discriminator enum + the three additive
-- columns (`backend`, `backendRef`, `vendor`) to `ApDevice`. This is a
-- pure schema-additive change with ZERO behavior delta: every row that
-- exists today was discovered via ADR-005's mDNS + uci path, so the
-- `backend` column DEFAULTs to `DROPLET_IMAGE` and backfills every
-- existing row to the only backend that does anything in this phase.
-- EASYMESH / UNIFI handlers are registry stubs until later phases.
--
-- `backend` is an EXPLICIT enum column, never derived from absence —
-- same CLAUDE.md no-guessing discipline as `ApDeviceStatus`. See
-- docs/ADR-024-multibackend-ap-onboarding.md §1.
--
-- GREENFIELD + idempotent: guarded enum create + ADD COLUMN IF NOT
-- EXISTS. Re-running on a converged DB is a no-op (the EXCEPTION on the
-- enum + the IF NOT EXISTS on each column), mirroring the WARP-446
-- ApDevice migration and the WARP-845 audience migration.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "ApOnboardBackend" AS ENUM (
        'DROPLET_IMAGE',
        'EASYMESH',
        'UNIFI'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ── Columns ──
-- `backend` backfills every existing row to DROPLET_IMAGE (the only
-- discovery source that exists today). `backendRef` + `vendor` are
-- nullable and stay null for Droplet-image extenders.

ALTER TABLE "ApDevice"
    ADD COLUMN IF NOT EXISTS "backend"    "ApOnboardBackend" NOT NULL DEFAULT 'DROPLET_IMAGE',
    ADD COLUMN IF NOT EXISTS "backendRef" TEXT,
    ADD COLUMN IF NOT EXISTS "vendor"     TEXT;

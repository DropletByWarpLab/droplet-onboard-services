-- PR #373: onboarding CLAIM step.
--
-- Two additive changes, ordered AFTER #372's 20260531000000 migration (which
-- created the SetupStep enum + ApplianceSetup singleton):
--   1. Extend the SetupStep enum with 'claim' (the new first wizard step).
--   2. Add the ClaimCode model + its explicit ClaimCodeState lifecycle enum.
--
-- DECISION (claim slots FIRST in the wizard, after welcome): the ENUM value is
-- appended at the END of the type here — Postgres orders enum members by their
-- physical declaration order and `ALTER TYPE … ADD VALUE` can only append
-- cheaply (inserting before an existing value requires a full type rewrite).
-- Nothing in the codebase reads the enum's declaration order; the WIZARD ORDER
-- (welcome → claim → account → …) lives in SETUP_STEPS (setup.service.ts) and
-- the dashboard STEPS array. So the enum is treated as an unordered membership
-- set and appending is correct.
--
-- MINTING / ROTATION is OUT OF SCOPE (PyPortal display-service, separate PR).
-- This PR only VERIFIES a code seeded via env/fixture; `expiresAt` is carried
-- so the rotation owner can expire codes later without another migration.
--
-- IDEMPOTENCY (re-running this migration on a converged DB is a no-op, so the
-- row/enum-member count stays stable):
--   - The enum extension is guarded by a pg_enum catalog check inside a DO
--     block — `ALTER TYPE … ADD VALUE` has no `IF NOT EXISTS` that works inside
--     Prisma's migration transaction on every supported PG, and re-adding an
--     existing value errors, so we add it only when absent. Same defensive
--     spirit as #372's `CREATE TYPE … EXCEPTION WHEN duplicate_object` guard.
--   - ClaimCodeState uses the DO/EXCEPTION duplicate_object guard #372 uses.
--   - ClaimCode uses CREATE TABLE IF NOT EXISTS + a guarded unique index.
-- This migration seeds NO rows (claim codes are provisioned out-of-band via
-- env/fixture, not by the schema), so there is no INSERT to make idempotent.

-- ── 1 · Extend SetupStep with 'claim' ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SetupStep' AND e.enumlabel = 'claim'
    ) THEN
        ALTER TYPE "SetupStep" ADD VALUE 'claim';
    END IF;
END $$;

-- ── 2 · ClaimCodeState lifecycle enum ──
--
-- Explicit single-use lifecycle, never derived from `usedAt IS NULL`
-- (CLAUDE.md no-guessing rule; WARP-218 BrainMemoryItemStatus precedent).

DO $$ BEGIN
    CREATE TYPE "ClaimCodeState" AS ENUM (
        'available',
        'consumed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── 3 · ClaimCode table ──
--
-- `codeHash` stores a one-way hash, NEVER plaintext (a DB read can't recover a
-- live code). `state` is the atomic single-use guard — `POST /api/setup/claim`
-- consumes via a conditional `updateMany WHERE state='available'` inside a
-- transaction (WARP-564 pairing-claim pattern), so a code binds the box exactly
-- once even under concurrent claimers. `usedAt` is audit-only, written in the
-- same transaction that flips `state`. `attempts` counts wrong guesses.

CREATE TABLE IF NOT EXISTS "ClaimCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "state" "ClaimCodeState" NOT NULL DEFAULT 'available',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimCode_pkey" PRIMARY KEY ("id")
);

-- A claim code's hash is unique — the same plaintext can't be seeded twice and
-- verification can look the row up by hash. Guarded so re-runs don't error.
DO $$ BEGIN
    CREATE UNIQUE INDEX "ClaimCode_codeHash_key" ON "ClaimCode"("codeHash");
EXCEPTION
    WHEN duplicate_table THEN null;
    WHEN duplicate_object THEN null;
END $$;

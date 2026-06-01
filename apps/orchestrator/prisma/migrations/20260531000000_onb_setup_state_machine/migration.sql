-- PR #372: ApplianceSetup + SetupStep enum for the resumable, explicit
-- first-run setup state machine. See docs/ONBOARDING_STATE_MACHINE.md for
-- the decision record; the schema mirrors the model block in schema.prisma.
--
-- Replaces the stateless, Nextcloud-`installed`-derived `setupRequired`
-- boolean with an explicit server-side row. `state` ("unclaimed" | "ready")
-- and `setupStep` (SetupStep enum) are explicit columns — never derived
-- from absence (CLAUDE.md no-guessing rule; WARP-218 BrainMemoryItemStatus
-- precedent). Persisted on the encrypted NVMe (FEATURES.md §10) alongside
-- the rest of the orchestrator's Postgres state.
--
-- GATE (PR #372): SetupStep lists ONLY the 9 SHIPPED wizard steps. The
-- claim / org / team steps are gated pending a Claude Design round-trip
-- and extend this enum (via a follow-up migration) when they ship — see
-- the enum docstring in schema.prisma.
--
-- Idempotency: the enum CREATE is wrapped in DO/EXCEPTION the same way the
-- WARP-446 ApDeviceStatus, WARP-171 Role, and WARP-218 BrainMemoryItemStatus
-- migrations are. The table uses CREATE TABLE IF NOT EXISTS and the
-- singleton seed uses INSERT ... ON CONFLICT DO NOTHING, so re-running this
-- migration on a converged DB is a no-op and the row count stays stable.

-- ── Enum ──

DO $$ BEGIN
    CREATE TYPE "SetupStep" AS ENUM (
        'welcome',
        'account',
        'internet',
        'storage',
        'discovery',
        'cameras',
        'vpn',
        'ai',
        'done'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- ── Table ──
--
-- Singleton: `id` defaults to the fixed 'singleton' key so every read/write
-- is an upsert against a known primary key (mirrors Workspace's id = 1
-- singleton). A uuid default would mint a fresh row per upsert-create and
-- break the singleton invariant.

-- M6 (PR #372 re-review): `updatedAt` carries a DB-level DEFAULT
-- CURRENT_TIMESTAMP. Prisma's `@updatedAt` only sets the column from the
-- Prisma client on writes — it does NOT emit a column DEFAULT — so a raw
-- INSERT that omits `updatedAt` (e.g. the singleton seed below, or any
-- out-of-band SQL) would violate the NOT NULL constraint and fail the
-- migration. The DEFAULT makes the column safe to omit on INSERT while the
-- application-level `@updatedAt` still bumps it on every Prisma update.

CREATE TABLE IF NOT EXISTS "ApplianceSetup" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "state" TEXT NOT NULL DEFAULT 'unclaimed',
    "setupStep" "SetupStep" NOT NULL DEFAULT 'welcome',
    "userTourCompleted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplianceSetup_pkey" PRIMARY KEY ("id")
);

-- ── Singleton seed ──
--
-- Materialize the one row at the welcome/unclaimed default so first-run is
-- resumable from the very first `GET /api/setup/state` (the service also
-- upserts defensively, but seeding here means a brand-new appliance boots
-- with an explicit row on the encrypted NVMe rather than relying on the
-- first read to create it). ON CONFLICT DO NOTHING keeps re-runs stable.

INSERT INTO "ApplianceSetup" ("id", "state", "setupStep", "userTourCompleted", "updatedAt", "createdAt")
VALUES ('singleton', 'unclaimed', 'welcome', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

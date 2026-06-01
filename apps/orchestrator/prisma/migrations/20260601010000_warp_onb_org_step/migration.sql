-- PR #380 (WARP onb org): onboarding ORG step.
--
-- Two additive changes, ordered AFTER #373's 20260601000000 migration (which
-- added the 'claim' SetupStep value + the ClaimCode model):
--   1. Extend the SetupStep enum with 'org' (the workspace-naming step that
--      slots AFTER account: welcome → claim → account → org → internet → …).
--   2. Extend the EXISTING Workspace singleton (added in 20260528120000) with
--      the org fields: slug (UNIQUE, reserves droplet.local/<slug>), tz,
--      industry, size, logoPath, and an EXPLICIT orgConfigured flag.
--
-- WHY EXTEND Workspace (not a new table): everyone the owner invites joins the
-- ONE workspace (the "company brain"), so there is exactly one workspace row.
-- The singleton from 20260528120000 already carries displayName; the org step
-- just fills in the rest. Two workspace tables would create two sources of
-- truth for "what is this workspace called".
--
-- EXPLICIT STATE: `orgConfigured` is a real BOOLEAN column. Org-completed-ness
-- is read from it, NEVER inferred from `slug IS NULL` (CLAUDE.md no-guessing
-- rule; WARP-218 BrainMemoryItemStatus / #373 ClaimCodeState precedent).
--
-- INDUSTRY / SIZE are LOCAL smart-default hints only (folders, example tools,
-- camera policy) — never sent off the box (FEATURES.md §10). They are plain
-- nullable TEXT here; no outbound coupling.
--
-- IDEMPOTENCY (re-running on a converged DB is a no-op; row + enum-member +
-- column counts stay stable):
--   - The enum extension is guarded by a pg_enum catalog check inside a DO
--     block — `ALTER TYPE … ADD VALUE` has no in-transaction IF NOT EXISTS on
--     every supported PG, and re-adding an existing value errors. Same guard
--     #373 used for 'claim'.
--   - Every column add uses ADD COLUMN IF NOT EXISTS.
--   - The slug unique index uses a guarded CREATE UNIQUE INDEX.
-- This migration seeds NO rows: the Workspace row is materialized lazily by
-- settings-workspace.ts / the org step's upsert, exactly as 20260528120000
-- documented. So there is no INSERT to make idempotent.

-- ── 1 · Extend SetupStep with 'org' ──

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'SetupStep' AND e.enumlabel = 'org'
    ) THEN
        ALTER TYPE "SetupStep" ADD VALUE 'org';
    END IF;
END $$;

-- ── 2 · Org fields on the Workspace singleton ──

ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "tz" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "industry" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "size" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "logoPath" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "orgConfigured" BOOLEAN NOT NULL DEFAULT false;

-- ── 3 · Slug uniqueness ──
--
-- A workspace slug reserves droplet.local/<slug>, so it must be unique. Guarded
-- so a re-run doesn't error. (With a singleton there is at most one non-null
-- slug today, but the constraint encodes the contract and supports lookup.)

DO $$ BEGIN
    CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");
EXCEPTION
    WHEN duplicate_table THEN null;
    WHEN duplicate_object THEN null;
END $$;

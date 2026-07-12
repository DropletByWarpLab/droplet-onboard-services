-- WARP-884 / WARP-885: PM schema hardening (ADR-026 tech-debt, deferred from
-- #680/#681 — pr-reviewer findings ratified as tickets with human sign-off).
--
-- WARP-884 — explicit completion / archival state, no more IS-NULL derivation:
--   * PmWorkItem.isCompleted and PmProject.isArchived / PmWorkItem.isArchived
--     become the canonical "is done" / "is archived" signal. completedAt /
--     archivedAt remain as audit timestamps (pm.service.ts still nulls them
--     on toggle-off, unchanged from the prior behavior). Backfilled from the
--     existing timestamp columns below.
--
-- WARP-885 — DB integrity + audit completeness:
--   * Partial unique index: at most one ACTIVE cycle per project (mirrors the
--     PmState.isDefault partial index already shipped in
--     20260621000000_native_pm_foundation). Dedupe pass first so the index
--     can build even if a project somehow already has >1 active cycle
--     (no write path ships this yet, so this is precautionary).
--   * PmWorkItemPropertyValue.createdAt — was the only PM row missing it.
--   * PmActivityVerb gains parent_removed (emitted by pm.service.ts
--     deleteWorkItem when a deleted parent orphans its sub-issues) and
--     module_added / module_removed (forward-declared for the not-yet-shipped
--     module write path, same precedent as the existing unused
--     cycle_added/cycle_removed).
--   * PmState.isDefault partial unique index and PmState(projectId, name)
--     uniqueness were already shipped in 20260621000000_native_pm_foundation
--     — nothing to do for those two WARP-885 bullets. The cross-project FK
--     guard for PmCycle/PmModuleWorkItem write paths is deferred with them
--     (ticket explicitly notes "no write path exists yet in P2/P3").
--   * PmProject.seqCounter concurrency is already enforced by the existing
--     atomic `UPDATE ... RETURNING` inside createWorkItem's interactive
--     transaction (documented in schema.prisma) — no schema change needed.

-- ── WARP-884: explicit completion / archival columns ───────────────────────
ALTER TABLE "PmProject" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PmWorkItem" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PmWorkItem" ADD COLUMN "isCompleted" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the existing timestamp columns — their presence/absence was
-- already the only signal in production, so it's the correct seed.
UPDATE "PmProject" SET "isArchived" = true WHERE "archivedAt" IS NOT NULL;
UPDATE "PmWorkItem" SET "isArchived" = true WHERE "archivedAt" IS NOT NULL;
UPDATE "PmWorkItem" SET "isCompleted" = true WHERE "completedAt" IS NOT NULL;

-- ── WARP-885: PmActivityVerb — audit completeness ───────────────────────────
-- Idempotent guard (ALTER TYPE ... ADD VALUE has no transaction-safe
-- IF NOT EXISTS on every supported PG and re-adding an existing value
-- errors) — same pattern as 20260624000000_warp_890_email_sending_claim.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'parent_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'parent_removed';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'module_added'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'module_added';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'module_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'module_removed';
    END IF;
END $$;

-- ── WARP-885: PmWorkItemPropertyValue.createdAt ─────────────────────────────
-- Backfilled from updatedAt (best available approximation for pre-existing
-- rows — there is no earlier timestamp to recover it from).
ALTER TABLE "PmWorkItemPropertyValue" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "PmWorkItemPropertyValue" SET "createdAt" = "updatedAt";
ALTER TABLE "PmWorkItemPropertyValue" ALTER COLUMN "createdAt" SET NOT NULL;
ALTER TABLE "PmWorkItemPropertyValue" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- ── WARP-885: at most one ACTIVE cycle per project ──────────────────────────
-- Prisma cannot express a partial (WHERE-filtered) unique index, so — like
-- PmState_projectId_isDefault_key above it — this lives only in raw SQL.
-- Dedupe first: keep the most recently created active cycle per project and
-- revert any older colliding ones to draft so the index can build even on a
-- project that (pre-index) already collected more than one active cycle.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt" DESC) AS rn
  FROM "PmCycle"
  WHERE "status" = 'active'
)
UPDATE "PmCycle"
SET "status" = 'draft'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX "PmCycle_projectId_active_key" ON "PmCycle"("projectId") WHERE "status" = 'active';

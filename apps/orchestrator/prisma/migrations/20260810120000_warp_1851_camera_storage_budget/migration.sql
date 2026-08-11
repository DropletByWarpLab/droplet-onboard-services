-- WARP-1851 — per-camera NVR storage allocation.
--
-- Additive schema migration (idempotent, safe to re-run on a populated db).
-- Introduces:
--   - CameraRetentionMode enum (MANUAL, BUDGET)
--   - Camera.retentionMode   (NOT NULL, default MANUAL)
--   - Camera.storageBudgetBytes (nullable BIGINT)
--
-- Why an explicit enum rather than "budget IS NULL means manual":
-- CLAUDE.md's no-guessing-from-absence rule. The two columns are not
-- redundant — an operator can clear a budget while the column retains its
-- last value, and MANUAL has to win unambiguously in that case. Deriving
-- the mode from the budget's nullness would make "cleared the budget" and
-- "never set one" indistinguishable, and the reconciler would then have to
-- guess whether to keep managing the camera's retention.
--
-- Every existing camera becomes MANUAL: retention stays exactly whatever
-- the operator has already set in Frigate. This migration MUST NOT change
-- any camera's effective retention — WARP-1849 has only just made those
-- windows real, and a migration that silently re-derived them would be the
-- second time this feature deleted footage nobody agreed to lose.
--
-- BIGINT rather than INTEGER: a 4 TB budget is ~4.4e12 bytes, well past
-- INT4's 2.1e9 ceiling.

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CameraRetentionMode') THEN
    CREATE TYPE "CameraRetentionMode" AS ENUM ('MANUAL', 'BUDGET');
  END IF;
END$$;

-- AlterTable
ALTER TABLE "Camera"
  ADD COLUMN IF NOT EXISTS "retentionMode" "CameraRetentionMode" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "storageBudgetBytes" BIGINT,
  -- The operator's preferred retention windows, captured when a budget is
  -- set. The controller scales DOWN from this ceiling and grows back toward
  -- it; a window stored as 0 is never raised, so enforcing a budget can
  -- never switch on a recording mode the operator has off.
  ADD COLUMN IF NOT EXISTS "retentionCeiling" JSONB;

-- Partial index: the reconciler only ever scans BUDGET-mode rows, and on a
-- household appliance that is a small minority of an already-small table.
CREATE INDEX IF NOT EXISTS "Camera_retentionMode_budget_idx"
  ON "Camera" ("retentionMode")
  WHERE "retentionMode" = 'BUDGET';

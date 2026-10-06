-- WARP-3520 (ADR-069 slice WS-4) — an item's KIND, its estimate, and the
-- activity verbs that describe them.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmWorkItemType + PmWorkItem.type. An explicit enum column rather than a
--      "bug" label: a label cannot be defaulted, counted or filtered by the
--      engine, and CLAUDE.md's "No guessing" rule is the same one that gave
--      PmState its `group`. `DEFAULT 'task'` means every existing row keeps a
--      meaning without a backfill, so this is additive and re-runnable on a box
--      that already holds work.
--
--   2. PmWorkItem.estimate — story points, DOUBLE PRECISION, NULL = "not
--      estimated" (which is not 0). Added with ADD COLUMN IF NOT EXISTS because
--      WARP-3521 declares the same nullable, default-less column idempotently
--      (this slice owns the field and its API; that one reads it), so the two
--      can land in either order. The CHECK keeps it in 0..1000 whoever
--      writes it: the route validates the same bounds, but a fix-up script or a
--      future importer does not go through the route. NaN is refused too —
--      Postgres orders NaN above every number, so `<= 1000` rejects it.
--
--   3. PmActivityVerb gains start_date_changed / type_changed /
--      estimate_changed / property_changed. Every PM write path writes one
--      activity row per meaningful change; these four fields used to be
--      unrecordable (startDate fell into the generic `updated`/`fields` row,
--      the others did not exist).
--      NOTE: the values are added here but NOT referenced by any statement in
--      this file. Postgres refuses to USE an enum value added by ALTER TYPE in
--      the transaction that added it, and Prisma applies a migration file
--      inside one transaction (the same constraint
--      20260904140100_warp_2586_pm_work_item_relation documents). Nothing below
--      needs them, so no separate enum-only migration is required.

-- ── PmWorkItemType ──────────────────────────────────────────────────────────
CREATE TYPE "PmWorkItemType" AS ENUM ('task', 'bug', 'feature', 'improvement', 'question', 'incident');

-- ── PmWorkItem.type / .estimate ─────────────────────────────────────────────
ALTER TABLE "PmWorkItem" ADD COLUMN "type" "PmWorkItemType" NOT NULL DEFAULT 'task';

-- IF NOT EXISTS on purpose: WARP-3521 (cycles / modules) reads the estimate and
-- declares the very same column the very same way, so whichever of the two
-- migrations runs first creates it and the other is a no-op.
ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "estimate" DOUBLE PRECISION;

ALTER TABLE "PmWorkItem"
  ADD CONSTRAINT "PmWorkItem_estimate_range"
  CHECK ("estimate" IS NULL OR ("estimate" >= 0 AND "estimate" <= 1000));

-- ── PmActivityVerb ──────────────────────────────────────────────────────────
ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS 'start_date_changed';
ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS 'type_changed';
ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS 'estimate_changed';
ALTER TYPE "PmActivityVerb" ADD VALUE IF NOT EXISTS 'property_changed';

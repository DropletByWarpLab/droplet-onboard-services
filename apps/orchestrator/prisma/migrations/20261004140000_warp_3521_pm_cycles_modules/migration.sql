-- WARP-3521 (ADR-069 slice WS-5) — cycles (sprints) and modules (milestones).
--
-- ADR-026 laid PmCycle / PmModule / PmModuleWorkItem / PmWorkItem.cycleId down
-- with no writer. This slice gives them one (pm-cycles.service.ts,
-- pm-modules.service.ts), and this migration is the part of it the database has
-- to hold itself — every statement here backs a guarantee the services rely on
-- and `pm-cycles-modules.pg.test.ts` proves against a real Postgres.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmCycle.completedAt / PmCycle.carriedOverCount — written once, in the
--      completion transaction. `completedAt` is where a completed cycle's
--      burndown stops; `carriedOverCount` is how many unfinished items were
--      moved out, so a completed cycle can still say how much of its scope it
--      finished (everything left attached to it is done by construction, which
--      would otherwise make every completed cycle read 100%). Explicit columns,
--      not derived from absent rows (CLAUDE.md "No guessing").
--
--   2. PmWorkItem.estimate — ADD COLUMN IF NOT EXISTS. WARP-3520 (WS-4) owns
--      the field and its API; progress and the burndown here read it. Both
--      slices declare it idempotently so they can land in either order.
--
--   3. At most ONE active cycle per project — the partial unique index
--      `PmCycle_projectId_active_key`. It has existed since
--      20260711000000_warp_884_885_pm_schema_hardening (WARP-885, "DB-level
--      hardening ahead of" a cycle write path). It is re-asserted here, with
--      the same dedupe pass in front of it, because this is the migration that
--      makes the invariant load-bearing: startCycle relies on its P2002 to turn
--      two racing starts into one winner and a `cycle_already_active`. Idempotent;
--      a no-op wherever the index is already there, which is everywhere.
--
--   4. Two CHECKs: PmCycle_dates_ordered and PmModule_dates_ordered. An end
--      before its start is not a plan; the services refuse it with
--      `invalid_dates`, and the constraint is for every writer that is not the
--      service (an importer, a fix-up script). Both are preceded by a repair
--      pass that is expected to touch ZERO rows — no shipped code path could
--      write a cycle or a module before this slice.
--
--   5. Two same-project TRIGGERS, because "my cycle belongs to my project" is a
--      fact about ANOTHER ROW and a CHECK may not contain a subquery (the
--      WARP-2586 / pmworkitem_parent_same_project reasoning, and a trigger is
--      invisible to `prisma migrate diff`, so it costs no drift):
--        * pmworkitem_cycle_same_project   — PmWorkItem.cycleId
--        * pmmoduleworkitem_same_project   — PmModuleWorkItem
--      A cross-project membership would corrupt every progress figure and the
--      burndown quietly: the item would count toward a cycle whose board it can
--      never appear on. The services refuse it first (`invalid_cycle`,
--      `invalid_work_item`); this is the backstop for everything else.
--      Each is preceded by a repair pass (expected to touch zero rows) that
--      audits every repaired row with the `cycle_removed` / `module_removed`
--      verbs — those exist since the ADR-026 foundation and the schema
--      hardening migration, both long committed, so using them here is legal in
--      the same transaction (the WARP-2586 note about same-transaction enum
--      values does not apply).
--
-- NOTHING here is data-seeding, and every statement is idempotent: the file can
-- be applied twice to the same database and the second pass changes nothing.

-- ── 1 + 2. Columns ──────────────────────────────────────────────────────────
ALTER TABLE "PmCycle" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "PmCycle" ADD COLUMN IF NOT EXISTS "carriedOverCount" INTEGER NOT NULL DEFAULT 0;

-- WARP-3520 owns this column; see header item 2.
ALTER TABLE "PmWorkItem" ADD COLUMN IF NOT EXISTS "estimate" DOUBLE PRECISION;

-- ── 3. At most one ACTIVE cycle per project ─────────────────────────────────
-- Same dedupe-then-index shape as the WARP-885 migration, so the statement is
-- safe on any database state: keep the most recently created active cycle per
-- project and revert older colliding ones to draft. Expected to touch nothing.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt" DESC) AS rn
  FROM "PmCycle"
  WHERE "status" = 'active'
)
UPDATE "PmCycle"
SET "status" = 'draft'
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "PmCycle_projectId_active_key"
  ON "PmCycle"("projectId") WHERE "status" = 'active';

-- ── 4. Date ordering ────────────────────────────────────────────────────────
UPDATE "PmCycle"
SET "endDate" = "startDate"
WHERE "startDate" IS NOT NULL AND "endDate" IS NOT NULL AND "endDate" < "startDate";

UPDATE "PmModule"
SET "targetDate" = "startDate"
WHERE "startDate" IS NOT NULL AND "targetDate" IS NOT NULL AND "targetDate" < "startDate";

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmCycle_dates_ordered') THEN
        ALTER TABLE "PmCycle"
          ADD CONSTRAINT "PmCycle_dates_ordered"
          CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PmModule_dates_ordered') THEN
        ALTER TABLE "PmModule"
          ADD CONSTRAINT "PmModule_dates_ordered"
          CHECK ("startDate" IS NULL OR "targetDate" IS NULL OR "targetDate" >= "startDate");
    END IF;
END $$;

-- ── 5a. An item's cycle belongs to the item's project ───────────────────────
-- Repair first. Audited before it is applied: one cycle_removed row per
-- repaired item, actorId NULL (a migration is not a person). PmActivity.id has
-- no database default — Prisma's @default(uuid()) is client-side — so the id is
-- generated here, exactly as the WARP-2586 migration does.
INSERT INTO "PmActivity" ("id", "workItemId", "actorId", "verb", "field", "oldValue", "newValue", "createdAt")
SELECT
    gen_random_uuid()::text,
    w."id",
    NULL,
    'cycle_removed'::"PmActivityVerb",
    'cycle',
    w."cycleId",
    NULL,
    now()
FROM "PmWorkItem" w
JOIN "PmCycle" c ON c."id" = w."cycleId"
WHERE c."projectId" <> w."projectId";

UPDATE "PmWorkItem" w
SET "cycleId" = NULL
FROM "PmCycle" c
WHERE c."id" = w."cycleId"
  AND c."projectId" <> w."projectId";

-- Fires on INSERT and on any UPDATE that names cycleId or projectId in its SET
-- clause — which covers both directions the invariant can be broken from:
-- pointing an item at another project's cycle, and moving an item to another
-- project while it stays in this one's cycle (no write path today, guarded now
-- for the same reason WARP-2586 guarded it for parentId).
--
-- The DB-level `cycleId ON DELETE SET NULL` writes NULL, which passes.
-- A cycle id that does not exist is NOT this trigger's business: it reads NULL
-- here and the foreign key refuses it a moment later.
CREATE OR REPLACE FUNCTION pmworkitem_enforce_cycle_same_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cycle_project TEXT;
BEGIN
  IF NEW."cycleId" IS NOT NULL THEN
    SELECT c."projectId" INTO cycle_project
    FROM "PmCycle" c
    WHERE c."id" = NEW."cycleId";

    IF cycle_project IS NOT NULL AND cycle_project <> NEW."projectId" THEN
      RAISE EXCEPTION
        'PmWorkItem.cycleId must name a cycle in the item''s own project (WARP-3521): item % is in project %, cycle % is in project %.',
        NEW."id", NEW."projectId", NEW."cycleId", cycle_project
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmworkitem_enforce_cycle_same_project() IS
  'WARP-3521: BEFORE INSERT OR UPDATE OF (cycleId, projectId) guard keeping a work item inside a cycle of its own project. A CHECK constraint cannot express this — it may not contain a subquery.';

DROP TRIGGER IF EXISTS pmworkitem_cycle_same_project ON "PmWorkItem";
CREATE TRIGGER pmworkitem_cycle_same_project
  BEFORE INSERT OR UPDATE OF "cycleId", "projectId" ON "PmWorkItem"
  FOR EACH ROW
  EXECUTE FUNCTION pmworkitem_enforce_cycle_same_project();

-- ── 5b. A module's items belong to the module's project ─────────────────────
INSERT INTO "PmActivity" ("id", "workItemId", "actorId", "verb", "field", "oldValue", "newValue", "createdAt")
SELECT
    gen_random_uuid()::text,
    mw."workItemId",
    NULL,
    'module_removed'::"PmActivityVerb",
    'module',
    mw."moduleId",
    NULL,
    now()
FROM "PmModuleWorkItem" mw
JOIN "PmModule" m ON m."id" = mw."moduleId"
JOIN "PmWorkItem" w ON w."id" = mw."workItemId"
WHERE m."projectId" <> w."projectId";

DELETE FROM "PmModuleWorkItem" mw
USING "PmModule" m, "PmWorkItem" w
WHERE m."id" = mw."moduleId"
  AND w."id" = mw."workItemId"
  AND m."projectId" <> w."projectId";

CREATE OR REPLACE FUNCTION pmmoduleworkitem_enforce_same_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  module_project TEXT;
  item_project   TEXT;
BEGIN
  SELECT m."projectId" INTO module_project FROM "PmModule" m WHERE m."id" = NEW."moduleId";
  SELECT w."projectId" INTO item_project   FROM "PmWorkItem" w WHERE w."id" = NEW."workItemId";

  -- A NULL on either side is a row that does not exist; the foreign keys own
  -- that refusal.
  IF module_project IS NOT NULL AND item_project IS NOT NULL AND module_project <> item_project THEN
    RAISE EXCEPTION
      'PmModuleWorkItem must join a module and a work item of the same project (WARP-3521): module % is in project %, work item % is in project %.',
      NEW."moduleId", module_project, NEW."workItemId", item_project
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmmoduleworkitem_enforce_same_project() IS
  'WARP-3521: BEFORE INSERT OR UPDATE OF (moduleId, workItemId) guard keeping a module''s items inside the module''s own project. A CHECK constraint cannot express this — it may not contain a subquery.';

DROP TRIGGER IF EXISTS pmmoduleworkitem_same_project ON "PmModuleWorkItem";
CREATE TRIGGER pmmoduleworkitem_same_project
  BEFORE INSERT OR UPDATE OF "moduleId", "workItemId" ON "PmModuleWorkItem"
  FOR EACH ROW
  EXECUTE FUNCTION pmmoduleworkitem_enforce_same_project();

-- WARP-2586 (ADR-045 slice G) — PmWorkItemRelation, and the DB-level backstop
-- for same-project PARENTING.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmRelationKind + PmWorkItemRelation: the first PM edge that may SPAN
--      projects. PmModule and PmCycle are both projectId-scoped, and
--      PmWorkItem.parentId is containment (see 4), so before this table there
--      was no way to say "INBOX-42 blocks OPS-7" at all.
--
--   2. Two CHECKs Prisma's schema language cannot express:
--        * PmWorkItemRelation_no_self_edge — an item cannot block/relate to
--          itself. Cheap, and it removes the degenerate 1-cycle from the
--          BLOCKS cycle detector's problem entirely.
--        * PmWorkItemRelation_symmetric_canonical_order — RELATES and
--          DUPLICATES are SYMMETRIC facts. Storing them twice (A->B and B->A)
--          is how the edge becomes un-deletable: the UI deletes the row it
--          read, the mirror survives, and the relation reappears on refresh.
--          One row, canonically ordered, read from both ends.
--
--      The COLLATE "C" on that second CHECK is load-bearing, not decoration.
--      The service canonicalises with JavaScript `<`, which is UTF-16
--      code-unit order. Plain Postgres text `<` uses the database collation,
--      and an ICU/en_US collation orders punctuation differently — so
--      'a-b' < 'ab' can disagree between the two, and the service would write
--      an ordering the constraint then rejects. UUIDs are pure ASCII, where
--      byte order and UTF-16 code-unit order are identical, so pinning the
--      comparison to the C collation makes the two layers agree by
--      construction regardless of how the cluster was initdb'd.
--
--   3. PmActivityVerb gains relation_added / relation_removed. Every PM write
--      path writes exactly one activity row per meaningful change; a relation
--      is written on BOTH ends, so each item's own timeline explains it.
--      NOTE: these values are added here but are NOT referenced by any
--      statement in this file. Postgres refuses to USE an enum value added by
--      ALTER TYPE in the same transaction the ALTER ran in, and Prisma applies
--      a migration file inside one transaction. The repair pass below
--      therefore uses 'parent_removed', which was committed by
--      20260711000000_warp_884_885_pm_schema_hardening.
--
--   4. THE PARENTID DECISION (ADR-045 slice G, item 2), made explicitly:
--      parent and child MUST share a project. Containment is per-project;
--      REFERENCE across projects is what PmWorkItemRelation is now for.
--
--      This is a backstop, not a behaviour change. pm.service.ts has rejected
--      a cross-project parent with invalid_parent on BOTH write paths since
--      the first commit that shipped a PM write path (ADR-026 P2, #681) —
--      createWorkItem and updateWorkItem each compare parent.projectId, and
--      routes/pm/native.test.ts pins both as 422. The dashboard has made the
--      same assumption from the other side since ADR-026 P4: useSubIssues
--      fetches children as /api/pm/projects/:id/work-items?parent=..., a
--      PROJECT-scoped list, so an off-project child would silently never
--      render under its parent. The database was the only layer with no
--      opinion.
--
--      A CHECK CONSTRAINT CANNOT DO THIS. Postgres CHECK expressions may not
--      contain subqueries, so "my parent's projectId equals mine" — a fact
--      about ANOTHER ROW — is not expressible as one. This is the same
--      reasoning WARP-113 wrote down when a review asked for a CHECK on
--      ScheduleEvent and got a trigger. A composite FK
--      (parentId, projectId) -> (id, projectId) would also work on pg16, but
--      it replaces the Prisma-modelled FK and would open a NEW entry in
--      prisma/schema-drift-baseline.sql of exactly the Department_parentId_fkey
--      shape. A trigger is invisible to `prisma migrate diff`, so it costs no
--      drift.
--
--      The repair pass runs first and is expected to touch ZERO rows (see
--      above: no shipped code path could write a violation). It exists because
--      #680 shipped the schema one commit BEFORE #681 shipped the guard, and
--      because a trigger does not validate rows that already exist — an
--      unrepaired violator would sit there forever, rejected only the next
--      time somebody touched it. Every repaired row gets a parent_removed
--      activity entry, mirroring what deleteWorkItem already does when a
--      deletion orphans sub-issues: the promotion is never silent.

-- ── PmRelationKind ──────────────────────────────────────────────────────────
-- UPPERCASE, matching CrmStageKind / CrmActivityKind rather than the
-- lowercase Pm* enums (PmStateGroup, PmPriority). Deliberate: these three
-- values are quoted verbatim inside a CHECK constraint and in the service's
-- symmetric-kind set, and SCREAMING_CASE reads unambiguously as a wire enum in
-- both places. Flagged here so the divergence is a decision, not a slip.
CREATE TYPE "PmRelationKind" AS ENUM ('BLOCKS', 'RELATES', 'DUPLICATES');

-- ── PmActivityVerb: relation_added / relation_removed ───────────────────────
-- Idempotent guard — ALTER TYPE ... ADD VALUE has no transaction-safe
-- IF NOT EXISTS on every supported PG and re-adding an existing value errors.
-- Same pattern as 20260711000000_warp_884_885_pm_schema_hardening.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'relation_added'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'relation_added';
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' AND e.enumlabel = 'relation_removed'
    ) THEN
        ALTER TYPE "PmActivityVerb" ADD VALUE 'relation_removed';
    END IF;
END $$;

-- ── PmWorkItemRelation ──────────────────────────────────────────────────────
CREATE TABLE "PmWorkItemRelation" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" "PmRelationKind" NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWorkItemRelation_pkey" PRIMARY KEY ("id")
);

-- One row per (from, to, kind). Combined with the canonical-order CHECK below
-- this is what makes a symmetric relation storable exactly once.
CREATE UNIQUE INDEX "PmWorkItemRelation_fromId_toId_kind_key" ON "PmWorkItemRelation"("fromId", "toId", "kind");

-- BOTH directions are indexed, and both carry `kind` as the second column.
-- The forward index is what the bounded BLOCKS cycle walk hits once per level
-- (`WHERE kind = 'BLOCKS' AND fromId IN (...)`); the reverse index is what the
-- work-item read hits for the incoming half. Postgres does not auto-index a
-- foreign key column, and an unindexed FK is the WARP-845 hazard — crm.service
-- shipped five of them.
CREATE INDEX "PmWorkItemRelation_fromId_kind_idx" ON "PmWorkItemRelation"("fromId", "kind");
CREATE INDEX "PmWorkItemRelation_toId_kind_idx" ON "PmWorkItemRelation"("toId", "kind");

-- Cascade on BOTH ends, not SetNull: an edge with one end missing is not a
-- weaker edge, it is not an edge. (Same reasoning as CrmActivity's subject
-- columns, where the exactly-one CHECK forbids an orphan and Cascade is the
-- only coherent delete action.) deleteWorkItem writes a relation_removed
-- activity row on the SURVIVING end before the delete, so the cascade is
-- always preceded by an explainable entry — the discipline WARP-885
-- established for parentId's SET NULL.
ALTER TABLE "PmWorkItemRelation" ADD CONSTRAINT "PmWorkItemRelation_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmWorkItemRelation" ADD CONSTRAINT "PmWorkItemRelation_toId_fkey" FOREIGN KEY ("toId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2586: no self-edge. "A blocks A" is not a fact about scheduling, it is
-- a typo, and it is also the degenerate cycle the walk below would otherwise
-- have to special-case.
ALTER TABLE "PmWorkItemRelation"
  ADD CONSTRAINT "PmWorkItemRelation_no_self_edge"
  CHECK ("fromId" <> "toId");

-- WARP-2586: RELATES and DUPLICATES are symmetric, so they are stored ONCE,
-- with the lexicographically smaller id in "fromId". BLOCKS is directional and
-- is exempt — A blocks B and B blocks A are different claims (and together a
-- cycle, which the service refuses on write).
--
-- COLLATE "C" pins this to byte order so it agrees with the service's
-- JavaScript `<` on every cluster, whatever the database collation is. See the
-- header for why that is not paranoia.
ALTER TABLE "PmWorkItemRelation"
  ADD CONSTRAINT "PmWorkItemRelation_symmetric_canonical_order"
  CHECK ("kind" = 'BLOCKS' OR "fromId" COLLATE "C" < "toId" COLLATE "C");

-- ── Same-project parenting: repair, then enforce ────────────────────────────

-- Repair pass. Expected to affect ZERO rows on every box (see header). Audited
-- before it is applied: one parent_removed row per repaired child, actorId
-- NULL (a migration is not a person). PmActivity.id has no database default —
-- Prisma's @default(uuid()) is client-side — so the id is generated here.
INSERT INTO "PmActivity" ("id", "workItemId", "actorId", "verb", "field", "oldValue", "newValue", "createdAt")
SELECT
    gen_random_uuid()::text,
    c."id",
    NULL,
    'parent_removed'::"PmActivityVerb",
    'parentId',
    c."parentId",
    NULL,
    now()
FROM "PmWorkItem" c
JOIN "PmWorkItem" p ON p."id" = c."parentId"
WHERE c."projectId" <> p."projectId";

UPDATE "PmWorkItem" c
SET "parentId" = NULL
FROM "PmWorkItem" p
WHERE p."id" = c."parentId"
  AND c."projectId" <> p."projectId";

-- The guard itself. Fires on INSERT, and on any UPDATE that names parentId or
-- projectId in its SET clause — which covers both directions the invariant can
-- be broken from:
--   * re-parenting a child onto a parent in another project, and
--   * moving an item to another project while it still has children here.
-- The second has no write path today (nothing updates PmWorkItem.projectId),
-- which is precisely why it is worth guarding now rather than discovering the
-- gap when a "move to project" feature lands.
--
-- The DB-level `parentId ON DELETE SET NULL` writes NULL, which passes.
CREATE OR REPLACE FUNCTION pmworkitem_enforce_parent_same_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_project TEXT;
  stray_child    TEXT;
BEGIN
  IF NEW."parentId" IS NOT NULL THEN
    SELECT p."projectId" INTO parent_project
    FROM "PmWorkItem" p
    WHERE p."id" = NEW."parentId";

    IF parent_project IS NOT NULL AND parent_project <> NEW."projectId" THEN
      RAISE EXCEPTION
        'PmWorkItem.parentId must stay inside the child''s own project (WARP-2586): item % is in project %, parent % is in project %. Use PmWorkItemRelation for a cross-project reference.',
        NEW."id", NEW."projectId", NEW."parentId", parent_project
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
    SELECT c."id" INTO stray_child
    FROM "PmWorkItem" c
    WHERE c."parentId" = NEW."id" AND c."projectId" <> NEW."projectId"
    LIMIT 1;

    IF stray_child IS NOT NULL THEN
      RAISE EXCEPTION
        'PmWorkItem % cannot move to project % while sub-issue % remains in another project (WARP-2586): move or detach the sub-issues first.',
        NEW."id", NEW."projectId", stray_child
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmworkitem_enforce_parent_same_project() IS
  'WARP-2586: BEFORE INSERT OR UPDATE OF (parentId, projectId) guard keeping sub-issue containment inside one project. A CHECK constraint cannot express this — it may not contain a subquery. Cross-project REFERENCE is PmWorkItemRelation.';

DROP TRIGGER IF EXISTS pmworkitem_parent_same_project ON "PmWorkItem";
CREATE TRIGGER pmworkitem_parent_same_project
  BEFORE INSERT OR UPDATE OF "parentId", "projectId" ON "PmWorkItem"
  FOR EACH ROW
  EXECUTE FUNCTION pmworkitem_enforce_parent_same_project();

-- WARP-3530 (ADR-069 §5-§6, WS-14) — SLAs, business calendars, macros and
-- assignment rules for the service desk.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmTicket gains the clock: firstResponseDueAt / nextResponseDueAt /
--      resolutionDueAt (materialised by services/support/sla-engine.ts),
--      slaPausedMs (business-time milliseconds the clock has not run),
--      slaPausedAt (when it last stopped) and slaTargets (the terms the due
--      times were computed from). An index serves the ticker's scan.
--   2. PmBusinessCalendar — zone, weekly windows, holidays. Workspace-level.
--   3. PmSlaPolicy — targets per priority, the at-risk threshold and the
--      escalation actions, one per desk, against an optional calendar.
--   4. PmMacro — canned replies with variables and optional field changes.
--   5. PmAssignmentRule — MANUAL / ROUND_ROBIN / LEAST_OPEN, one per desk.
--   6. The invariants Prisma's schema language cannot express (below), each
--      proven against a real Postgres in pm-sla.pg.test.ts.
--
-- PmActivityVerb's three new values (sla_at_risk, sla_breached, macro_applied)
-- are NOT added here: Postgres refuses to use an enum value added by ALTER TYPE
-- in the same transaction, and Prisma applies a migration file inside one. They
-- are added by the preceding migration, 20261004135900_warp_3530_pm_activity_sla_verbs.
--
-- Additive only: no existing row is touched and no existing column changes
-- meaning. Every existing ticket keeps slaStatus NONE and no terms; a box that
-- never defines a policy is unaffected.

-- ── Enums ───────────────────────────────────────────────────────────────────
-- UPPERCASE like PmRelationKind and the WS-12 enums: wire values the service quotes verbatim.

CREATE TYPE "PmMacroVisibility" AS ENUM ('PERSONAL', 'SHARED');
CREATE TYPE "PmAssignmentMode" AS ENUM ('MANUAL', 'ROUND_ROBIN', 'LEAST_OPEN');

-- ── PmTicket: the clock ─────────────────────────────────────────────────────

ALTER TABLE "PmTicket"
  ADD COLUMN "firstResponseDueAt" TIMESTAMP(3),
  ADD COLUMN "nextResponseDueAt" TIMESTAMP(3),
  ADD COLUMN "resolutionDueAt" TIMESTAMP(3),
  ADD COLUMN "slaPausedAt" TIMESTAMP(3),
  ADD COLUMN "slaPausedMs" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "slaTargets" JSONB;

CREATE INDEX "PmTicket_slaStatus_idx" ON "PmTicket"("slaStatus");

-- ── PmBusinessCalendar ──────────────────────────────────────────────────────

CREATE TABLE "PmBusinessCalendar" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "windows" JSONB NOT NULL,
    "holidays" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmBusinessCalendar_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PmBusinessCalendar_workspaceId_name_key" ON "PmBusinessCalendar"("workspaceId", "name");

ALTER TABLE "PmBusinessCalendar" ADD CONSTRAINT "PmBusinessCalendar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "PmWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PmSlaPolicy ─────────────────────────────────────────────────────────────

CREATE TABLE "PmSlaPolicy" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "calendarId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "targets" JSONB NOT NULL,
    "atRiskPercent" INTEGER NOT NULL DEFAULT 75,
    "escalation" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmSlaPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PmSlaPolicy_projectId_key" ON "PmSlaPolicy"("projectId");
-- WARP-845: an unindexed foreign key makes the parent delete a scan.
CREATE INDEX "PmSlaPolicy_calendarId_idx" ON "PmSlaPolicy"("calendarId");

ALTER TABLE "PmSlaPolicy" ADD CONSTRAINT "PmSlaPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, not SetNull: deleting the calendar a desk's SLA runs on must be
-- refused, not quietly turn that SLA into a 24/7 one.
ALTER TABLE "PmSlaPolicy" ADD CONSTRAINT "PmSlaPolicy_calendarId_fkey" FOREIGN KEY ("calendarId") REFERENCES "PmBusinessCalendar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── PmMacro ─────────────────────────────────────────────────────────────────

CREATE TABLE "PmMacro" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "actions" JSONB NOT NULL DEFAULT '{}',
    "visibility" "PmMacroVisibility" NOT NULL DEFAULT 'PERSONAL',
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmMacro_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PmMacro_projectId_idx" ON "PmMacro"("projectId");
CREATE INDEX "PmMacro_ownerId_idx" ON "PmMacro"("ownerId");

-- A macro is a desk's own: it goes with the desk. (ownerId is a plain User.id like
-- every PM reference to a person — no foreign key.)
ALTER TABLE "PmMacro" ADD CONSTRAINT "PmMacro_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PmAssignmentRule ────────────────────────────────────────────────────────

CREATE TABLE "PmAssignmentRule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" "PmAssignmentMode" NOT NULL DEFAULT 'MANUAL',
    "departmentId" TEXT,
    "memberIds" JSONB NOT NULL DEFAULT '[]',
    "lastAssignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmAssignmentRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PmAssignmentRule_projectId_key" ON "PmAssignmentRule"("projectId");
CREATE INDEX "PmAssignmentRule_departmentId_idx" ON "PmAssignmentRule"("departmentId");

ALTER TABLE "PmAssignmentRule" ADD CONSTRAINT "PmAssignmentRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull: a department is archived, never row-deleted, but the FK must not block it.
ALTER TABLE "PmAssignmentRule" ADD CONSTRAINT "PmAssignmentRule_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- A ticket's SLA terms and its status say the same thing: terms exist exactly
-- when a policy applies, and 'NONE' is the status of a ticket with none. (The
-- service writes both in one UPDATE; this holds it for the next writer.)
ALTER TABLE "PmTicket"
  ADD CONSTRAINT "PmTicket_sla_terms_match_status"
  CHECK (("slaStatus" = 'NONE') = ("slaTargets" IS NULL));

-- No terms, no deadlines: a due time without the promise it was computed from
-- could never be judged.
ALTER TABLE "PmTicket"
  ADD CONSTRAINT "PmTicket_due_needs_terms"
  CHECK (
    "slaTargets" IS NOT NULL
    OR ("firstResponseDueAt" IS NULL AND "nextResponseDueAt" IS NULL AND "resolutionDueAt" IS NULL)
  );

-- Paused time only accumulates.
ALTER TABLE "PmTicket"
  ADD CONSTRAINT "PmTicket_slaPausedMs_nonnegative"
  CHECK ("slaPausedMs" >= 0);

-- The shape of each Json column's top level. zod validates the contents at every
-- write; this keeps another writer from storing a string where the engine reads
-- an object.
ALTER TABLE "PmTicket"
  ADD CONSTRAINT "PmTicket_slaTargets_is_object"
  CHECK ("slaTargets" IS NULL OR jsonb_typeof("slaTargets") = 'object');

ALTER TABLE "PmBusinessCalendar"
  ADD CONSTRAINT "PmBusinessCalendar_windows_is_array" CHECK (jsonb_typeof("windows") = 'array'),
  ADD CONSTRAINT "PmBusinessCalendar_holidays_is_array" CHECK (jsonb_typeof("holidays") = 'array');

ALTER TABLE "PmSlaPolicy"
  ADD CONSTRAINT "PmSlaPolicy_targets_is_object" CHECK (jsonb_typeof("targets") = 'object'),
  ADD CONSTRAINT "PmSlaPolicy_escalation_is_array" CHECK (jsonb_typeof("escalation") = 'array'),
  ADD CONSTRAINT "PmSlaPolicy_atRiskPercent_range" CHECK ("atRiskPercent" BETWEEN 1 AND 99);

ALTER TABLE "PmMacro"
  ADD CONSTRAINT "PmMacro_actions_is_object" CHECK (jsonb_typeof("actions") = 'object');

ALTER TABLE "PmAssignmentRule"
  ADD CONSTRAINT "PmAssignmentRule_memberIds_is_array" CHECK (jsonb_typeof("memberIds") = 'array');

-- An SLA policy, an assignment rule and a macro belong to a SERVICE DESK. A CHECK
-- cannot say it (it may not contain a subquery) and the service is not the only
-- writer a future importer or fix-up script will bring — the reasoning behind
-- pmticket_enforce_service_desk in 20261004120000_warp_3528_service_desk_core. One
-- function, three triggers; a NULL projectId (a macro for every desk) is exempt.
CREATE OR REPLACE FUNCTION pm_enforce_service_desk_project()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."projectId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "PmProject" p WHERE p."id" = NEW."projectId" AND p."kind" = 'SERVICE_DESK'
  ) THEN
    RAISE EXCEPTION
      '% % must belong to a SERVICE_DESK project (WARP-3530): project % is not one.',
      TG_TABLE_NAME, NEW."id", NEW."projectId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pm_enforce_service_desk_project() IS
  'WARP-3530: BEFORE INSERT OR UPDATE OF (projectId) guard — an SLA policy, assignment rule or macro only ever hangs off a SERVICE_DESK project.';

DROP TRIGGER IF EXISTS pmslapolicy_project_is_desk ON "PmSlaPolicy";
CREATE TRIGGER pmslapolicy_project_is_desk
  BEFORE INSERT OR UPDATE OF "projectId" ON "PmSlaPolicy"
  FOR EACH ROW
  EXECUTE FUNCTION pm_enforce_service_desk_project();

DROP TRIGGER IF EXISTS pmassignmentrule_project_is_desk ON "PmAssignmentRule";
CREATE TRIGGER pmassignmentrule_project_is_desk
  BEFORE INSERT OR UPDATE OF "projectId" ON "PmAssignmentRule"
  FOR EACH ROW
  EXECUTE FUNCTION pm_enforce_service_desk_project();

DROP TRIGGER IF EXISTS pmmacro_project_is_desk ON "PmMacro";
CREATE TRIGGER pmmacro_project_is_desk
  BEFORE INSERT OR UPDATE OF "projectId" ON "PmMacro"
  FOR EACH ROW
  EXECUTE FUNCTION pm_enforce_service_desk_project();

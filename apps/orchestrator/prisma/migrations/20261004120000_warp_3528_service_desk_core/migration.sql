-- WARP-3528 (ADR-069, WS-12) — the service desk core: a ticket is a work item in
-- a SERVICE_DESK project, plus one PmTicket row.
--
-- ── what ships here ────────────────────────────────────────────────────────
--
--   1. PmProject.kind (PROJECT | SERVICE_DESK, default PROJECT). Every existing
--      project keeps its meaning. /api/pm reads PROJECT only; /api/support reads
--      SERVICE_DESK only.
--   2. PmState.slaClock (RUNNING | PAUSED | STOPPED, default RUNNING) — what a
--      state does to a ticket's SLA time, as a column rather than a rule read
--      off a state's name.
--   3. PmComment.visibility (INTERNAL | PUBLIC, default INTERNAL — every
--      existing comment stays internal), authorKind (USER | CONTACT | SYSTEM |
--      AUTOMATION, default USER) and contactId (plain id, no FK — see PmTicket).
--   4. PmTicket, keyed by its work item.
--   5. Two invariants Prisma's schema language cannot express (below), each
--      proven against a real Postgres in pm-ticket.pg.test.ts.
--
-- ModuleId 'support' is NOT added here. Postgres refuses to use an enum value
-- added by ALTER TYPE inside the same transaction, and Prisma applies a
-- migration file inside one; it is added by the preceding migration,
-- 20261004115900_warp_3528_module_support.
--
-- Additive only: no existing row is touched, no existing column changes
-- meaning, and a box that never creates a desk is unaffected.

-- ── Enums ───────────────────────────────────────────────────────────────────
-- UPPERCASE like PmRelationKind and the CRM enums: wire values the service and
-- the CHECK below quote verbatim.

CREATE TYPE "PmProjectKind" AS ENUM ('PROJECT', 'SERVICE_DESK');
CREATE TYPE "PmSlaClock" AS ENUM ('RUNNING', 'PAUSED', 'STOPPED');
CREATE TYPE "PmCommentVisibility" AS ENUM ('INTERNAL', 'PUBLIC');
CREATE TYPE "PmAuthorKind" AS ENUM ('USER', 'CONTACT', 'SYSTEM', 'AUTOMATION');
CREATE TYPE "PmRequesterKind" AS ENUM ('CONTACT', 'USER');
CREATE TYPE "PmTicketChannel" AS ENUM ('EMAIL', 'INTERNAL', 'WEB_FORM', 'CHAT', 'API', 'PHONE');
CREATE TYPE "PmSlaStatus" AS ENUM ('NONE', 'ON_TRACK', 'AT_RISK', 'BREACHED', 'MET', 'PAUSED');
CREATE TYPE "PmSatisfaction" AS ENUM ('GOOD', 'NEUTRAL', 'BAD');

-- ── Columns on the existing PM tables ───────────────────────────────────────

ALTER TABLE "PmProject" ADD COLUMN "kind" "PmProjectKind" NOT NULL DEFAULT 'PROJECT';

ALTER TABLE "PmState" ADD COLUMN "slaClock" "PmSlaClock" NOT NULL DEFAULT 'RUNNING';

ALTER TABLE "PmComment"
  ADD COLUMN "visibility" "PmCommentVisibility" NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN "authorKind" "PmAuthorKind" NOT NULL DEFAULT 'USER',
  ADD COLUMN "contactId" TEXT;

-- ── PmTicket ────────────────────────────────────────────────────────────────

CREATE TABLE "PmTicket" (
    "workItemId" TEXT NOT NULL,
    "requesterKind" "PmRequesterKind" NOT NULL,
    "requesterContactId" TEXT,
    "requesterUserId" TEXT,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT,
    "companyId" TEXT,
    "channel" "PmTicketChannel" NOT NULL,
    "firstRespondedAt" TIMESTAMP(3),
    "solvedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "lastPublicActivityAt" TIMESTAMP(3),
    "slaStatus" "PmSlaStatus" NOT NULL DEFAULT 'NONE',
    "satisfaction" "PmSatisfaction",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmTicket_pkey" PRIMARY KEY ("workItemId")
);

CREATE INDEX "PmTicket_requesterContactId_idx" ON "PmTicket"("requesterContactId");
CREATE INDEX "PmTicket_requesterUserId_idx" ON "PmTicket"("requesterUserId");
-- WARP-845: an unindexed ON DELETE SET NULL FK makes the parent delete a scan.
CREATE INDEX "PmTicket_companyId_idx" ON "PmTicket"("companyId");
CREATE INDEX "PmTicket_solvedAt_idx" ON "PmTicket"("solvedAt");

-- Cascade: a ticket row means nothing without its work item.
ALTER TABLE "PmTicket" ADD CONSTRAINT "PmTicket_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SetNull: deleting a customer record must not delete the conversations with
-- them. No CHECK below mentions "companyId", so a SetNull can never trip one.
ALTER TABLE "PmTicket" ADD CONSTRAINT "PmTicket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Neither requester column has a foreign key — on purpose. "requesterUserId" is
-- a plain User.id like every PM reference to a person. "requesterContactId"
-- would be the only FK from PM into the address book, and a Contact is
-- owner-scoped and deleted by paths that must not be blocked by (Restrict) or
-- silently eat (Cascade) a customer's ticket: an address-book source's cascade,
-- the connector purge walker, the filing undo. SetNull cannot sit inside the
-- CHECK below. The ticket therefore carries "requesterName" / "requesterEmail"
-- as of intake, and a requester whose row is gone still reads as who asked.

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- ADR-069 §2: "exactly one of the two foreign keys set, enforced by a CHECK".
-- The id that is set must be the one "requesterKind" names, and the other must
-- be NULL. A kind outside the CASE would be NULL, which a CHECK accepts, but
-- the column is a closed enum so there is no such kind.
ALTER TABLE "PmTicket"
  ADD CONSTRAINT "PmTicket_requester_matches_kind"
  CHECK (
    CASE "requesterKind"
      WHEN 'CONTACT' THEN "requesterContactId" IS NOT NULL AND "requesterUserId" IS NULL
      WHEN 'USER'    THEN "requesterUserId" IS NOT NULL AND "requesterContactId" IS NULL
    END
  );

-- A ticket row may only hang off a work item in a SERVICE_DESK project. A CHECK
-- cannot express it (it may not contain a subquery), and the service is not the
-- only writer a future importer or fix-up script will bring.
CREATE OR REPLACE FUNCTION pmticket_enforce_service_desk()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "PmWorkItem" wi
    JOIN "PmProject" p ON p."id" = wi."projectId"
    WHERE wi."id" = NEW."workItemId" AND p."kind" = 'SERVICE_DESK'
  ) THEN
    RAISE EXCEPTION
      'PmTicket % must belong to a work item in a SERVICE_DESK project (WARP-3528).',
      NEW."workItemId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmticket_enforce_service_desk() IS
  'WARP-3528: BEFORE INSERT OR UPDATE OF (workItemId) guard — a PmTicket row only ever hangs off a work item in a SERVICE_DESK project.';

DROP TRIGGER IF EXISTS pmticket_item_in_service_desk ON "PmTicket";
CREATE TRIGGER pmticket_item_in_service_desk
  BEFORE INSERT OR UPDATE OF "workItemId" ON "PmTicket"
  FOR EACH ROW
  EXECUTE FUNCTION pmticket_enforce_service_desk();

-- ADR-069 §3: "Project work items never have public comments." Only a PUBLIC
-- comment is ever delivered to a requester, so a PUBLIC comment on a project
-- work item would be a message with no recipient and no meaning — and the next
-- writer (automation, import) would not know. The WHEN clause keeps the check
-- off the hot path: an INTERNAL comment, which is every comment a project
-- ever receives, never evaluates the body.
CREATE OR REPLACE FUNCTION pmcomment_enforce_public_on_tickets()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "PmWorkItem" wi
    JOIN "PmProject" p ON p."id" = wi."projectId"
    WHERE wi."id" = NEW."workItemId" AND p."kind" = 'SERVICE_DESK'
  ) THEN
    RAISE EXCEPTION
      'A PUBLIC PmComment may only be written on a ticket (WARP-3528): work item % is not in a SERVICE_DESK project.',
      NEW."workItemId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION pmcomment_enforce_public_on_tickets() IS
  'WARP-3528: BEFORE INSERT OR UPDATE OF (visibility, workItemId) guard for PUBLIC comments — project work items never have public comments (ADR-069 §3).';

DROP TRIGGER IF EXISTS pmcomment_public_only_on_tickets ON "PmComment";
CREATE TRIGGER pmcomment_public_only_on_tickets
  BEFORE INSERT OR UPDATE OF "visibility", "workItemId" ON "PmComment"
  FOR EACH ROW
  WHEN (NEW."visibility" = 'PUBLIC')
  EXECUTE FUNCTION pmcomment_enforce_public_on_tickets();

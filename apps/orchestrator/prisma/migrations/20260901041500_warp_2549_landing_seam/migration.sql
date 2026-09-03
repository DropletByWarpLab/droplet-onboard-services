-- WARP-2549 — the landing seam: give a synced CRM row a connection, and make
-- partial provenance impossible.
--
-- Until now the connectors read canonical rows and threw them away. The tick
-- moved cursors and watermarks and persisted nothing, so a customer who exists
-- in HubSpot did not exist on the box. This migration is the substrate the
-- landing writes into.
--
-- Two things it changes, both for the same reason:
--
-- 1. PROVENANCE IS SCOPED TO A CONNECTION, NOT TO A VENDOR.
--    `@@unique([externalSystem, externalId])` reads correctly on a box with one
--    connection per vendor and is wrong twice, silently, on a box with two
--    HubSpot portals: their object ids are portal-scoped, so portal B's company
--    `123` is refused forever as already belonging to portal A's customer. The
--    same column is what WARP-2461's purge walker keys on — its own mutation
--    test proves that scoping a purge by PROVIDER destroys the sibling
--    connection's data. This is the identical defect WARP-2562 fixed on
--    `PartyLink` before it could ship; fixing it here before the first row
--    lands costs one migration, and fixing it after costs a data migration
--    across three tables plus whatever was already wrong.
--
-- 2. PROVENANCE IS COMPLETE OR REFUSED.
--    A row carrying `externalId` but no connection is unpurgeable and
--    unattributable; a row carrying a connection but no `externalId` cannot be
--    reconciled on the next tick and lands again as a duplicate. Neither is
--    reachable through the landing code — and neither would be reachable
--    through a code review either, which is exactly why the rule belongs in the
--    database. A data migration, a psql session and a future connector all
--    write to this table without passing through any TypeScript.
--
--    The CHECK also pins `origin = 'EXTERNAL'` on a landed row, so the flag the
--    CRM refuses local edits on cannot disagree with the presence of an
--    upstream. `origin` is the decision (WARP-2117), and this keeps it honest.
--
-- Existing rows are unaffected: nothing has ever written `externalSystem` or
-- `externalId` on these tables, and a CardDAV contact — EXTERNAL, with
-- `sourceId` and `externalUid` and no vendor pair — satisfies the "all three
-- NULL" branch. The migration therefore backfills nothing.
--
-- ADR-041 §4 is amended in the same change. Its rule is about inheriting an
-- UNKEPT PROMISE — `ErpEntityCache`'s docstring claims an at-rest encryption
-- that does not exist (WARP-2028) — not about persistence as such. `CrmCompany`
-- makes no such claim and already holds this data the moment a human types it.
-- PHI datasets (`patient`, `appointment`, `account`) still land NOWHERE, and
-- `ErpEntityCache` still has no writer.

-- --- the connection a landed row came from -----------------------------------

ALTER TABLE "Contact" ADD COLUMN "connectionId" TEXT;
ALTER TABLE "CrmCompany" ADD COLUMN "connectionId" TEXT;
ALTER TABLE "CrmDeal" ADD COLUMN "connectionId" TEXT;

-- A synced pipeline belongs to exactly one connection: a vendor's stages are
-- not the owner's stages, and landing into the owner's own board would either
-- invent a mapping nobody reconciled or pile every synced deal into whichever
-- stage sorted first.
ALTER TABLE "CrmPipeline" ADD COLUMN "connectionId" TEXT;

-- The vendor's own stage value. Stage NAMES are owner-editable, so re-landing
-- keyed on the name would create a second stage the day someone renamed one.
ALTER TABLE "CrmPipelineStage" ADD COLUMN "externalKey" TEXT;

-- --- provider-scoped uniques out, connection-scoped uniques in ----------------

DROP INDEX "Contact_externalSystem_externalId_key";
DROP INDEX "CrmCompany_externalSystem_externalId_key";
DROP INDEX "CrmDeal_externalSystem_externalId_key";

CREATE UNIQUE INDEX "Contact_connectionId_externalId_key" ON "Contact"("connectionId", "externalId");
CREATE UNIQUE INDEX "CrmCompany_connectionId_externalId_key" ON "CrmCompany"("connectionId", "externalId");
CREATE UNIQUE INDEX "CrmDeal_connectionId_externalId_key" ON "CrmDeal"("connectionId", "externalId");

-- Postgres does not treat two NULLs as equal, so every locally typed row (both
-- columns NULL) sits outside these indexes rather than colliding on them.

CREATE INDEX "Contact_connectionId_idx" ON "Contact"("connectionId");
CREATE INDEX "CrmCompany_connectionId_idx" ON "CrmCompany"("connectionId");
CREATE INDEX "CrmDeal_connectionId_idx" ON "CrmDeal"("connectionId");

CREATE UNIQUE INDEX "CrmPipeline_connectionId_key" ON "CrmPipeline"("connectionId");
CREATE UNIQUE INDEX "CrmPipelineStage_pipelineId_externalKey_key" ON "CrmPipelineStage"("pipelineId", "externalKey");

-- --- foreign keys ------------------------------------------------------------
--
-- RESTRICT, not CASCADE. Nothing deletes an `IntegrationConnection` today —
-- `disconnect()` flips it to DISABLED and purges its secrets in place, so
-- "disconnected" is a state rather than an absence. If something starts
-- deleting them, this constraint fails loudly instead of silently taking a
-- customer's landed records (and the notes a human wrote against them) with it.

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CrmPipeline" ADD CONSTRAINT "CrmPipeline_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- provenance is complete or refused ---------------------------------------
--
-- Prisma cannot express this, which is why it is written by hand and why
-- `landing-provenance.pg.test.ts` runs against a real Postgres: delete either
-- CHECK and every MOCKED test still passes.

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_provenance_complete" CHECK (
  ("connectionId" IS NULL AND "externalSystem" IS NULL AND "externalId" IS NULL)
  OR ("connectionId" IS NOT NULL AND "externalSystem" IS NOT NULL AND "externalId" IS NOT NULL AND "origin" = 'EXTERNAL')
);

ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_provenance_complete" CHECK (
  ("connectionId" IS NULL AND "externalSystem" IS NULL AND "externalId" IS NULL)
  OR ("connectionId" IS NOT NULL AND "externalSystem" IS NOT NULL AND "externalId" IS NOT NULL AND "origin" = 'EXTERNAL')
);

ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_provenance_complete" CHECK (
  ("connectionId" IS NULL AND "externalSystem" IS NULL AND "externalId" IS NULL)
  OR ("connectionId" IS NOT NULL AND "externalSystem" IS NOT NULL AND "externalId" IS NOT NULL AND "origin" = 'EXTERNAL')
);

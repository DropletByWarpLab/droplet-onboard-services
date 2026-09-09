-- WARP-2562 (ADR-044) — PartyLink, and the customer a project is for.
--
-- Additive throughout. No existing column changes meaning, no data moves, and
-- a box that never links anything is unaffected: the new table starts empty
-- and the new column defaults to NULL.
--
-- Predecessor: 20260830220000_warp_2554_contact_archive. That is the ordering
-- fact worth pinning — "this migration sorts last" describes only the day it
-- landed, and the next migration falsifies it.
--
-- Re-stamped 20260830230000 → 20260831180000 (WARP-2562 review). The original
-- stamp predated `20260831040000_warp_2022_calendar_allow_private_host`, which
-- had already reached `stage` — so deploying this branch would have run a
-- migration numbered BEFORE one the box already applied. That is the exact
-- ordering hazard the predecessor pin above exists to describe, arriving from
-- the other direction: not "am I last", but "am I after everything that is
-- already out there".

-- CreateEnum
--
-- How a link came to exist, as a real column. Never inferred from
-- `confidence IS NULL` (WARP-884): a reader must not have to work out which
-- flavour of null they are holding.
CREATE TYPE "PartyLinkOrigin" AS ENUM ('MANUAL', 'MATCHED', 'IMPORTED');

-- CreateTable
--
-- A POINTER, not a copy. `externalSystem` + `externalId` name a record in an
-- upstream system; the upstream stays the system of record and the detail is
-- fetched live through the existing connector, under the existing PHI gate.
-- Nothing in this table is PHI.
CREATE TABLE "PartyLink" (
    "id" TEXT NOT NULL,
    "contactId" TEXT,
    "companyId" TEXT,
    -- The CONNECTION, not merely the provider. A business can connect two
    -- HubSpot portals; their object ids are portal-scoped and collide, and the
    -- WARP-2461 purge walker keys on exactly this column. NOT NULL: a link
    -- that cannot say which connection it came from cannot be purged, and a
    -- nullable column would let that back in through the front door.
    "connectionId" TEXT NOT NULL,
    "externalSystem" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "linkedBy" "PartyLinkOrigin" NOT NULL DEFAULT 'MANUAL',
    "confidence" INTEGER,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- One upstream record maps to at most one party. Two links to the same record
-- — even from two different parties — is a contradiction, not a second
-- opinion.
--
-- Scoped by CONNECTION rather than by provider, and that is load-bearing.
-- HubSpot object ids are PORTAL-scoped, so under a
-- `(externalSystem, externalId)` key a second portal's object `123` collides
-- with the first portal's object `123` — two different customers, and the
-- second one is refused as already linked to somebody else.
CREATE UNIQUE INDEX "PartyLink_connectionId_externalId_key" ON "PartyLink"("connectionId", "externalId");

-- CreateIndex
-- "The links on this party" is the only read path the record page has.
CREATE INDEX "PartyLink_contactId_idx" ON "PartyLink"("contactId");
CREATE INDEX "PartyLink_companyId_idx" ON "PartyLink"("companyId");
-- "Everything this connection landed" — the WARP-2461 purge walker's read.
CREATE INDEX "PartyLink_connectionId_idx" ON "PartyLink"("connectionId");

-- AddForeignKey
--
-- CASCADE on both parties. A link to a deleted party is meaningless, and
-- unlike CrmActivity this destroys nothing a human authored: the row is a
-- pointer, and the upstream record it points at is untouched.
ALTER TABLE "PartyLink" ADD CONSTRAINT "PartyLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartyLink" ADD CONSTRAINT "PartyLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the connection, deliberately not CASCADE.
--
-- Nothing deletes an `IntegrationConnection` today — `disconnect()` flips the
-- row to DISABLED and purges its secrets in place, precisely so "disconnected"
-- is a state rather than an absence. So this constraint fires only if
-- something new starts deleting them, and at that point the landed links must
-- be purged DELIBERATELY, through the purge walker that knows to preserve what
-- a human confirmed. A CASCADE here would delete a person's confirmed customer
-- matches as a side effect of a row disappearing, with no audit and no
-- decision.
ALTER TABLE "PartyLink" ADD CONSTRAINT "PartyLink_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one party, enforced by the DATABASE.
--
-- Prisma cannot express an XOR across two optional relations, so without this
-- the schema permits a row that is linked to a contact AND a company (which
-- party is it?) and a row linked to neither (a dangling pointer to an upstream
-- record with nothing on this side). The service checks the same thing, but a
-- service check is a friendly error message — this is the invariant, and it
-- holds for a connector, a migration, or a hand-written UPDATE too.
--
-- Modelled on `CrmActivity_subject_exactly_one` from WARP-2117.
ALTER TABLE "PartyLink"
  ADD CONSTRAINT "PartyLink_party_exactly_one"
  CHECK ((("contactId" IS NOT NULL)::int + ("companyId" IS NOT NULL)::int) = 1);

-- A confidence is only meaningful on a MATCHED link.
--
-- On MANUAL or IMPORTED it would be a number nobody computed, and a reader
-- averaging or thresholding it would be acting on noise. Range-checked here
-- rather than only in zod, for the same reason as above.
ALTER TABLE "PartyLink"
  ADD CONSTRAINT "PartyLink_confidence_matched_only"
  CHECK (
    ("confidence" IS NULL AND "linkedBy" <> 'MATCHED')
    OR ("linkedBy" = 'MATCHED' AND "confidence" IS NOT NULL AND "confidence" BETWEEN 0 AND 100)
  );

-- AlterTable
--
-- The customer a project is FOR. WARP-2117 gave the DEAL a project; this is
-- the other direction, and it is a different edge — work begun before the CRM
-- was switched on, a warranty callout, a second phase, all have a customer and
-- no deal.
--
-- NULL is the common case and is not a gap: internal projects have no
-- customer, and on a home box that is most of them. So no backfill.
--
-- SET NULL, not CASCADE: deleting a customer must not delete the work
-- delivered for them. The job happened.
ALTER TABLE "PmProject" ADD COLUMN "companyId" TEXT;

CREATE INDEX "PmProject_companyId_isArchived_idx" ON "PmProject"("companyId", "isArchived");

ALTER TABLE "PmProject" ADD CONSTRAINT "PmProject_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

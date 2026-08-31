-- WARP-2562 (ADR-044) — PartyLink, and the customer a project is for.
--
-- Additive throughout. No existing column changes meaning, no data moves, and
-- a box that never links anything is unaffected: the new table starts empty
-- and the new column defaults to NULL.
--
-- Predecessor: 20260830220000_warp_2554_contact_archive. That is the ordering
-- fact worth pinning — "this migration sorts last" describes only the day it
-- landed, and the next migration falsifies it.

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
-- One upstream record maps to at most one party. Two links to the same
-- (system, id) — even from two different parties — is a contradiction, not a
-- second opinion.
CREATE UNIQUE INDEX "PartyLink_externalSystem_externalId_key" ON "PartyLink"("externalSystem", "externalId");

-- CreateIndex
-- "The links on this party" is the only read path the record page has.
CREATE INDEX "PartyLink_contactId_idx" ON "PartyLink"("contactId");
CREATE INDEX "PartyLink_companyId_idx" ON "PartyLink"("companyId");

-- AddForeignKey
--
-- CASCADE on both. A link to a deleted party is meaningless, and unlike
-- CrmActivity this destroys nothing a human authored: the row is a pointer,
-- and the upstream record it points at is untouched.
ALTER TABLE "PartyLink" ADD CONSTRAINT "PartyLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartyLink" ADD CONSTRAINT "PartyLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

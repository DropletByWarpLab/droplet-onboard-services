-- WARP-2585 (ADR-045 slice 6) -- `EntityLink`: a file in /files RELATED to a
-- business record.
--
-- NOT an upload. `PmAttachment` COPIES bytes onto a work item under its own
-- `storageKey @unique` and is untouched by this migration; the two coexist and
-- answer different questions ("a copy lives here" vs "that file over there is
-- this customer's contract").
--
-- Keyed on `ncFileId` (oc:fileid), which is the identity `FileComment`,
-- `FileTag`, `File` and `FileContentChunk` already agree on, and whose
-- docstring adjudicated the choice: a pointer that SURVIVES a rename/move.
-- `FileCitation.filePath` is the third opinion and it is the one that goes
-- stale; this table deliberately does not copy it.
--
-- NO FOREIGN KEY TO "File". The registry is intentionally incomplete --
-- `upsertFileRegistryEntry` never throws and an absent row is a supported
-- state that every metadata route branches on -- so an FK would reject a link
-- to any unregistered file, which is most of them. A link is a pointer that
-- can dangle; the cached name/path is what keeps a dangling row readable.

-- CreateEnum
CREATE TYPE "EntityLinkSubject" AS ENUM ('COMPANY', 'CONTACT', 'DEAL', 'PROJECT', 'WORK_ITEM');

-- CreateEnum
CREATE TYPE "EntityLinkRole" AS ENUM ('CONTRACT', 'INVOICE', 'QUOTE', 'SCAN', 'CORRESPONDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "EntityLinkOrigin" AS ENUM ('MANUAL', 'SUGGESTED', 'EXTRACTED');

-- CreateTable
CREATE TABLE "EntityLink" (
    "id" TEXT NOT NULL,
    "ncFileId" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSpace" TEXT NOT NULL,
    "subjectType" "EntityLinkSubject" NOT NULL,
    "companyId" TEXT,
    "contactId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "workItemId" TEXT,
    "role" "EntityLinkRole" NOT NULL DEFAULT 'OTHER',
    "linkedBy" "EntityLinkOrigin" NOT NULL DEFAULT 'MANUAL',
    "confidence" INTEGER,
    "note" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "which records is this file attached to" -- the file-detail direction.
CREATE INDEX "EntityLink_ncFileId_idx" ON "EntityLink"("ncFileId");

-- CreateIndex
-- WARP-845: Postgres does NOT index a foreign key for you, and a CASCADE
-- delete without one is a sequential scan of this whole table per deleted
-- parent. `crm.service.ts` shipped five unindexed FK columns; these five are
-- indexed at birth. The subject column LEADS each composite, so one index
-- serves both the cascade and the "unarchived documents on this record"
-- listing (the shipped `CrmCompany @@index([ownerId, isArchived])` shape).
CREATE INDEX "EntityLink_companyId_isArchived_idx" ON "EntityLink"("companyId", "isArchived");
CREATE INDEX "EntityLink_contactId_isArchived_idx" ON "EntityLink"("contactId", "isArchived");
CREATE INDEX "EntityLink_dealId_isArchived_idx" ON "EntityLink"("dealId", "isArchived");
CREATE INDEX "EntityLink_projectId_isArchived_idx" ON "EntityLink"("projectId", "isArchived");
CREATE INDEX "EntityLink_workItemId_isArchived_idx" ON "EntityLink"("workItemId", "isArchived");

-- AddForeignKey
-- All five CASCADE, and they have to: `EntityLink_subject_exactly_one` below
-- forbids an orphan, so a subject column cannot be SetNull. Same reasoning the
-- `CrmActivity` relations carry, and the same consequence: deleting the record
-- deletes its file links. It does NOT delete the files -- this table holds
-- pointers, and the bytes belong to /files.
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EntityLink" ADD CONSTRAINT "EntityLink_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2585: an EntityLink hangs off EXACTLY ONE record, and `subjectType`
-- must name the column that is populated. Without the second half a row can
-- claim subjectType='DEAL' while carrying only a companyId, and every listing
-- built on subjectType silently drops it -- the CrmActivity_subject_exactly_one
-- lesson, applied before it can be relearned.
ALTER TABLE "EntityLink"
  ADD CONSTRAINT "EntityLink_subject_exactly_one"
  CHECK (
    (("companyId" IS NOT NULL)::int + ("contactId" IS NOT NULL)::int + ("dealId" IS NOT NULL)::int
      + ("projectId" IS NOT NULL)::int + ("workItemId" IS NOT NULL)::int) = 1
    AND (("subjectType" = 'COMPANY') = ("companyId" IS NOT NULL))
    AND (("subjectType" = 'CONTACT') = ("contactId" IS NOT NULL))
    AND (("subjectType" = 'DEAL') = ("dealId" IS NOT NULL))
    AND (("subjectType" = 'PROJECT') = ("projectId" IS NOT NULL))
    AND (("subjectType" = 'WORK_ITEM') = ("workItemId" IS NOT NULL))
  );

-- WARP-2585: a confidence on a link a human made by hand is a number nobody
-- computed; a suggestion with no score is a suggestion nobody can rank or
-- threshold. Required exactly when `linkedBy` is not MANUAL -- the same
-- all-or-nothing shape as `CrmDeal_amount_needs_currency`.
ALTER TABLE "EntityLink"
  ADD CONSTRAINT "EntityLink_confidence_matches_origin"
  CHECK (("linkedBy" = 'MANUAL') = ("confidence" IS NULL));

-- WARP-2585: confidence is a percentage or absent -- never 3000. Integer
-- 0-100 rather than a float, mirroring `CrmPipelineStage.probability`.
ALTER TABLE "EntityLink"
  ADD CONSTRAINT "EntityLink_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100));

-- WARP-2585: one link per (file, record). FIVE PARTIAL unique indexes, NOT one
-- compound @@unique over all five subject columns.
--
-- READ THIS BEFORE "SIMPLIFYING" IT BACK. A compound unique index over columns
-- that are NULL on every row except one is not a weaker constraint -- it is NO
-- constraint. Postgres never treats two rows as duplicates when an indexed
-- column is NULL, and four of the five are always NULL, so `(ncFileId,
-- companyId, contactId, dealId, projectId, workItemId)` would reject nothing
-- and P2002 would never fire. The partial predicate is what puts both indexed
-- columns beyond NULL and makes the uniqueness real.
--
-- Consequence for callers: `prisma.upsert` CANNOT address a partial index --
-- there is no generated compound `where` for it. The write path is
-- updateMany-then-create with a P2002 retry (entity-link.service.ts), and that
-- retry is meaningful only because these indexes exist.
CREATE UNIQUE INDEX "EntityLink_ncFileId_companyId_key" ON "EntityLink"("ncFileId", "companyId") WHERE "companyId" IS NOT NULL;
CREATE UNIQUE INDEX "EntityLink_ncFileId_contactId_key" ON "EntityLink"("ncFileId", "contactId") WHERE "contactId" IS NOT NULL;
CREATE UNIQUE INDEX "EntityLink_ncFileId_dealId_key" ON "EntityLink"("ncFileId", "dealId") WHERE "dealId" IS NOT NULL;
CREATE UNIQUE INDEX "EntityLink_ncFileId_projectId_key" ON "EntityLink"("ncFileId", "projectId") WHERE "projectId" IS NOT NULL;
CREATE UNIQUE INDEX "EntityLink_ncFileId_workItemId_key" ON "EntityLink"("ncFileId", "workItemId") WHERE "workItemId" IS NOT NULL;

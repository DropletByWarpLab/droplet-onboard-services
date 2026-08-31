-- WARP-2018 (contacts) / WARP-2117 (CRM core) — tables, indexes and the
-- invariants the Prisma schema language cannot express.
--
-- Ordered AFTER the ModuleId enum append in
-- 20260829000000_warp_2117_module_ids.
-- CreateEnum
CREATE TYPE "AddressBookStatus" AS ENUM ('NOT_CONFIGURED', 'VERIFYING', 'CONNECTED', 'DEGRADED', 'AUTH_FAILED', 'UNSUPPORTED_SERVER', 'DISABLED');

-- CreateEnum
CREATE TYPE "AddressBookSyncMode" AS ENUM ('SYNC_COLLECTION', 'ETAG_DIFF', 'FULL_PULL');

-- CreateEnum
CREATE TYPE "ContactOrigin" AS ENUM ('LOCAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "CrmRecordOrigin" AS ENUM ('LOCAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "CrmStageKind" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "CrmActivitySubject" AS ENUM ('COMPANY', 'CONTACT', 'DEAL');

-- CreateEnum
CREATE TYPE "CrmActivityKind" AS ENUM ('NOTE', 'EMAIL', 'CALL', 'MEETING', 'TASK', 'STAGE_CHANGE', 'CREATED', 'SYNCED');

CREATE TABLE "AddressBookSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverUrl" TEXT NOT NULL,
    "collectionUrl" TEXT,
    "authMode" TEXT NOT NULL DEFAULT 'basic',
    "username" TEXT,
    "passwordEnc" TEXT,
    "status" "AddressBookStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "statusReason" TEXT,
    "syncMode" "AddressBookSyncMode" NOT NULL DEFAULT 'FULL_PULL',
    "syncToken" TEXT,
    "ctag" TEXT,
    "syncIntervalSec" INTEGER NOT NULL DEFAULT 900,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "offLanAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddressBookSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT,
    "origin" "ContactOrigin" NOT NULL DEFAULT 'LOCAL',
    "externalSystem" TEXT,
    "externalId" TEXT,
    "externalUid" TEXT,
    "href" TEXT,
    "etag" TEXT,
    "vcardVersion" TEXT,
    "displayName" TEXT NOT NULL,
    "givenName" TEXT,
    "familyName" TEXT,
    "organization" TEXT,
    "jobTitle" TEXT,
    "note" TEXT,
    "birthday" TEXT,
    "photoStorageKey" TEXT,
    "photoMimeType" TEXT,
    "photoSizeBytes" INTEGER,
    "rawVcard" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactEmail" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "addressLower" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPhone" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContactPhone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "note" TEXT,
    "ownerId" TEXT,
    "origin" "CrmRecordOrigin" NOT NULL DEFAULT 'LOCAL',
    "externalSystem" TEXT,
    "externalId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmCompany_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmCompanyContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "title" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmCompanyContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmPipeline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmPipelineStage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "kind" "CrmStageKind" NOT NULL DEFAULT 'OPEN',
    "probability" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDeal" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "companyId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "amountMinor" BIGINT,
    "currency" TEXT,
    "expectedCloseOn" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "ownerId" TEXT,
    "projectId" TEXT,
    "origin" "CrmRecordOrigin" NOT NULL DEFAULT 'LOCAL',
    "externalSystem" TEXT,
    "externalId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDealContact" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmDealContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "subjectType" "CrmActivitySubject" NOT NULL,
    "companyId" TEXT,
    "contactId" TEXT,
    "dealId" TEXT,
    "kind" "CrmActivityKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "noteId" TEXT,
    "emailMessageId" TEXT,
    "calendarEventId" TEXT,
    "workItemId" TEXT,
    "fromStageId" TEXT,
    "toStageId" TEXT,
    "origin" "CrmRecordOrigin" NOT NULL DEFAULT 'LOCAL',
    "externalSystem" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AddressBookSource_userId_status_idx" ON "AddressBookSource"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_photoStorageKey_key" ON "Contact"("photoStorageKey");

-- CreateIndex
CREATE INDEX "Contact_userId_displayName_idx" ON "Contact"("userId", "displayName");

-- CreateIndex
CREATE INDEX "Contact_userId_origin_idx" ON "Contact"("userId", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_sourceId_externalUid_key" ON "Contact"("sourceId", "externalUid");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_externalSystem_externalId_key" ON "Contact"("externalSystem", "externalId");

-- CreateIndex
CREATE INDEX "ContactEmail_contactId_idx" ON "ContactEmail"("contactId");

-- CreateIndex
CREATE INDEX "ContactEmail_addressLower_idx" ON "ContactEmail"("addressLower");

-- CreateIndex
CREATE INDEX "ContactPhone_contactId_idx" ON "ContactPhone"("contactId");

-- CreateIndex
CREATE INDEX "CrmCompany_name_idx" ON "CrmCompany"("name");

-- CreateIndex
CREATE INDEX "CrmCompany_domain_idx" ON "CrmCompany"("domain");

-- CreateIndex
CREATE INDEX "CrmCompany_ownerId_isArchived_idx" ON "CrmCompany"("ownerId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "CrmCompany_externalSystem_externalId_key" ON "CrmCompany"("externalSystem", "externalId");

-- CreateIndex
CREATE INDEX "CrmCompanyContact_contactId_idx" ON "CrmCompanyContact"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmCompanyContact_companyId_contactId_key" ON "CrmCompanyContact"("companyId", "contactId");

-- CreateIndex
CREATE INDEX "CrmPipeline_isArchived_sortOrder_idx" ON "CrmPipeline"("isArchived", "sortOrder");

-- CreateIndex
CREATE INDEX "CrmPipelineStage_pipelineId_kind_idx" ON "CrmPipelineStage"("pipelineId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CrmPipelineStage_pipelineId_sortOrder_key" ON "CrmPipelineStage"("pipelineId", "sortOrder");

-- CreateIndex
CREATE INDEX "CrmDeal_pipelineId_stageId_idx" ON "CrmDeal"("pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "CrmDeal_stageId_idx" ON "CrmDeal"("stageId");

-- CreateIndex
CREATE INDEX "CrmDeal_companyId_idx" ON "CrmDeal"("companyId");

-- CreateIndex
CREATE INDEX "CrmDeal_ownerId_isArchived_idx" ON "CrmDeal"("ownerId", "isArchived");

-- CreateIndex
CREATE INDEX "CrmDeal_expectedCloseOn_idx" ON "CrmDeal"("expectedCloseOn");

-- CreateIndex
CREATE UNIQUE INDEX "CrmDeal_externalSystem_externalId_key" ON "CrmDeal"("externalSystem", "externalId");

-- CreateIndex
CREATE INDEX "CrmDealContact_contactId_idx" ON "CrmDealContact"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmDealContact_dealId_contactId_key" ON "CrmDealContact"("dealId", "contactId");

-- CreateIndex
CREATE INDEX "CrmActivity_dealId_occurredAt_idx" ON "CrmActivity"("dealId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_companyId_occurredAt_idx" ON "CrmActivity"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_contactId_occurredAt_idx" ON "CrmActivity"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_kind_occurredAt_idx" ON "CrmActivity"("kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmActivity_externalSystem_externalId_key" ON "CrmActivity"("externalSystem", "externalId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "AddressBookSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactEmail" ADD CONSTRAINT "ContactEmail_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPhone" ADD CONSTRAINT "ContactPhone_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCompanyContact" ADD CONSTRAINT "CrmCompanyContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmCompanyContact" ADD CONSTRAINT "CrmCompanyContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPipelineStage" ADD CONSTRAINT "CrmPipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "CrmPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "CrmPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CrmPipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDealContact" ADD CONSTRAINT "CrmDealContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "CrmDeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2117: a CrmActivity hangs off EXACTLY ONE subject, and subjectType must
-- name the column that is populated. Without this, a row can claim
-- subjectType='DEAL' while carrying only a companyId, and every timeline query
-- built on subjectType silently drops it.
ALTER TABLE "CrmActivity"
  ADD CONSTRAINT "CrmActivity_subject_exactly_one"
  CHECK (
    (("companyId" IS NOT NULL)::int + ("contactId" IS NOT NULL)::int + ("dealId" IS NOT NULL)::int) = 1
    AND (("subjectType" = 'COMPANY') = ("companyId" IS NOT NULL))
    AND (("subjectType" = 'CONTACT') = ("contactId" IS NOT NULL))
    AND (("subjectType" = 'DEAL') = ("dealId" IS NOT NULL))
  );

-- WARP-2117: at most one default pipeline. A partial unique index rather than a
-- plain one, so the many non-default pipelines do not collide with each other.
CREATE UNIQUE INDEX "CrmPipeline_one_default"
  ON "CrmPipeline" ("isDefault")
  WHERE "isDefault" = true;

-- WARP-2117: currency is required exactly when an amount is present. A deal
-- worth 250000 minor units of nothing is not a number anybody can add up.
ALTER TABLE "CrmDeal"
  ADD CONSTRAINT "CrmDeal_amount_needs_currency"
  CHECK (("amountMinor" IS NULL) = ("currency" IS NULL));

-- WARP-2117: forecast weighting is a percentage or absent — never 3000.
ALTER TABLE "CrmPipelineStage"
  ADD CONSTRAINT "CrmPipelineStage_probability_range"
  CHECK ("probability" IS NULL OR ("probability" >= 0 AND "probability" <= 100));

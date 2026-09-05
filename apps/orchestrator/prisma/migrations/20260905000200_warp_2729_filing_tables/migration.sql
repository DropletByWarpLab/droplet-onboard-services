-- WARP-2729 (ADR-048) — what the box proposed, what the owner corrected, and
-- what the owner consented to.
--
-- 🔴 THE FK/CHECK TRAP THIS MIGRATION DELIBERATELY AVOIDS
--
-- An `onDelete: SetNull` FK whose column is required by a NOT-NULL CHECK makes
-- the parent row UN-DELETABLE: the SetNull fires inside the same statement the
-- CHECK then rejects, so the delete fails at the database. It is live here
-- twice over if written naively:
--
--   * `EmailMessage.accountId` is `onDelete: Cascade`, so `DELETE
--     /api/email/accounts` cascades into every email proposal. A
--     "source_exactly_one" CHECK over (ncFileId, emailMessageId) would make
--     that route permanently fail the moment one email proposal exists.
--   * A `User` delete would fail while filing is on, if `enabledById` were an
--     FK required by the consent CHECK.
--
-- Both are avoided the same way, and it is the house pattern rather than an
-- invention: `sourceRef` (TEXT, NOT NULL) carries the source identity and
-- survives the source row's deletion, while `ncFileId`/`emailMessageId` are
-- uncovered convenience pointers; and every actor column is a plain string,
-- exactly as `ErpWriteRequest.requestedBy`, `ToolSpec.ownerId` and
-- `PmComment.createdById` already are. Those columns audit WHO decided, and
-- that fact stays true after the user row is gone.

-- CreateEnum
CREATE TYPE "IngestSourceKind" AS ENUM ('FILE', 'EMAIL');

-- CreateEnum
CREATE TYPE "IngestProposalKind" AS ENUM ('LINK_FILE', 'LOG_EMAIL_ACTIVITY', 'SET_PROJECT_CUSTOMER', 'CREATE_CUSTOMER', 'CREATE_PROJECT', 'CREATE_CONTACT', 'MATCH_REVIEW', 'CREATE_MONEY_DOC');

-- CreateEnum
CREATE TYPE "IngestProposalStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'NOT_SAME', 'EXPIRED', 'UNDONE');

-- CreateEnum
CREATE TYPE "FilingPolicyClass" AS ENUM ('AUTO', 'REVIEW', 'NEVER');

-- CreateEnum
CREATE TYPE "PhiVerdict" AS ENUM ('CLEAN', 'MENTIONS', 'RECORD');

-- CreateEnum
CREATE TYPE "IngestMatchKind" AS ENUM ('EMAIL', 'DOMAIN', 'NAME', 'NONE');

-- CreateEnum
CREATE TYPE "IngestKeyKind" AS ENUM ('EMAIL_ADDRESS', 'EMAIL_DOMAIN', 'NAME', 'NC_FOLDER');

-- CreateEnum
CREATE TYPE "FilingDecisionKind" AS ENUM ('NOT_SAME', 'ALWAYS_HERE', 'IGNORE_SOURCE');

-- CreateEnum
CREATE TYPE "AutoFilingMode" AS ENUM ('off', 'propose', 'auto');

-- CreateEnum
CREATE TYPE "AutoFilingLevel" AS ENUM ('links_only', 'also_create');

-- CreateEnum
CREATE TYPE "AutoFilingVertical" AS ENUM ('general', 'healthcare');

-- CreateTable
CREATE TABLE "IngestProposal" (
    "id" TEXT NOT NULL,
    "sourceKind" "IngestSourceKind" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "ncFileId" INTEGER,
    "emailMessageId" TEXT,
    "kind" "IngestProposalKind" NOT NULL,
    "status" "IngestProposalStatus" NOT NULL DEFAULT 'PENDING',
    "policyClass" "FilingPolicyClass" NOT NULL,
    "policyReason" TEXT,
    "confidence" INTEGER NOT NULL,
    "phiVerdict" "PhiVerdict" NOT NULL,
    "matchKind" "IngestMatchKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence" JSONB,
    "extractorVersion" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "autoApplied" BOOLEAN NOT NULL DEFAULT false,
    "undoneById" TEXT,
    "undoneAt" TIMESTAMP(3),
    "undoMode" TEXT,
    "createdCompanyId" TEXT,
    "createdContactId" TEXT,
    "createdProjectId" TEXT,
    "createdEntityLinkId" TEXT,
    "createdActivityId" TEXT,
    "dependsOnProposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingDecision" (
    "id" TEXT NOT NULL,
    "keyKind" "IngestKeyKind" NOT NULL,
    "keyValue" TEXT NOT NULL,
    "verdict" "FilingDecisionKind" NOT NULL,
    "companyId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoFilingSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "AutoFilingMode" NOT NULL DEFAULT 'off',
    "level" "AutoFilingLevel" NOT NULL DEFAULT 'links_only',
    "vertical" "AutoFilingVertical" NOT NULL DEFAULT 'general',
    "enabledById" TEXT,
    "enabledAt" TIMESTAMP(3),
    "folders" JSONB,
    "pathDenylist" JSONB,
    "sources" JSONB,
    "hourlyApplyCap" INTEGER NOT NULL DEFAULT 50,
    "dailyCreateCap" INTEGER NOT NULL DEFAULT 10,
    "digestHour" INTEGER NOT NULL DEFAULT 8,
    "canaryPassedAt" TIMESTAMP(3),
    "canaryModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoFilingSetting_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CrmCompany" ADD COLUMN "proposalId" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "proposalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "IngestProposal_sourceRef_kind_dedupeKey_extractorVersion_key" ON "IngestProposal"("sourceRef", "kind", "dedupeKey", "extractorVersion");

-- CreateIndex
CREATE INDEX "IngestProposal_status_createdAt_idx" ON "IngestProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "IngestProposal_sourceRef_idx" ON "IngestProposal"("sourceRef");

-- CreateIndex
CREATE INDEX "IngestProposal_ncFileId_idx" ON "IngestProposal"("ncFileId");

-- CreateIndex
CREATE INDEX "IngestProposal_emailMessageId_idx" ON "IngestProposal"("emailMessageId");

-- CreateIndex
CREATE INDEX "IngestProposal_dependsOnProposalId_idx" ON "IngestProposal"("dependsOnProposalId");

-- CreateIndex
CREATE INDEX "FilingDecision_keyKind_keyValue_idx" ON "FilingDecision"("keyKind", "keyValue");

-- CreateIndex
CREATE INDEX "CrmCompany_proposalId_idx" ON "CrmCompany"("proposalId");

-- CreateIndex
CREATE INDEX "Contact_proposalId_idx" ON "Contact"("proposalId");

-- AddForeignKey
--
-- SetNull, and safe precisely because no CHECK below references this column.
ALTER TABLE "IngestProposal" ADD CONSTRAINT "IngestProposal_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
--
-- Deleting a proposal SetNulls the back-pointer and SUCCEEDS. This is the exact
-- pair the block comment above warns about, kept safe by leaving `proposalId`
-- out of every CHECK: the purge walker must be able to reap a proposal whose
-- source file was deleted in Nextcloud without the row it created blocking it.
ALTER TABLE "CrmCompany" ADD CONSTRAINT "CrmCompany_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "IngestProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "IngestProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants that are not expressible in the Prisma datamodel.
-- Each is recorded in schema-drift-baseline.sql with the reason it can never
-- be closed.
-- ---------------------------------------------------------------------------

-- The source pointer must agree with the declared source kind.
--
-- Stated over `sourceKind` and the OPTIONAL pointers being consistent WHEN
-- PRESENT — never "one of them must be non-null", which is the formulation that
-- would break `DELETE /api/email/accounts` via the Cascade→SetNull path.
-- `sourceRef` is NOT NULL by column definition and is what actually identifies
-- the source.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_source_pointer_matches_kind"
  CHECK (
    ("sourceKind" = 'FILE'  AND "emailMessageId" IS NULL)
    OR ("sourceKind" = 'EMAIL' AND "ncFileId" IS NULL)
  );

-- Confidence is a percentage or it is nothing.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_confidence_range"
  CHECK ("confidence" BETWEEN 0 AND 100);

-- A decision and its decider move together, in both directions — the
-- TeamChatMeetingReminderStatus shape, where a terminal state can never be
-- reached without the row that explains it.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_decided_has_actor"
  CHECK (
    ("status" IN ('APPLIED', 'REJECTED', 'NOT_SAME'))
    = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
  );

-- An undo names who undid it.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_undone_has_actor"
  CHECK (
    ("status" = 'UNDONE') = ("undoneById" IS NOT NULL AND "undoneAt" IS NOT NULL)
  );

-- 🔴 `NEVER` is unappliable IN THE DATABASE, not merely in a branch.
--
-- The policy table refuses these in code; this makes it true even if a future
-- route, a fixture or a hand-written UPDATE tries otherwise. A PHI-RECORD
-- source and an EXTERNAL-row write are the two cases that must not survive a
-- refactor of `services/filing/policy.ts`.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_never_is_unappliable"
  CHECK (NOT ("policyClass" = 'NEVER' AND "status" IN ('APPLIED', 'UNDONE')));

-- A verdict of RECORD is terminal before extraction, so it can never carry a
-- proposal that was applied, nor any stored evidence.
ALTER TABLE "IngestProposal"
  ADD CONSTRAINT "IngestProposal_record_verdict_never_applies"
  CHECK (NOT ("phiVerdict" = 'RECORD' AND ("status" = 'APPLIED' OR "evidence" IS NOT NULL)));

-- A rule that points at no customer is not a rule.
ALTER TABLE "FilingDecision"
  ADD CONSTRAINT "FilingDecision_company_required_by_verdict"
  CHECK (
    ("verdict" IN ('NOT_SAME', 'ALWAYS_HERE')) = ("companyId" IS NOT NULL)
  );

-- One live rule per (key, verdict[, company]).
--
-- Partial uniques rather than a compound `@@unique`, because a compound unique
-- over a NULLABLE column never collides in Postgres (NULL <> NULL) — the trap
-- WARP-2549's landing code hit, which is why it uses updateMany-then-create
-- with a P2002 retry instead of `upsert`.
CREATE UNIQUE INDEX "FilingDecision_ignore_source_key"
  ON "FilingDecision"("keyKind", "keyValue")
  WHERE "verdict" = 'IGNORE_SOURCE';

CREATE UNIQUE INDEX "FilingDecision_always_here_key"
  ON "FilingDecision"("keyKind", "keyValue", "companyId")
  WHERE "verdict" = 'ALWAYS_HERE';

CREATE UNIQUE INDEX "FilingDecision_not_same_key"
  ON "FilingDecision"("keyKind", "keyValue", "companyId")
  WHERE "verdict" = 'NOT_SAME';

-- Only one PENDING proposal may hold a given (kind, dedupeKey) at a time, so a
-- second document about the same customer offers to LINK to it rather than
-- minting a duplicate create. Decided rows are exempt — history accumulates.
CREATE UNIQUE INDEX "IngestProposal_pending_dedupe_key"
  ON "IngestProposal"("kind", "dedupeKey")
  WHERE "status" = 'PENDING';

-- The consent row is a singleton.
ALTER TABLE "AutoFilingSetting"
  ADD CONSTRAINT "AutoFilingSetting_is_singleton"
  CHECK ("id" = 'singleton');

-- 🔴 Consent is never half-recorded.
--
-- Unattended CRM writes are authorised by a person, and the row proving it must
-- name them and say when. A settings blob has no actor column and no way to
-- refuse a half-filled state; this does.
ALTER TABLE "AutoFilingSetting"
  ADD CONSTRAINT "AutoFilingSetting_enabled_has_actor"
  CHECK (
    ("mode" <> 'off') = ("enabledById" IS NOT NULL AND "enabledAt" IS NOT NULL)
  );

-- 🔴 `auto` is refused until the extraction canary has passed ON THIS BOX.
--
-- WARP-2732 is auto mode's own stated merge condition. PR #2005 set itself an
-- equivalent condition (a DMR grammar canary) and shipped without ever running
-- it; making this a database invariant rather than a checklist item is the
-- difference between a gate and a promise.
ALTER TABLE "AutoFilingSetting"
  ADD CONSTRAINT "AutoFilingSetting_auto_requires_canary"
  CHECK ("mode" <> 'auto' OR ("canaryPassedAt" IS NOT NULL AND "canaryModel" IS NOT NULL));

-- Caps are positive or the feature is unbounded by accident.
ALTER TABLE "AutoFilingSetting"
  ADD CONSTRAINT "AutoFilingSetting_caps_positive"
  CHECK ("hourlyApplyCap" > 0 AND "dailyCreateCap" > 0 AND "digestHour" BETWEEN 0 AND 23);

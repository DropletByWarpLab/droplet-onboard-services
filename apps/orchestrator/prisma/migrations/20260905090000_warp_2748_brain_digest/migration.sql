-- WARP-2748 (ADR-051 slice 1) -- `BrainDigest` + `BrainFinding`: the standing,
-- derived understanding of the business, and the actionable findings drawn
-- from it.
--
-- WHY THESE TABLES EXIST. The shipped context window is 16,384 tokens, a tool
-- result is capped at 8,000 chars by a Zod `.max(8000)` an operator cannot
-- raise, and the agent loop force-finalizes past 13,824 estimated tokens --
-- about 40-45 KB of readable text per turn, against a corpus five orders of
-- magnitude larger. A question therefore cannot scan the company. A scheduled
-- pass reads a little at a time and writes here; a question reads these rows.
--
-- WORKSPACE-WIDE, NO `workspaceId` COLUMN. `Workspace` is a singleton (id = 1)
-- and these follow the `MemoryFact` precedent, which is also workspace-wide
-- with no tenancy column. Visibility is `scope` + the reader's role.
--
-- NO FOREIGN KEY ON THE SUBJECT, deliberately -- the posture `EntityLink`
-- takes toward `File`, for its reason plus one more. Not every subject has a
-- local row (an obligation in a lease, a theme across twenty documents, a
-- project that is only a folder), and evidence outlives its subject: a deleted
-- deal's digest is still a true statement about what happened. A subject
-- pointer can dangle and the UI shows that; no column pretends to track
-- liveness, because a `subjectState` nothing maintains is a column that lies.

-- CreateEnum
CREATE TYPE "BrainDigestKind" AS ENUM ('entity', 'project', 'obligation', 'theme', 'metric', 'relationship');

-- CreateEnum
CREATE TYPE "BrainSubjectType" AS ENUM ('COMPANY', 'CONTACT', 'DEAL', 'PROJECT', 'WORK_ITEM', 'DOCUMENT', 'FILE');

-- CreateEnum
CREATE TYPE "BrainScope" AS ENUM ('personal', 'department', 'company');

-- CreateEnum
CREATE TYPE "BrainFindingKind" AS ENUM ('loss', 'risk', 'inefficiency', 'opportunity', 'inconsistency');

-- CreateEnum
CREATE TYPE "BrainFindingStatus" AS ENUM ('new', 'acknowledged', 'actioned', 'dismissed', 'stale');

-- CreateTable
CREATE TABLE "BrainDigest" (
    "id" TEXT NOT NULL,
    "kind" "BrainDigestKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1200) NOT NULL,
    "subjectType" "BrainSubjectType",
    "subjectId" TEXT,
    "sources" JSONB NOT NULL,
    "confidence" INTEGER,
    "scope" "BrainScope" NOT NULL DEFAULT 'personal',
    "departmentId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededById" TEXT,
    "detectorKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainFinding" (
    "id" TEXT NOT NULL,
    "kind" "BrainFindingKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "rationale" VARCHAR(2000) NOT NULL,
    "impactMinor" BIGINT,
    "currency" TEXT,
    "evidence" JSONB NOT NULL,
    "confidence" INTEGER,
    "status" "BrainFindingStatus" NOT NULL DEFAULT 'new',
    "dismissedReason" VARCHAR(500),
    "assigneeId" TEXT,
    "detectorKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "scope" "BrainScope" NOT NULL DEFAULT 'personal',
    "departmentId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- THE idempotency index. See the `dedupeKey` docstring in schema.prisma before
-- replacing this with a compound unique over (kind, subjectType, subjectId,
-- detectorKey): those subject columns are NULL on every theme-shaped row, and
-- Postgres never treats two rows as duplicates when an indexed column is NULL,
-- so a compound index would reject nothing and P2002 would never fire.
-- `EntityLink` hit exactly this and had to fall back on five PARTIAL unique
-- indexes, which `prisma.upsert` cannot address -- forcing an
-- updateMany-then-create retry at every call site. One NOT NULL derived column
-- makes the uniqueness real and keeps `upsert` usable, which is what an
-- idempotent nightly pass needs.
CREATE UNIQUE INDEX "BrainDigest_dedupeKey_key" ON "BrainDigest"("dedupeKey");
CREATE UNIQUE INDEX "BrainFinding_dedupeKey_key" ON "BrainFinding"("dedupeKey");

-- CreateIndex
-- `scope` LEADS the recency index: every read is already scope-filtered by the
-- reader's role, so the planner should narrow on scope before sorting.
CREATE INDEX "BrainDigest_kind_scope_idx" ON "BrainDigest"("kind", "scope");
CREATE INDEX "BrainDigest_subjectType_subjectId_idx" ON "BrainDigest"("subjectType", "subjectId");
CREATE INDEX "BrainDigest_scope_lastConfirmedAt_idx" ON "BrainDigest"("scope", "lastConfirmedAt" DESC);
CREATE INDEX "BrainDigest_departmentId_scope_idx" ON "BrainDigest"("departmentId", "scope");
CREATE INDEX "BrainDigest_detectorKey_idx" ON "BrainDigest"("detectorKey");

-- CreateIndex
-- `status, impactMinor DESC` serves the /brief default view: open findings,
-- biggest money first. `detectorKey, status` serves "switch off this noisy
-- detector and stale its open rows" without a sequential scan.
CREATE INDEX "BrainFinding_departmentId_status_idx" ON "BrainFinding"("departmentId", "status");
CREATE INDEX "BrainFinding_status_kind_idx" ON "BrainFinding"("status", "kind");
CREATE INDEX "BrainFinding_detectorKey_status_idx" ON "BrainFinding"("detectorKey", "status");
CREATE INDEX "BrainFinding_status_impactMinor_idx" ON "BrainFinding"("status", "impactMinor" DESC);
CREATE INDEX "BrainFinding_scope_status_idx" ON "BrainFinding"("scope", "status");

-- CreateIndex
-- WARP-845: Postgres does NOT index a foreign key for you, and a SetNull on an
-- unindexed FK is a sequential scan of this table per deleted user. Indexed at
-- birth, subject column leading so the same index serves "my open findings".
CREATE INDEX "BrainFinding_assigneeId_status_idx" ON "BrainFinding"("assigneeId", "status");

-- AddForeignKey
-- SetNull, NOT Cascade: removing a person must not delete the business's
-- findings. Provenance of the assignment is lost; the finding is not.
ALTER TABLE "BrainFinding" ADD CONSTRAINT "BrainFinding_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE, unlike the loose subject pointer above: `departmentId` is an
-- ACCESS-CONTROL key. A row naming a deleted department would fall through the
-- membership test that gates it, so this one must never dangle.
ALTER TABLE "BrainDigest" ADD CONSTRAINT "BrainDigest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrainFinding" ADD CONSTRAINT "BrainFinding_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2748: PROVENANCE IS NOT OPTIONAL, and this is the reason the tables are
-- worth having at all. A digest or a finding nobody can trace back to a source
-- is a hallucination that has been given a row id -- strictly worse than no
-- row, because it reads as fact, survives restarts, and gets prompt-injected
-- into later turns. Enforced HERE rather than in the service so that a
-- detector with a bug fails loudly at write time instead of quietly poisoning
-- the corpus. `jsonb_typeof` is checked too: `'[]'::jsonb` and `'{}'::jsonb`
-- are both valid JSON, and only one of them is an array.
ALTER TABLE "BrainDigest"
  ADD CONSTRAINT "BrainDigest_sources_not_empty"
  CHECK (jsonb_typeof("sources") = 'array' AND jsonb_array_length("sources") > 0);

ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_evidence_not_empty"
  CHECK (jsonb_typeof("evidence") = 'object' AND "evidence" ? 'sources'
    AND jsonb_typeof("evidence" -> 'sources') = 'array'
    AND jsonb_array_length("evidence" -> 'sources') > 0);

-- WARP-2748: confidence is a percentage or absent -- never 3000, never 0.85.
-- Integer 0-100 mirroring `EntityLink.confidence` and
-- `CrmPipelineStage.probability`. Two confidence scales in one schema is how a
-- 0.85 gets rendered as "85%" next to an 85 rendered as "8500%" -- the exact
-- bug WARP-859 shipped when a reranker logit reached the UI as ~1020%.
ALTER TABLE "BrainDigest"
  ADD CONSTRAINT "BrainDigest_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100));

ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 100));

-- WARP-2748: an impact and its currency are all-or-nothing -- the same shape
-- as `CrmDeal_amount_needs_currency`. A bare number is unrenderable and a bare
-- currency is noise. NULL for both is the supported state: a detector that
-- cannot compute an impact must leave it null rather than guess, because a
-- fabricated number is worse than no number.
ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_impact_needs_currency"
  CHECK (("impactMinor" IS NULL) = ("currency" IS NULL));

-- WARP-2748: a dismissal carries its reason. A finding dismissed with no
-- reason is indistinguishable from a detector bug, and the reason is the only
-- thing that lets the next pass tell "a human decided this is fine" from "this
-- has not been looked at" -- which is what stops it being re-raised next week.
-- One-directional on purpose: a reason may be recorded on a non-dismissed row
-- (an operator explaining an acknowledgement), but a dismissal without one is
-- rejected.
ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_dismissed_needs_reason"
  CHECK ("status" <> 'dismissed' OR "dismissedReason" IS NOT NULL);

-- WARP-2748: a `department`-scoped row names its department, and only a
-- department-scoped row may. Without the first half the reader check
-- ("is this person a member of THAT groupfolder") has nothing to ask about and
-- the scope is unenforceable -- an enum value nothing can enforce is the same
-- defect as a column nothing maintains. Without the second half a `company`
-- row could carry a stray departmentId that a later query filters on, silently
-- hiding it from the owner it was written for.
ALTER TABLE "BrainDigest"
  ADD CONSTRAINT "BrainDigest_department_scope_needs_id"
  CHECK (("scope" = 'department') = ("departmentId" IS NOT NULL));

ALTER TABLE "BrainFinding"
  ADD CONSTRAINT "BrainFinding_department_scope_needs_id"
  CHECK (("scope" = 'department') = ("departmentId" IS NOT NULL));

-- NOT ADDED, ON PURPOSE: a GIN index over `sources` / `evidence`. It would
-- serve "which digests cite this file", which is what a re-index or a delete
-- needs in order to stale the rows derived from that file -- but nothing
-- consumes that query yet, and an index nothing maintains a use for is
-- deadweight on every write. It lands with the invalidation path (WARP-2749),
-- not before.

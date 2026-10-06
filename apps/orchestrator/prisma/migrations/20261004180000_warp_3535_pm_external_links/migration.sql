-- WARP-3535 (ADR-069 §9, WS-18): the GitHub / GitLab development panel.
--
-- Additive only. Ordered AFTER 20261004175900_warp_3535_pm_activity_external_
-- link_added, which adds the `external_link_added` PmActivityVerb value on its
-- own: a value cannot be used in the transaction that adds it, and nothing here
-- names it, but the pair is ordered so a later slice can rely on it.
--
-- Three tables:
--   PmDevRepository         a repository an owner or admin chose to sync, with
--                           its explicit sync state and per-list ETags.
--   PmDevRepositoryProject  repository → PM project mapping, plus the optional
--                           "pull request opened / merged → move to state"
--                           rules.
--   PmExternalLink          a pull request, commit or branch whose text names a
--                           work item's key.

-- CreateEnum
CREATE TYPE "PmExternalProvider" AS ENUM ('GITHUB', 'GITLAB');

-- CreateEnum
CREATE TYPE "PmExternalLinkKind" AS ENUM ('PULL_REQUEST', 'COMMIT', 'BRANCH');

-- CreateEnum
CREATE TYPE "PmExternalLinkState" AS ENUM ('OPEN', 'MERGED', 'CLOSED', 'DRAFT');

-- CreateEnum
CREATE TYPE "PmDevSyncStatus" AS ENUM ('PENDING', 'OK', 'RATE_LIMITED', 'EGRESS_BLOCKED', 'NEEDS_RECONNECT', 'INACCESSIBLE', 'ERROR', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "PmDevRepository" (
    "id" TEXT NOT NULL,
    "provider" "PmExternalProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "apiRef" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "webUrl" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "status" "PmDevSyncStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "credentialSeal" TEXT,
    "openPrsEtag" TEXT,
    "recentPrsEtag" TEXT,
    "commitsEtag" TEXT,
    "branchesEtag" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmDevRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmDevRepositoryProject" (
    "repositoryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "onOpenedStateId" TEXT,
    "onMergedStateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmDevRepositoryProject_pkey" PRIMARY KEY ("repositoryId","projectId")
);

-- CreateTable
CREATE TABLE "PmExternalLink" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "provider" "PmExternalProvider" NOT NULL,
    "kind" "PmExternalLinkKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" "PmExternalLinkState" NOT NULL,
    "author" TEXT,
    "ref" TEXT,
    "number" INTEGER,
    "externalUpdatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmExternalLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PmDevRepository_nextSyncAt_idx" ON "PmDevRepository"("nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "PmDevRepository_provider_externalId_key" ON "PmDevRepository"("provider", "externalId");

-- CreateIndex
CREATE INDEX "PmDevRepositoryProject_projectId_idx" ON "PmDevRepositoryProject"("projectId");

-- CreateIndex
CREATE INDEX "PmDevRepositoryProject_onOpenedStateId_idx" ON "PmDevRepositoryProject"("onOpenedStateId");

-- CreateIndex
CREATE INDEX "PmDevRepositoryProject_onMergedStateId_idx" ON "PmDevRepositoryProject"("onMergedStateId");

-- CreateIndex
CREATE INDEX "PmExternalLink_workItemId_externalUpdatedAt_idx" ON "PmExternalLink"("workItemId", "externalUpdatedAt" DESC);

-- CreateIndex
CREATE INDEX "PmExternalLink_repositoryId_idx" ON "PmExternalLink"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "PmExternalLink_provider_kind_externalId_workItemId_key" ON "PmExternalLink"("provider", "kind", "externalId", "workItemId");

-- AddForeignKey
ALTER TABLE "PmDevRepositoryProject" ADD CONSTRAINT "PmDevRepositoryProject_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "PmDevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmDevRepositoryProject" ADD CONSTRAINT "PmDevRepositoryProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmDevRepositoryProject" ADD CONSTRAINT "PmDevRepositoryProject_onOpenedStateId_fkey" FOREIGN KEY ("onOpenedStateId") REFERENCES "PmState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmDevRepositoryProject" ADD CONSTRAINT "PmDevRepositoryProject_onMergedStateId_fkey" FOREIGN KEY ("onMergedStateId") REFERENCES "PmState"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmExternalLink" ADD CONSTRAINT "PmExternalLink_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "PmWorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmExternalLink" ADD CONSTRAINT "PmExternalLink_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "PmDevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── What Prisma cannot express, and the service relies on ────────────────────
-- Each of these has a case in src/__tests__/pm-external-link.pg.test.ts: a
-- mocked Prisma accepts every row they reject, so a green unit suite proves
-- nothing about them. `migrate diff` ignores CHECK constraints (the
-- PmWebhook_enabled_matches_status precedent), so none of this is drift.

-- The service validates an `apiRef` against the provider profile's pattern before
-- it is ever put in a URL. This is the floor under that: letters, digits and the
-- characters a repository path legitimately uses, and no `.` or `..` segment, so a
-- row written by anything that skips the service still cannot be turned into
-- `/repos/../../admin` by string concatenation.
ALTER TABLE "PmDevRepository" ADD CONSTRAINT "PmDevRepository_apiRef_safe"
    CHECK ("apiRef" ~ '^[A-Za-z0-9._/-]{1,200}$' AND "apiRef" !~ '(^|/)\.{1,2}(/|$)');

-- A link rendered as <a href> must not be a javascript: or data: URL. The
-- service refuses anything that is not https or not on the provider's own host;
-- this is the floor under that.
ALTER TABLE "PmDevRepository" ADD CONSTRAINT "PmDevRepository_webUrl_is_http"
    CHECK ("webUrl" ~* '^https?://');

ALTER TABLE "PmExternalLink" ADD CONSTRAINT "PmExternalLink_url_is_http"
    CHECK ("url" ~* '^https?://');

ALTER TABLE "PmDevRepository" ADD CONSTRAINT "PmDevRepository_consecutiveFailures_nonnegative"
    CHECK ("consecutiveFailures" >= 0);

-- `status` is the state and `lastSyncedAt` an audit timestamp pinned to it — the
-- PmWebhookDelivery_deliveredAt_matches_status shape. A repository that claims a
-- completed pass without a time for it is a bug somewhere upstream. Only one
-- direction: ERROR, RATE_LIMITED and the rest may carry an older time.
ALTER TABLE "PmDevRepository" ADD CONSTRAINT "PmDevRepository_ok_has_sync_time"
    CHECK ("status" <> 'OK' OR "lastSyncedAt" IS NOT NULL);

-- A commit on the default branch has landed; a branch exists or it does not. Only
-- a pull request has the whole vocabulary. Without this a COMMIT could sit at
-- DRAFT and the panel would render a pill that means nothing.
ALTER TABLE "PmExternalLink" ADD CONSTRAINT "PmExternalLink_state_matches_kind"
    CHECK (
        "kind" = 'PULL_REQUEST'
        OR ("kind" = 'COMMIT' AND "state" = 'MERGED')
        OR ("kind" = 'BRANCH' AND "state" IN ('OPEN', 'CLOSED'))
    );

ALTER TABLE "PmExternalLink" ADD CONSTRAINT "PmExternalLink_number_positive"
    CHECK ("number" IS NULL OR "number" > 0);

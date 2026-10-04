-- WARP-3532 (ADR-069 §7, §9): work webhooks and chat-app notifications, and the
-- index the PmActivity outbox consumers read through.
--
-- Additive only. Ordered AFTER 20261004155900_warp_3532_work_integrations_channel,
-- which adds the `work_integrations` OffLanChannelKey value on its own: a value
-- cannot be used in the transaction that adds it, and nothing here names it,
-- but the pair is ordered so a later slice that seeds against it can rely on it.

-- CreateEnum
CREATE TYPE "PmWebhookFormat" AS ENUM ('JSON', 'SLACK', 'TEAMS', 'DISCORD', 'GOOGLE_CHAT');

-- CreateEnum
CREATE TYPE "PmWebhookStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED_FAILING');

-- CreateEnum
CREATE TYPE "PmWebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'GIVEN_UP');

-- CreateTable
CREATE TABLE "PmWebhook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "format" "PmWebhookFormat" NOT NULL DEFAULT 'JSON',
    "secretEnc" TEXT NOT NULL,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "PmWebhookStatus" NOT NULL DEFAULT 'ACTIVE',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PmWebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "sourceKey" TEXT,
    "payload" JSONB NOT NULL,
    "status" "PmWebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "PmWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PmWebhook_workspaceId_enabled_idx" ON "PmWebhook"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "PmWebhook_projectId_idx" ON "PmWebhook"("projectId");

-- CreateIndex
CREATE INDEX "PmWebhookDelivery_webhookId_createdAt_idx" ON "PmWebhookDelivery"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PmWebhookDelivery_webhookId_sourceKey_key" ON "PmWebhookDelivery"("webhookId", "sourceKey");

-- CreateIndex: the outbox cursor's read — "rows after (createdAt, id), oldest
-- first, LIMIT n" (services/pm/pm-outbox.ts). Without it every consumer sweep is
-- a sequential scan plus a sort of the whole activity feed, several times a
-- minute, for the life of the box.
CREATE INDEX "PmActivity_createdAt_id_idx" ON "PmActivity"("createdAt", "id");

-- AddForeignKey
ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "PmWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PmProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PmWebhookDelivery" ADD CONSTRAINT "PmWebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "PmWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── What Prisma cannot express, and the service relies on ────────────────────
-- Each of these has a case in src/__tests__/pm-webhook.pg.test.ts: a mocked
-- Prisma accepts every row they reject, so a green unit suite proves nothing
-- about them. `migrate diff` ignores CHECK constraints and partial indexes
-- (the PmState_projectId_isDefault_key precedent), so none of this is drift.

-- `enabled` is the boolean a query can index on; `status` is the reason a person
-- reads (an owner paused it, or the box disabled it after repeated failures).
-- Two columns for one fact would eventually disagree, so the database holds them
-- together: delivering ⇔ ACTIVE.
ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_enabled_matches_status"
    CHECK ("enabled" = ("status" = 'ACTIVE'));

-- A webhook subscribed to nothing is a row that can never fire. Scalar lists are
-- nullable in SQL, so a bare cardinality() > 0 would let NULL through.
ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_events_not_empty"
    CHECK (coalesce(cardinality("events"), 0) > 0);

ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_consecutiveFailures_nonnegative"
    CHECK ("consecutiveFailures" >= 0);

-- The service guard (assertLanOrPublicUrl) is the real SSRF defence; this is the
-- floor under it, so a writer that skips the service still cannot store a
-- file: or gopher: URL for the delivery worker to be handed.
ALTER TABLE "PmWebhook" ADD CONSTRAINT "PmWebhook_url_is_http"
    CHECK ("url" ~* '^https?://');

-- `status` is the state and `deliveredAt` an audit timestamp pinned to it — the
-- PmActivity_notifiedAt_matches_status shape. A DELIVERED row without a time, or
-- a time on a row that was not delivered, is a bug somewhere upstream.
ALTER TABLE "PmWebhookDelivery" ADD CONSTRAINT "PmWebhookDelivery_deliveredAt_matches_status"
    CHECK (("status" = 'DELIVERED') = ("deliveredAt" IS NOT NULL));

ALTER TABLE "PmWebhookDelivery" ADD CONSTRAINT "PmWebhookDelivery_attempts_nonnegative"
    CHECK ("attempts" >= 0);

-- The delivery worker's claim scans only rows still owed an attempt. DELIVERED
-- and GIVEN_UP rows are the overwhelming majority of the table and none of them
-- is ever due, so they stay out of the index entirely.
CREATE INDEX "PmWebhookDelivery_due_idx" ON "PmWebhookDelivery" ("nextAttemptAt")
    WHERE "status" IN ('PENDING', 'FAILED');

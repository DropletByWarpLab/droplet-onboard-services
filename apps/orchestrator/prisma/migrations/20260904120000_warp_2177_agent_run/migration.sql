-- WARP-2177 — `AgentRun`: a background agent run that outlives the HTTP request
-- that started it (epic WARP-2176). Design: docs/agent-runs-design.md.
--
-- Generated with `prisma migrate diff --from-schema-datamodel <before>
-- --to-schema-datamodel <after> --script`, so the drift gate
-- (scripts/check-schema-drift.sh) sees an empty delta for this change.
--
-- `status` is an explicit enum — the CLAUDE.md "no guessing state" rule; a
-- row that was never transitioned to a terminal value must not read as done.
-- `messages` is the per-iteration checkpoint, `trace` the replay guard
-- (every dispatched tool call written BEFORE dispatch), `deadlineAt` the
-- wall-clock ceiling stamped at first claim. The two `status`-led indexes
-- serve the worker's claim scan (`queued AND runAfter <= now()`) and reclaim
-- scan (`running AND heartbeatAt < now() - threshold`).

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "goal" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'queued',
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxIter" INTEGER NOT NULL,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "messages" JSONB,
    "trace" JSONB,
    "result" TEXT,
    "stopReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_status_runAfter_idx" ON "AgentRun"("status", "runAfter");

-- CreateIndex
CREATE INDEX "AgentRun_status_heartbeatAt_idx" ON "AgentRun"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "AgentRun_userId_createdAt_idx" ON "AgentRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AgentRun_sessionId_idx" ON "AgentRun"("sessionId");


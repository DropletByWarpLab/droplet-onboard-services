-- WARP-2180 — `AgentRunSchedule`: a recurring background run on the one
-- sanctioned clock (epic WARP-2176). Design: docs/agent-runs-design.md §8.
--
-- Generated with `prisma migrate diff`; the drift gate sees an empty delta.
-- Same RRULE + timezone vocabulary as ToolSchedule / SceneSchedule; the
-- agent-run-schedule ticker enqueues an AgentRun per fire, attributed to
-- `userId`, whose reach is re-resolved at claim time.

-- CreateTable
CREATE TABLE "AgentRunSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "maxIter" INTEGER NOT NULL,
    "rrule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "nextFireAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRunSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRunSchedule_enabled_nextFireAt_idx" ON "AgentRunSchedule"("enabled", "nextFireAt");

-- CreateIndex
CREATE INDEX "AgentRunSchedule_userId_createdAt_idx" ON "AgentRunSchedule"("userId", "createdAt" DESC);


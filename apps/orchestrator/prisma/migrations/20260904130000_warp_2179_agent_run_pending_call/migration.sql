-- WARP-2179 — the parked Tier-2 call on `AgentRun` (epic WARP-2176).
-- Design: docs/agent-runs-design.md §7.
--
-- Generated with `prisma migrate diff` from the schema delta, so the drift
-- gate sees an empty new delta.
--
-- A background run that reaches a confirming tool is PARKED (status
-- `awaiting_confirmation`), never auto-confirmed: the user authorised a goal,
-- not each destructive act the model later chose. The pending call is bound
-- the way the interceptor binds its token — tool name + the canonical
-- argument hash — in explicit columns rather than a blob, so what the human
-- approves is exactly what is redeemed. No token is stored: the interceptor
-- mints one at resume, seconds after the decision, and it is redeemed in the
-- same breath. `parkedAt` lets the resume extend `deadlineAt` by the time
-- spent parked, so a day waiting for a human is not a day of wall clock.

-- CreateEnum
CREATE TYPE "AgentRunPendingDecision" AS ENUM ('approved', 'denied');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "parkedAt" TIMESTAMP(3),
ADD COLUMN     "pendingArgs" JSONB,
ADD COLUMN     "pendingBindingHash" TEXT,
ADD COLUMN     "pendingDecidedAt" TIMESTAMP(3),
ADD COLUMN     "pendingDecidedBy" TEXT,
ADD COLUMN     "pendingDecision" "AgentRunPendingDecision",
ADD COLUMN     "pendingTool" TEXT,
ADD COLUMN     "pendingToolCallId" TEXT;


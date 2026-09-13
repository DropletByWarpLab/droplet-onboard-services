-- WARP-2877 — a recurring run needs to know WHICH schedule fired it.
--
-- The agent-run-schedule ticker enqueued a run and advanced `nextFireAt` on
-- every due tick with no idea whether the previous fire had finished. A daily
-- sweep that takes ninety minutes on a busy box, or one parked on a Tier-2
-- approval nobody has answered yet, therefore accumulated overlapping runs:
-- each one claimed an inference slot, and two copies of the same goal
-- competed over the same files. Nothing in the schema could even ask the
-- question — `AgentRun` carried no link back to its schedule.
--
-- This column is that link, and the ticker's guard reads it: a schedule with
-- a run still in `queued`, `running` or `awaiting_confirmation` skips this
-- fire, advances `nextFireAt` anyway (the slot passed; it is not owed) and
-- logs it once.
--
-- Additive and nullable. NULL is the ordinary case — a run started from chat
-- has no schedule — and it is an absent FOREIGN KEY, not a status inferred
-- from absence: the run's own state stays in the `status` enum where the
-- repo's rule requires it.
--
-- `ON DELETE SET NULL`, not CASCADE. Deleting a recurring run from the
-- dashboard must not delete the audit trail of what it already did; the runs
-- survive, orphaned but intact, and the guard simply stops matching them.

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "scheduleId" TEXT;

-- CreateIndex
-- The guard runs once per due schedule per tick; without this it is a
-- sequential scan of every run the box has ever recorded.
CREATE INDEX "AgentRun_scheduleId_status_idx" ON "AgentRun"("scheduleId", "status");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "AgentRunSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

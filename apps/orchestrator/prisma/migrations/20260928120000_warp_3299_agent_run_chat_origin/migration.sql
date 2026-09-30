-- WARP-3299 — link a chat-started background run to the conversation, message
-- and tool call that started it, and give every run an explicit origin.
CREATE TYPE "AgentRunOrigin" AS ENUM ('workshop', 'schedule', 'chat');
CREATE TYPE "AgentRunResultDelivery" AS ENUM ('not_applicable', 'pending', 'delivered', 'failed');

ALTER TABLE "AgentRun"
  ADD COLUMN "origin" "AgentRunOrigin" NOT NULL DEFAULT 'workshop',
  ADD COLUMN "originMessageId" TEXT,
  ADD COLUMN "originToolCallId" TEXT,
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "deliverable" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "summary" VARCHAR(2000),
  ADD COLUMN "artifacts" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "resultDelivery" "AgentRunResultDelivery" NOT NULL DEFAULT 'not_applicable';

-- Backfill: a run a schedule fired is a schedule run; every earlier run came
-- from the Workshop (the start_agent_run tool never recorded a session, so
-- no existing row can be proven to be a chat run).
UPDATE "AgentRun" SET "origin" = 'schedule' WHERE "scheduleId" IS NOT NULL;
UPDATE "AgentRun" SET "title" = LEFT(SPLIT_PART("goal", E'\n', 1), 120);

-- Origin is explicit from here on: every creator must say which it is.
ALTER TABLE "AgentRun" ALTER COLUMN "origin" DROP DEFAULT;

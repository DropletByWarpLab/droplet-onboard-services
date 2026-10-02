-- WARP-3300 — a background run started from chat posts its result back into
-- that conversation as one message of its own kind.
CREATE TYPE "ChatMessageKind" AS ENUM ('message', 'agent_run_result');

ALTER TABLE "ChatMessage"
  ADD COLUMN "kind" "ChatMessageKind" NOT NULL DEFAULT 'message',
  ADD COLUMN "meta" JSONB;

-- The conversation was deleted before the result could be posted.
ALTER TYPE "AgentRunResultDelivery" ADD VALUE 'conversation_gone';

ALTER TABLE "AgentRun"
  ADD COLUMN "resultDeliveryAttempts" INTEGER NOT NULL DEFAULT 0;

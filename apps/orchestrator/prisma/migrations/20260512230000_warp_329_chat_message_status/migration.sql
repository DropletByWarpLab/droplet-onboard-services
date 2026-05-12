-- WARP-329: save-on-send for chat. The user message is persisted as soon
-- as the route receives it; the assistant message is created with
-- status=streaming BEFORE the LLM runs and transitions to completed /
-- failed / aborted when the agent loop terminates.
--
-- Existing rows pre-WARP-329 are all "completed" by definition (they
-- only landed once `persistTurn` had finished). Defaulting the column
-- to completed makes the migration non-breaking.

CREATE TYPE "ChatMessageStatus" AS ENUM ('pending', 'streaming', 'completed', 'failed', 'aborted');

ALTER TABLE "ChatMessage"
  ADD COLUMN "status"      "ChatMessageStatus" NOT NULL DEFAULT 'completed',
  ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill `completedAt` for pre-WARP-329 rows so the timestamp is at
-- least monotonic with createdAt. We don't know the exact completion
-- time historically; createdAt is the best available proxy.
UPDATE "ChatMessage" SET "completedAt" = "createdAt" WHERE "completedAt" IS NULL;

CREATE INDEX "ChatMessage_sessionId_status_idx"
  ON "ChatMessage"("sessionId", "status");

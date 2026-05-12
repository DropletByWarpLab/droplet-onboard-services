-- WARP-304: persistent per-user chat sessions for the /chat page.
--
-- ChatSession gets userId + title + updatedAt + an index for the listing
-- query. Existing rows (if any) are backfilled with userId='legacy' so
-- they survive the migration — these would be from the pre-WARP-104 era
-- and aren't surfaced anywhere today.
--
-- ChatMessage gets toolCalls (jsonb) + toolCallId + turnId so a
-- rehydrated thread can render the same tool-call chips the user saw
-- live, plus an idempotency key for retried turns.

-- ChatSession: relax model/provider, add userId/title/updatedAt
ALTER TABLE "ChatSession"
  ALTER COLUMN "model" DROP NOT NULL,
  ALTER COLUMN "provider" DROP NOT NULL,
  ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "title" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Drop the default once existing rows are backfilled; new rows must
-- supply userId explicitly.
ALTER TABLE "ChatSession" ALTER COLUMN "userId" DROP DEFAULT;

CREATE INDEX "ChatSession_userId_updatedAt_idx"
  ON "ChatSession"("userId", "updatedAt" DESC);

-- ChatMessage: add tool-call columns + turnId
ALTER TABLE "ChatMessage"
  ADD COLUMN "toolCalls"  JSONB,
  ADD COLUMN "toolCallId" TEXT,
  ADD COLUMN "turnId"     TEXT;

CREATE INDEX "ChatMessage_sessionId_createdAt_idx"
  ON "ChatMessage"("sessionId", "createdAt");
CREATE INDEX "ChatMessage_sessionId_turnId_idx"
  ON "ChatMessage"("sessionId", "turnId");

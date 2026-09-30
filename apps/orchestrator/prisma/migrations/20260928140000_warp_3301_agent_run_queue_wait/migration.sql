-- WARP-3301 — why a queued run is waiting: behind the queue, or yielded to
-- interactive chat. Existing rows are all `queue`: no yield was recorded
-- before this column, and a yielded row re-queues as `queue` on its next
-- transition anyway.
CREATE TYPE "AgentRunQueueWait" AS ENUM ('queue', 'chat');

ALTER TABLE "AgentRun"
  ADD COLUMN "queueWait" "AgentRunQueueWait" NOT NULL DEFAULT 'queue';

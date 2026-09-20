-- WARP-2837 (ADR-051) — the corpus pass gets a LEASE, because it cannot run
-- inside a transaction.
--
-- The pass was registered with cron-runtime's `lockKey`, which executes the
-- handler inside `prisma.$transaction(..., { timeout: 60_000 })`. The handler
-- makes up to ten sequential model calls on a box with ONE inference slot and
-- no turn-level timeout. Ten CPU inferences do not fit in sixty seconds, and
-- when the transaction expired the advisory lock was released MID-RUN while
-- the pass carried on — its writes go through the outer client, so they had
-- already committed out of band, and the eventual commit threw P2028 into the
-- cron runtime's error path on a pass that was partly succeeding.
--
-- `agent-run-worker.service.ts` reached this conclusion first, for the same
-- reason, and says so: the transaction-scoped lock is "exactly right for a
-- tick and exactly wrong for a forty-minute run". Its answer is the one
-- copied here — the tick CLAIMS and the work executes outside it.
--
-- So exclusion moves off the advisory lock and onto these columns. A
-- conditional UPDATE ... WHERE (runState = 'idle' OR heartbeatAt < cutoff)
-- either affects one row or it does not; that count IS the exclusion, it is
-- atomic in Postgres without any surrounding transaction, and it holds across
-- replicas — which the process-local alternatives do not.
--
-- `runState` is an explicit enum rather than `claimedAt IS NOT NULL`. That is
-- the repo's standing rule, and here it is load-bearing rather than stylistic:
-- a nullable timestamp cannot distinguish a live run from one whose process
-- was killed, and telling those apart is the entire purpose of the lease.

-- CreateEnum
CREATE TYPE "BrainPassRunState" AS ENUM ('idle', 'running');

-- AlterTable
ALTER TABLE "BrainPass" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "runState" "BrainPassRunState" NOT NULL DEFAULT 'idle';

-- CreateIndex
CREATE INDEX "BrainPass_runState_heartbeatAt_idx" ON "BrainPass"("runState", "heartbeatAt");

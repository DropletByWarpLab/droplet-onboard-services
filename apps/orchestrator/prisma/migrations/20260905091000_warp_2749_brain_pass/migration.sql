-- WARP-2749 (ADR-051 slice 2) -- `BrainPass`: the durable position of a brain
-- pass, and the coverage counters `/brief` renders.
--
-- ONE ROW PER PASS, and the row IS the cursor. A pass works from `cursor`
-- forward and writes the new position back in the SAME transaction as the rows
-- it produced, so a crash mid-pass re-digests at most one unit and never skips
-- one. There is deliberately no window in which the cursor has advanced but the
-- output has not landed.
--
-- NOT A SECOND SCHEDULER. The repo has exactly one clock (`cronRuntime`, with
-- transaction-scoped pg advisory locks) and a guard test pins that. This table
-- is a bookmark the passes read; the tick that drives them is registered
-- alongside every other tick in index.ts.
--
-- NOT AN `AgentRun` EITHER. AgentRun is a durable LLM conversation with a
-- lease, a heartbeat and an iteration budget. The detector pass makes no model
-- call at all, so an AgentRun would buy it a lease it does not need and an
-- inference slot it must not hold -- the box runs ONE inference at a time
-- (scheduler max_concurrent=1) and a detector sweep must never be what is
-- holding it.

-- CreateTable
CREATE TABLE "BrainPass" (
    "passKey" TEXT NOT NULL,
    "cursor" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastError" VARCHAR(1000),
    "unitsSeen" INTEGER NOT NULL DEFAULT 0,
    "unitsDigested" INTEGER NOT NULL DEFAULT 0,
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrainPass_pkey" PRIMARY KEY ("passKey")
);

-- CreateIndex
-- The tick reads "which passes are enabled" on every fire.
CREATE INDEX "BrainPass_enabled_idx" ON "BrainPass"("enabled");

-- ── Invariants Prisma's schema language cannot express ──────────────────────

-- WARP-2749: counters are cumulative and can only ever have been incremented.
-- A negative count means a decrement crept into a path that should only add,
-- and it would silently corrupt the coverage line `/brief` shows -- which is
-- the one thing standing between an operator and the assumption that the brain
-- has read everything.
ALTER TABLE "BrainPass"
  ADD CONSTRAINT "BrainPass_counters_non_negative"
  CHECK ("unitsSeen" >= 0 AND "unitsDigested" >= 0 AND "rowsWritten" >= 0);

-- WARP-2749: a pass that has succeeded has also run. `lastSucceededAt` without
-- `lastRunAt` is a row that claims an outcome for an attempt it never recorded,
-- and every freshness check reads one or the other.
ALTER TABLE "BrainPass"
  ADD CONSTRAINT "BrainPass_succeeded_implies_ran"
  CHECK ("lastSucceededAt" IS NULL OR "lastRunAt" IS NOT NULL);

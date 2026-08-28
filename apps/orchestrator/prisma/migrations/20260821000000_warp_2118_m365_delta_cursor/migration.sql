-- WARP-2118 / ADR-041 — per-resource delta cursors for the Microsoft 365
-- sync engine.
--
-- The box has no inbound path, so Graph change-notification subscriptions
-- (which require a public HTTPS endpoint) are unavailable and delta-query
-- polling is the sync mechanism by design. Each cursor holds one
-- `@odata.deltaLink`, stored opaquely and replayed verbatim.
--
-- Grain: one row per (person, workload, resource). Mail delta is a PER-FOLDER
-- operation, so a mailbox with ten folders has ten cursors.
--
-- `state` is explicit and never inferred from `deltaLink IS NULL` — IDLE with
-- no link (never synced) and RESYNC_REQUIRED (token died, re-enumerate) share
-- that shape while meaning opposite things.

-- CreateEnum
CREATE TYPE "M365SyncState" AS ENUM (
  'IDLE',
  'SYNCING',
  'BACKOFF',
  'RESYNC_REQUIRED',
  'FAILED'
);

-- CreateTable
CREATE TABLE "M365DeltaCursor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workload" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    -- The full @odata.deltaLink. Opaque; never reconstructed by hand.
    "deltaLink" TEXT,
    "state" "M365SyncState" NOT NULL DEFAULT 'IDLE',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "M365DeltaCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "M365DeltaCursor_userId_workload_resourceId_key"
  ON "M365DeltaCursor"("userId", "workload", "resourceId");

-- CreateIndex — the scheduler's "what is due now" query.
CREATE INDEX "M365DeltaCursor_state_nextAttemptAt_idx"
  ON "M365DeltaCursor"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "M365DeltaCursor_userId_idx" ON "M365DeltaCursor"("userId");

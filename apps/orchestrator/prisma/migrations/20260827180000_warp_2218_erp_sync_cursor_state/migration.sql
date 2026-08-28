-- WARP-2218 / ADR-041 — scheduling state for the connector sync poller.
--
-- `ErpSyncCursor` shipped with WARP-1094 and has had ZERO writers ever since:
-- the only references in source were three connector docstrings explaining why
-- each track deliberately did not become the first one. This migration gives it
-- the columns a poller needs, and WARP-2218 gives it its first writers.
--
-- `state` is explicit and never inferred from `watermark IS NULL` — IDLE with
-- no watermark (never synced) and RESYNC_REQUIRED (a position existed and the
-- vendor stopped honouring it) share that shape while meaning opposite things.
-- Same reasoning as M365SyncState (20260821000000_warp_2118_m365_delta_cursor),
-- and this enum is modelled member-for-member on it.
--
-- `needsReconnect` is its own column rather than an IntegrationStatus value:
-- ADR-041 treats a revoked customer credential as ROUTINE — the product asks
-- the owner to paste a new one, it does not raise an incident — so collapsing
-- it onto ERROR would tell an owner their connection is broken when the only
-- thing wrong is a credential they can replace in thirty seconds.

-- CreateEnum
CREATE TYPE "ErpSyncState" AS ENUM (
  'IDLE',
  'SYNCING',
  'BACKOFF',
  'RESYNC_REQUIRED',
  'FAILED'
);

-- AlterTable
--
-- `watermark` becomes nullable so "never synced" has a representation that is
-- not an empty string pretending to be a position. Safe to drop the NOT NULL:
-- the table has no writers, so it has no rows to violate anything, and
-- widening a constraint never rejects existing data in any case.
ALTER TABLE "ErpSyncCursor" ALTER COLUMN "watermark" DROP NOT NULL;

ALTER TABLE "ErpSyncCursor" ADD COLUMN "state" "ErpSyncState" NOT NULL DEFAULT 'IDLE';
ALTER TABLE "ErpSyncCursor" ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ErpSyncCursor" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "ErpSyncCursor" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
ALTER TABLE "ErpSyncCursor" ADD COLUMN "lastSweepAt" TIMESTAMP(3);
ALTER TABLE "ErpSyncCursor" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;
-- Never a token, an API key, a page cursor, or raw bearer material.
ALTER TABLE "ErpSyncCursor" ADD COLUMN "lastError" TEXT;
ALTER TABLE "ErpSyncCursor" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex — the scheduler's "what is due now" query.
CREATE INDEX "ErpSyncCursor_state_nextAttemptAt_idx"
  ON "ErpSyncCursor"("state", "nextAttemptAt");

-- CreateIndex — the sweep enumerates every cursor for one connection.
CREATE INDEX "ErpSyncCursor_connectionId_idx" ON "ErpSyncCursor"("connectionId");

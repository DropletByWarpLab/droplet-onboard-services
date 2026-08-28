-- WARP-2463 / ADR-041 — persist the reconciliation sweep's drift report.
--
-- WARP-2218 (20260827180000_warp_2218_erp_sync_cursor_state) built the sweep
-- and the drift report it emits. The report reached a log line and an
-- ActivityRow scope and was stored NOWHERE, so the one question the sweep
-- exists to answer — has the incremental path been trustworthy for this
-- vendor, and is it getting better or worse — had no queryable answer. Log
-- retention on the box is not designed as a data store.
--
-- This is a SECOND migration stacked on WARP-2218's: it depends on nothing
-- that migration created (no shared table, no shared enum), but it is
-- authored against a schema that already contains it, so it must be applied
-- after it. The timestamp prefix orders them.
--
-- ## Why the classification is one column with four members
--
-- `reconcile.ts` emits two INDEPENDENT drift classes and both can fire on the
-- same pass. The model stores one row per (connection, entity) per sweep, so
-- a single column has to be able to say "both" — hence the enumerated
-- co-occurrence rather than a nullable second column a reader could combine
-- wrongly (or forget to read at all).
--
-- `NONE` is a real member, not the absence of a row. Every sweep writes a row
-- for every entity it swept, INCLUDING a clean one. Absence must never be the
-- signal: "the sweep found nothing" and "the sweep never ran" are opposite
-- answers, and a table that only records misses cannot tell them apart —
-- which would make the drift-free-streak the sweep cadence is tuned from
-- unreadable, and would break this repo's no-guessing-state rule.
--
-- ## Why the two markers are TIMESTAMP and not TEXT
--
-- `ErpSyncCursor.watermark` is TEXT because it holds the vendor's own
-- ordering token verbatim. Copying that token into this table would be a
-- customer-content leak waiting for the first vendor whose ordering key is
-- the record id — Stripe cursors ARE object ids. Storing a parsed timestamp
-- (and NULL for a marker that is not one) makes the PHI-free rule structural:
-- there is no column in this table an invoice number can reach.

-- CreateEnum
CREATE TYPE "ErpDriftClassification" AS ENUM (
  'NONE',
  'MISSED_NEWER',
  'WATERMARK_BEHIND',
  'MISSED_NEWER_AND_WATERMARK_BEHIND'
);

-- CreateTable
--
-- No foreign key to "IntegrationConnection", matching "ErpSyncCursor": adding
-- one would mean a back-relation on that model and an ON DELETE decision this
-- story does not own. Retention trims by age, so an orphaned row from a
-- deleted connection ages out on the same schedule as every other row.
--
-- "classification" carries NO DEFAULT on purpose. Every writer states what it
-- found, so a row can never mean "nobody set this" — a default would let a
-- future partial insert silently claim a clean sweep.
CREATE TABLE "ErpDriftRecord" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "sweepAt" TIMESTAMP(3) NOT NULL,
  "classification" "ErpDriftClassification" NOT NULL,
  "missedCount" INTEGER NOT NULL DEFAULT 0,
  "fullCount" INTEGER NOT NULL DEFAULT 0,
  "incrementalCount" INTEGER NOT NULL DEFAULT 0,
  "watermarkAt" TIMESTAMP(3),
  "earliestMissedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ErpDriftRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the read endpoint's query: one connection, newest first,
-- over a window. Also the index the drift-free-streak walk rides.
CREATE INDEX "ErpDriftRecord_connectionId_sweepAt_idx"
  ON "ErpDriftRecord"("connectionId", "sweepAt");

-- CreateIndex — the retention trim, and the only query that scans across
-- connections. Without it the nightly trim seq-scans a table that grows by
-- (connections x entities) rows per sweep forever.
CREATE INDEX "ErpDriftRecord_sweepAt_idx" ON "ErpDriftRecord"("sweepAt");

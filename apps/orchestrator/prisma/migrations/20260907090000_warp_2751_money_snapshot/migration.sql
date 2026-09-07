-- WARP-2751 (ADR-051) — MoneySnapshot: the time axis money never had.
--
-- `land-money.ts` overwrites `amount`, `balance` and `vendorStatus` on
-- `ErpDocument` IN PLACE on every sync tick. At the shipped 15-minute cadence
-- that destroys yesterday ninety-six times a day, and there is no history
-- table anywhere in the product. Ageing, DSO drift, "our overdue balance has
-- doubled since June" and "which customers slowed down" are not hard questions
-- against this schema — they are unanswerable ones.
--
-- The DDL below is `prisma migrate diff --from-empty --to-schema-datamodel`
-- output for this table, copied verbatim rather than hand-written, so the
-- migration and the datamodel cannot disagree about a type or an index name.
--
-- ── The unique key is the whole design ───────────────────────────────────────
--
-- `(capturedOn, subjectType, subjectId)` is what makes a 15-minute writer
-- produce ONE row per day instead of ninety-six near-duplicates. The write is
-- an upsert against it, so the row converges on the day's LAST-SEEN value.
--
-- `capturedOn` is DATE and not a timestamp deliberately: the grain IS one day.
-- A timestamp would let two rows for the same day differ in the key and the
-- idempotency would silently stop holding — the failure would look like a
-- storage-growth problem months later, not like a bug.
--
-- ── No foreign key to ErpDocument, on purpose ────────────────────────────────
--
-- A snapshot must OUTLIVE the document it describes. With a FK (even SET NULL)
-- the series would end the moment a vendor deletes an invoice, which is
-- precisely the history worth keeping — "it was worth $40,000 for ninety days
-- and then it vanished" is the shape of the loss this table exists to make
-- visible. `subjectId` is therefore a plain column.
--
-- ── No workspaceId, despite the ticket proposing one ─────────────────────────
--
-- This schema has no tenancy concept: `workspaceId` appears on `PmProject`
-- alone. Adding a second, unenforced one here would create a column every
-- future query must remember to filter and no constraint would ever check —
-- the same "unenforceable scope" shape WARP-2748 had to fix with a CHECK after
-- shipping it. `subjectId` is a uuid, so the key above is complete without it.

-- CreateTable
CREATE TABLE "MoneySnapshot" (
    "id" TEXT NOT NULL,
    "capturedOn" DATE NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "amount" DECIMAL(20,6),
    "balance" DECIMAL(20,6),
    "currency" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "the 90-day series for this document" — the query the table exists to serve,
-- and the one the retention downsample scans.
CREATE INDEX "MoneySnapshot_subjectType_subjectId_capturedOn_idx" ON "MoneySnapshot"("subjectType", "subjectId", "capturedOn");

-- CreateIndex
-- Retention sweeps by date across every subject.
CREATE INDEX "MoneySnapshot_capturedOn_idx" ON "MoneySnapshot"("capturedOn");

-- CreateIndex
CREATE UNIQUE INDEX "MoneySnapshot_capturedOn_subjectType_subjectId_key" ON "MoneySnapshot"("capturedOn", "subjectType", "subjectId");

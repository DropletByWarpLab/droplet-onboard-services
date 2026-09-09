-- WARP-2581 — `ErpDocument`, the first money this box keeps.
--
-- Until now the only money in the product was a single accounts-receivable
-- number on /reports, read live from the practice's server every time someone
-- looked at it. It could not say by whom, since when, or what the business
-- OWES, and it vanished the moment that server was off, because nothing was
-- stored. Meanwhile four cloud accounting tracks serve `invoice` and `bill`,
-- the scheduler reads them on a cadence (WARP-2509) and WARP-2549 built the
-- seam that lands what it reads.
--
-- 🔴 CLOUD ACCOUNTING TRACKS ONLY. A LAN practice-management track that
-- declares `invoice` must never land here — its receivables are a patient
-- ledger, and PHI on this box is read-through behind the ERP router's own gate
-- (ADR-044 §3). The refusal lives in `land-money.ts` and is pinned by a test.
--
-- 🔴 `amount` and `balance` are DIFFERENT NUMBERS. An invoice part-paid still
-- carries its original amount, so summing amounts where you meant balances
-- overstates receivables — the error that produces a confident, wrong figure
-- on a page about money.
--
-- 🔴 EXACT DECIMALS, not minor units, and the difference is forced. `CrmDeal`
-- holds minor units because a deal's currency is always known, so its exponent
-- is. A ledger document's is not: `invoice` and `bill` are named in
-- `SINGLE_CURRENCY_LEDGER_DATASETS` and exempt from the
-- money-needs-a-currency rule, because a QuickBooks company file has one home
-- currency and its export carries no per-row currency column. Minor units
-- cannot be computed without an exponent, and assuming 2 is wrong by a factor
-- of 100 on a yen ledger. NUMERIC(20,6) holds any vendor decimal exactly and
-- sums exactly; it crosses the API as a string.
--
-- Provenance is NOT NULL, unlike the CRM tables that took it in the same
-- story: every row here is landed by definition, so there is no locally typed
-- shape to leave room for.

CREATE TYPE "ErpDocumentKind" AS ENUM ('RECEIVABLE', 'PAYABLE');

CREATE TABLE "ErpDocument" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "externalSystem" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "kind" "ErpDocumentKind" NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "counterpartyExternalId" TEXT,
    "companyId" TEXT,
    "counterpartyName" TEXT,
    "amount" DECIMAL(20,6),
    "balance" DECIMAL(20,6),
    "currency" TEXT,
    "status" TEXT,
    "vendorUpdatedAt" TIMESTAMP(3),
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErpDocument_pkey" PRIMARY KEY ("id")
);

-- The reconcile key. Scoped to the CONNECTION and to the KIND: two QuickBooks
-- companies both number their invoices from 1, and an invoice and a bill can
-- carry the same vendor id in different ledgers.
CREATE UNIQUE INDEX "ErpDocument_connectionId_kind_externalId_key"
  ON "ErpDocument"("connectionId", "kind", "externalId");

-- "What is overdue", per connection and across all of them.
CREATE INDEX "ErpDocument_connectionId_kind_dueAt_idx" ON "ErpDocument"("connectionId", "kind", "dueAt");
CREATE INDEX "ErpDocument_kind_dueAt_idx" ON "ErpDocument"("kind", "dueAt");
-- WARP-845: an `ON DELETE SET NULL` key that is not indexed makes the delete a
-- sequential scan of this table.
CREATE INDEX "ErpDocument_companyId_idx" ON "ErpDocument"("companyId");

ALTER TABLE "ErpDocument" ADD CONSTRAINT "ErpDocument_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SetNull, not Cascade: losing the customer must not lose the invoice. The
-- money is owed whether or not the CRM still has a row for who owes it.
ALTER TABLE "ErpDocument" ADD CONSTRAINT "ErpDocument_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "CrmCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A currency, when the vendor names one, is an ISO-4217 alpha-3 code and
-- nothing else. NULL is a legitimate value here and means "this ledger's own
-- home currency", which is why there is no money-needs-a-currency CHECK on
-- this table — see the note above. The consequence lives in the service: a
-- total may be computed per connection, never across connections, because
-- unknown behaves exactly like mixed.
ALTER TABLE "ErpDocument" ADD CONSTRAINT "ErpDocument_currency_iso4217" CHECK (
  "currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'
);

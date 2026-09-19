-- WARP-2739 (ADR-049 §4.1) — widen `ErpDocument` from a landed-only vendor copy
-- into the box's own document table.
--
-- ── Why now, and not after ─────────────────────────────────────────────────
--
-- 🔴 `ErpDocument` HAS NEVER SHIPPED TO `main`. WARP-2581 built it on `stage`
-- and PR #1798 has not promoted. So every statement below runs over an EMPTY
-- table on every customer box today. The same change made after that promotion
-- is a data migration over a business's live ledger, and the enum rewrite in
-- particular would have to be done with the money on the table.
--
-- The enum map is still written out, and still runs, because a bench box that
-- landed rows from a sandbox connection has data this must not corrupt:
--
--     RECEIVABLE -> INVOICE      money owed TO the business
--     PAYABLE    -> BILL         money owed BY the business
--
-- ── The old enum was a direction, not a kind ───────────────────────────────
--
-- `RECEIVABLE | PAYABLE` cannot tell a quote from an invoice, and both are
-- receivable. A credit note is receivable and negative. Direction is now
-- DERIVED from kind in `money.service.ts` — the one place it was ever needed,
-- and the only place that stays correct as kinds are added.
--
-- ── Postgres will not add a value to an enum used in the same transaction ──
--
-- `ALTER TYPE ... ADD VALUE` cannot be used in the statement that reads it, so
-- the six-value type is created FRESH and swapped in with a USING cast. That
-- also gives the rename for free and leaves no unreachable values behind: an
-- `ADD VALUE`-based path would leave `RECEIVABLE` and `PAYABLE` in the type
-- forever, readable by anything that types a literal.

-- ── 1. The kind enum, rebuilt ──────────────────────────────────────────────

CREATE TYPE "ErpDocumentKind_new" AS ENUM (
  'QUOTE', 'ORDER', 'INVOICE', 'BILL', 'CREDIT_NOTE', 'RECEIPT'
);

ALTER TABLE "ErpDocument"
  ALTER COLUMN "kind" TYPE "ErpDocumentKind_new"
  USING (
    CASE "kind"::text
      WHEN 'RECEIVABLE' THEN 'INVOICE'
      WHEN 'PAYABLE'    THEN 'BILL'
    END
  )::"ErpDocumentKind_new";

DROP TYPE "ErpDocumentKind";
ALTER TYPE "ErpDocumentKind_new" RENAME TO "ErpDocumentKind";

-- ── 2. Origin, and the lifecycle ───────────────────────────────────────────

CREATE TYPE "ErpDocumentOrigin" AS ENUM ('LANDED', 'LOCAL');

-- One column, a per-kind allowed-transition map, and a test that walks every
-- cell. Not one enum per kind: five enums are five things to keep in sync and
-- a `switch` in every read path.
CREATE TYPE "ErpDocumentStatus" AS ENUM (
  'DRAFT',
  'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED',
  'CONFIRMED', 'FULFILLED', 'CANCELLED',
  'PART_PAID', 'PAID', 'VOID', 'WRITTEN_OFF',
  'ISSUED', 'APPLIED'
);

-- DEFAULT 'LANDED': every row that exists when this runs was landed by
-- definition. A default of LOCAL would rewrite history and then fail the CHECK.
ALTER TABLE "ErpDocument"
  ADD COLUMN "origin" "ErpDocumentOrigin" NOT NULL DEFAULT 'LANDED';

-- 🔴 The vendor's word and the box's lifecycle are DIFFERENT COLUMNS, and the
-- CHECK below makes them mutually exclusive by origin. Folding both into one
-- column would mean a query for unpaid invoices silently matching the vendor
-- string 'Paid' — the mapping mistake WARP-2581 refused to make on the way in,
-- arrived at from the other direction.
ALTER TABLE "ErpDocument" RENAME COLUMN "status" TO "vendorStatus";
ALTER TABLE "ErpDocument" ADD COLUMN "status" "ErpDocumentStatus";

-- ── 3. Provenance becomes conditional ──────────────────────────────────────

ALTER TABLE "ErpDocument" ALTER COLUMN "connectionId" DROP NOT NULL;
ALTER TABLE "ErpDocument" ALTER COLUMN "externalSystem" DROP NOT NULL;
ALTER TABLE "ErpDocument" ALTER COLUMN "externalId" DROP NOT NULL;

-- 🔴 A LOCAL ROW MAY NOT BORROW A CONNECTION.
--
-- That is the whole point of the constraint. A row with a connection is
-- vendor-owned, which on the CRM side means uneditable, archive-only and
-- overwritten by the next landing tick. A document a person has to be able to
-- correct cannot be vendor-owned, and "mostly local, with a connection for
-- convenience" is exactly how it would become so.
--
-- 🔴 `companyId IS NOT NULL` is DELIBERATELY ABSENT from the LOCAL branch,
-- and its absence is the more careful choice.
--
-- `ErpDocument_companyId_fkey` is `ON DELETE SET NULL`. A CHECK requiring a
-- non-null `companyId` would fire INSIDE the statement that nulls it, so
-- deleting a `CrmCompany` that has one local invoice would fail with a
-- constraint error naming a table nobody was touching, and the company would
-- be permanently un-deletable. That trap is recorded twice already in this
-- schema (see the ADR-048 actor-column note).
--
-- The invariant is kept where it can produce a readable refusal instead:
-- `deleteCompany` refuses a company that still has LOCAL documents, and the
-- create path requires a party. Both are tested.
ALTER TABLE "ErpDocument" ADD CONSTRAINT "ErpDocument_provenance" CHECK (
  (
    "origin" = 'LANDED'
    AND "connectionId"   IS NOT NULL
    AND "externalSystem" IS NOT NULL
    AND "externalId"     IS NOT NULL
    AND "status"         IS NULL
  )
  OR
  (
    "origin" = 'LOCAL'
    AND "connectionId"   IS NULL
    AND "externalSystem" IS NULL
    AND "externalId"     IS NULL
    AND "vendorStatus"   IS NULL
    AND "status"         IS NOT NULL
  )
);

-- "The quotes I have out", "the invoices I have not sent". A local-document
-- list is always filtered by all three.
CREATE INDEX "ErpDocument_origin_kind_status_idx" ON "ErpDocument"("origin", "kind", "status");

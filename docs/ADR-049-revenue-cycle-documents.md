# ADR-049: `ErpDocument` is the box's document spine, not a vendor's copy

- **Status:** Accepted for §4.1–4.2 (2026-09-05). §4.3–4.5 are **proposed and unbuilt**.
- **Epic:** [WARP-2557](https://warp-lab.atlassian.net/browse/WARP-2557) · this slice is [WARP-2739](https://warp-lab.atlassian.net/browse/WARP-2739)
- **Design:** `BUSINESS-CAPABILITY-PARITY-BRIEF.md` §4 (warp-lab-engineering-handbook root)
- **Builds on:** [`docs/ADR-041-cloud-connector-class.md`](ADR-041-cloud-connector-class.md) (provenance on synced rows), [`docs/ADR-044-business-ecosystem-customer-spine.md`](ADR-044-business-ecosystem-customer-spine.md) (the customer spine these documents hang off), WARP-2581 (`ErpDocument`, the landed table this widens)
- **Number:** claimed here, in `docs/`, deliberately. The parity brief called itself "provisional ADR-046" and that number was already taken by [`docs/ADR-046-declarative-rest-connector-track.md`](ADR-046-declarative-rest-connector-track.md) — the fourth such collision this quarter. A provisional number in a brief reserves nothing; a file in this directory does.

## Context

WARP-2581 built `ErpDocument` last week to hold **landed copies of what a vendor's server already decided**. It is landed-only by construction:

- `connectionId` NOT NULL, FK RESTRICT to `IntegrationConnection`
- `externalSystem` / `externalId` NOT NULL, derived from `connection.provider`, *"never accepted from a caller"*
- `/api/money` has no POST; the only writer is `land-money.ts`, which refuses non-cloud tracks

So the box can tell you a deal is worth $40,000 and that QuickBooks says somebody owes you $12,000. **It cannot produce the document in between.** There is no quote, no order, no native invoice. The entire commercial middle of a business — where an agreement becomes a number somebody owes — does not exist on this appliance.

Two facts made this the moment to change it rather than a later one:

1. 🔴 **`ErpDocument` has never shipped to `main`.** PR #1798 has not promoted, so the enum rewrite below runs over an **empty table on every customer box today**. The same change after that promotion is a data migration over a business's live ledger.

2. 🔴 **`ErpDocumentKind` was `RECEIVABLE | PAYABLE`, which is a direction, not a kind.** A quote and an invoice are both receivable; a credit note is receivable and negative. The old pair could not tell them apart, so a native invoice had nowhere to live that a quote did not also occupy.

## Decision

### 1. One table with a `kind`, not six tables with identical columns

`ErpDocument` gains `origin LANDED | LOCAL` and a six-value kind — `QUOTE | ORDER | INVOICE | BILL | CREDIT_NOTE | RECEIPT`. A native invoice that could not be listed alongside a QuickBooks invoice would defeat the point of having either, and six tables with the same columns is how a schema stops being readable.

**Direction is derived from kind**, in one place (`money.service.ts`), because that is the only place it was ever needed and the only place it stays correct as kinds are added. The `/api/money?kind=receivable` vocabulary is unchanged — it was always a direction, and renaming it would have broken two clients for a change neither can observe.

🔴 **QUOTE and ORDER never reach `/money`.** An unaccepted quote in "what you are owed" is a number the business has no claim to, added to numbers it does. The exclusion is an allow-list, so a seventh kind is excluded until somebody decides it belongs rather than silently appearing in a total.

### 2. A LOCAL row may not borrow a connection

`ErpDocument_provenance`, a CHECK:

```
(origin='LANDED' AND connectionId IS NOT NULL AND externalSystem IS NOT NULL
                 AND externalId IS NOT NULL AND status IS NULL)
OR
(origin='LOCAL'  AND connectionId IS NULL AND externalSystem IS NULL
                 AND externalId IS NULL AND vendorStatus IS NULL AND status IS NOT NULL)
```

A row with a connection is vendor-owned, which on the CRM side means uneditable, archive-only, and overwritten by the next landing tick. A document a person has to be able to correct cannot be that, and *"mostly local, with a connection for convenience"* is exactly the shape that gets there.

🔴 **`companyId IS NOT NULL` is deliberately absent from the LOCAL branch.** `ErpDocument.companyId` is `ON DELETE SET NULL`; a CHECK requiring it would fire inside the statement that nulls it, so deleting a `CrmCompany` with one local invoice would fail with a constraint error naming a table nobody was touching, and the company would be permanently un-deletable. That trap is already recorded twice in this schema. The invariant is kept where it can produce a readable refusal instead: `deleteCompany` refuses a customer that still has LOCAL documents, and says so in words.

### 3. The vendor's word and the box's lifecycle are different columns

`vendorStatus String?` carries the vendor's own word verbatim — WARP-2581's rule, unchanged, because every vendor spells this differently and folding five vocabularies into one set would decide silently that "Voided" and "Paid" mean something this box chose for them.

`status ErpDocumentStatus?` is the box's own lifecycle. One column with a **per-kind allowed-transition map**, not one enum per kind: five enums are five things to keep in sync and a `switch` in every read path, and the first read path that forgets a case shows a blank status rather than failing.

| Kind | Lifecycle |
|---|---|
| QUOTE | `DRAFT → SENT → ACCEPTED \| DECLINED \| EXPIRED` |
| ORDER | `DRAFT → CONFIRMED → FULFILLED \| CANCELLED` |
| INVOICE / BILL | `DRAFT → SENT → PART_PAID → PAID \| VOID \| WRITTEN_OFF` |
| CREDIT_NOTE | `DRAFT → ISSUED → APPLIED` |
| RECEIPT | terminal on creation |

🔴 One deliberate narrowing of the brief's shorthand: **`PART_PAID → VOID` is not allowed.** An invoice that has taken money cannot be made never to have existed; `WRITTEN_OFF` is the exit that keeps the payment and stops chasing the rest.

### 4. The transition and its timeline entry are one transaction

`moveDocumentStatus` is the only writer of `status`, and it writes the move and its `CrmActivity` entry inside one `$transaction`. This is not a new rule: `moveDealStage` established it and `updateDeal` routes stage changes through `applyStageMove` precisely so a PATCH cannot skip the timeline. On money the question it protects is *"when did this become PAID and who said so"*, which is the one that gets asked.

The move is a **guarded update** — `updateMany({ where: { id, status: from } })` requiring `count === 1` — so two tabs marking the same invoice paid produce one state change and one timeline entry, not two of each.

A source-scanning guard test asserts no other file in `apps/orchestrator/src` writes the column.

### 5. Exact decimals, and money is a string at every boundary

`NUMERIC(20,6)` throughout, unchanged. Not minor units: a quantity of `2.5` hours at `137.50` needs sub-cent intermediates, and tax rounded at the line rather than the total is how an invoice ends up a penny off. `Number()` rounds above 2^53, which for a currency figure is a wrong number rather than an error.

## What this ADR does NOT decide

Each is its own slice, and none is built:

- `ErpDocumentLine` + `CatalogItem` + `TaxRate`, with `lineTotal` **stored, never recomputed** — a catalog price change must not silently re-price an invoice sent in March.
- `ErpPayment` + `ErpPaymentAllocation`. 🔴 **Payments allocate; they are not a field.** A customer paying $1,000 across two invoices is ordinary and `invoice.amountPaid` cannot express it.
- Quote → invoice **copy-forward** with `sourceDocumentId` for audit — copy the lines, never reference them. Salesforce's live quote-to-order link is the single most-complained-about behaviour in that product.
- The `/money` write surface (create, send, record payment). There is still no POST.
- `counterpartyName`, which the landed path has never populated: `CANONICAL_COLUMNS` for invoice and bill carry `customer_id`/`vendor_id` and no name. Either fix the landed path or drop the column.

## Consequences

- **A local document is invisible until Money is switched on.** The `money` module is `defaultEnabled: false` and `money_list_open_documents` is excluded from the chat pool, so the local model cannot read one on a chat turn either. Stated, not fixed here.
- **[WARP-2737](https://warp-lab.atlassian.net/browse/WARP-2737) is unblocked** — auto-filing can turn an uploaded invoice into a `CREATE_MONEY_DOC` proposal that applies as a LOCAL document. It remains REVIEW-only forever: money is never auto-applied.
- **A customer with local documents cannot be deleted** until those documents are dealt with. That is a new refusal on a path that previously always succeeded for a LOCAL company, and the dashboard names the way past it.

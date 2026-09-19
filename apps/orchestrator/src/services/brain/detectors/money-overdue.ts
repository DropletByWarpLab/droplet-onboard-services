/**
 * Money detectors (WARP-2754, ADR-051) — the two that work on data the box
 * ALREADY holds at rest, with no upstream ticket in the way.
 *
 * WHY THESE TWO AND NOT THE OBVIOUS ONES. The brief's detector table is mostly
 * blocked: ageing/DSO trend needs `MoneySnapshot` (WARP-2751) because
 * `land-money.ts` overwrites `ErpDocument` in place every 15 minutes and
 * destroys yesterday; gone-quiet needs the `LandingDb.crmActivity` fix
 * (WARP-2750) because every synced deal currently reads as permanently idle;
 * unbilled work needs an `EntityLink` producer. And `idle-subscriptions` — which
 * the ticket originally called the dependency-free one — is NOT: the commerce
 * datasets (charge, refund, payout, order, product, subscription) exist only as
 * live read-through vocabulary and are never landed, so there is nothing at
 * rest to sweep.
 *
 * What IS landed is `ErpDocument`: `kind` (INVOICE | BILL), `balance`,
 * `dueAt`, `currency`, `vendorStatus`, and an `@@index([kind, dueAt])` that
 * these queries ride. POINT-IN-TIME overdue needs no history — only a trend
 * does — so these two run today, against real vendor-synced money, and they are
 * the proof that the loop, the table, the surface and the delivery all work.
 *
 * -- WARP-2773: what the ErpDocument widening changed under this file --------
 *
 * 🔴 WARP-2739 (#2023) and this detector (#2033) merged into `stage` within
 * hours of each other and collided. The widening renamed three things this
 * file reads, and `tsc` said so — but the `node / orchestrator` leg is
 * affected-legs-gated and does not run on a `stage` PUSH (WARP-2761), so the
 * break landed green. The unit tests did not catch it either: they hand the
 * detector a `findMany` mock that ignores `where` entirely, so a query naming
 * an enum value that no longer exists still returns rows.
 *
 *   `kind`     RECEIVABLE -> INVOICE, PAYABLE -> BILL. The migration mapped the
 *              existing rows with a `USING CASE`, so the DATA is fine; only the
 *              two string literals in this file pointed at nothing.
 *   `status`   The vendor's prose word moved to `vendorStatus`, and `status`
 *              became the box's OWN lifecycle enum. Reading `status` here would
 *              have compared `"PAID"`-shaped enum values against a lowercased
 *              vendor-prose set and matched neither.
 *   provenance `externalSystem` became nullable, because a document the box
 *              wrote itself has no vendor to name.
 *
 * 🔴 And the sweep is now `origin: "LANDED"`. That is not tidiness — WARP-2737
 * lets a person create a LOCAL invoice, which is born DRAFT with no vendor. A
 * detector that swept those too would tell an owner their own unsent draft is
 * "96 days past due, and nothing in the box has chased it". Local documents
 * deserve their own detector with its own sentence; they do not belong in a
 * paragraph that ends "from QuickBooks".
 *
 * A NOTE ON `balance` AND `status`. `money.service.ts` records that a document
 * the vendor stops serving — paid, voided, deleted upstream — is NOT reaped, so
 * a stale row can keep a non-zero balance forever. That is exactly why the
 * runner's staleness sweep matters more than any single detector: when a
 * document does get reaped or zeroed, its finding must disappear on the next
 * pass rather than nag forever.
 */
import type { PrismaClient } from "@prisma/client";
import { toMinorUnits } from "@droplet/shared-types";
import type { Detector, DetectedFinding } from "./types";

/** Below this, an overdue invoice is noise. Reporting a $2 balance next to a
 *  $40,000 one trains the operator to skim. */
const MIN_REPORTABLE_MINOR = 100n; // 1.00 in minor units

/**
 * `Decimal(20,6)` (major units, as the vendor sent them) -> minor units.
 *
 * 🔴 CURRENCY-AWARE, AND THE FIRST VERSION WAS NOT. It converted to hundredths
 * for every currency. That is right for USD and wrong by 100x for JPY and KRW
 * (0 decimals) and by 10x for KWD and BHD (3) — a confident impact figure two
 * orders of magnitude out, persisted into `BrainFinding`, rendered on /brief
 * and read to the model. This module's own docstring says it refuses to
 * produce a fabricated number; that was one.
 *
 * DELEGATES to `toMinorUnits` (@droplet/shared-types money.ts) rather than
 * re-deriving the exponent here. That helper already existed when the first
 * version was written, and a second implementation of a currency table is a
 * second thing to keep correct.
 *
 * Returns null for an unknown currency rather than assuming two decimals: a
 * detector that cannot compute an impact must leave it null, and the caller
 * reports the overdue invoice WITHOUT an amount instead of dropping it.
 */
export function decimalToMinor(value: unknown, currency: string | null): bigint | null {
  if (value === null || value === undefined || !currency) return null;
  return toMinorUnits(String(value), currency);
}

/** A balance that is all zeros however it was written ("0", "0.00", "-0.0").
 *  Used only on the path where the currency is unreadable, so `decimalToMinor`
 *  could not give us a number to compare — a settled-but-unreaped row must
 *  still be skipped, and `money.service.ts` records that such rows exist. */
export function isZeroish(balance: unknown): boolean {
  return /^\s*-?0*\.?0*\s*$/.test(String(balance ?? "0"));
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/** Documents a vendor has told us are settled. Compared lowercased because the
 *  string is vendor prose, not an enum — QuickBooks, Xero and Stripe do not
 *  agree on capitalisation. Post-WARP-2739 this reads `vendorStatus`; the field
 *  called `status` is now the box's own enum and is null on every landed row. */
const SETTLED_VENDOR = new Set([
  "paid",
  "void",
  "voided",
  "cancelled",
  "canceled",
  "closed",
  "refunded",
]);

/**
 * The box's own terminal states, for the day a LOCAL document reaches this
 * sweep. Kept BESIDE the vendor set rather than merged into it: one is a closed
 * enum the box controls, the other is prose from somebody else's API, and
 * collapsing them would invite a vendor's word to be treated as a lifecycle
 * fact. A plain string set rather than `Set<ErpDocumentStatus>` because the
 * enum's runtime object is a Prisma client export, and importing it for seven
 * literals would pull the generated client into a module that needs only
 * shapes — this file imports `PrismaClient` as a TYPE for the same reason.
 */
const SETTLED_STATUS = new Set<string>([
  "PAID",
  "VOID",
  "WRITTEN_OFF",
  "CANCELLED",
  "DECLINED",
  "EXPIRED",
  "APPLIED",
]);

function isOpen(row: { vendorStatus: string | null; status: string | null }): boolean {
  // The box's own word wins where there is one: it is an enum this code owns,
  // and the provenance CHECK guarantees a LOCAL row has it.
  if (row.status && SETTLED_STATUS.has(row.status)) return false;
  if (!row.vendorStatus) return true; // nothing said = not known settled; the balance decides
  return !SETTLED_VENDOR.has(row.vendorStatus.trim().toLowerCase());
}

async function overdue(
  prisma: PrismaClient,
  now: Date,
  kind: "INVOICE" | "BILL",
): Promise<
  Array<{
    id: string;
    balance: unknown;
    currency: string | null;
    dueAt: Date | null;
    vendorStatus: string | null;
    status: string | null;
    counterpartyName: string | null;
    externalSystem: string | null;
  }>
> {
  return prisma.erpDocument.findMany({
    // 🔴 `origin: "LANDED"` — vendor-synced money only. See the note at the top
    // of this file: a LOCAL document is one a person on this box wrote, is born
    // DRAFT, and must never be reported to its own author as an unchased debt.
    where: { origin: "LANDED", kind, dueAt: { lt: now } },
    select: {
      id: true,
      balance: true,
      currency: true,
      dueAt: true,
      vendorStatus: true,
      status: true,
      counterpartyName: true,
      externalSystem: true,
    },
    // Rides @@index([kind, dueAt]). Bounded: a box with 10,000 stale unreaped
    // documents must not turn one nightly pass into 10,000 findings.
    orderBy: { dueAt: "asc" },
    take: 500,
  });
}

/**
 * What to call the source in a sentence an owner reads.
 *
 * The provenance CHECK makes `externalSystem` non-null for every LANDED row and
 * this sweep asks for LANDED only, so the fallback is unreachable today. It
 * exists rather than a `!` because a non-null assertion would print the word
 * "null" into a finding's rationale the day that constraint is relaxed, and a
 * sentence an owner cannot parse is worse than a vague one.
 */
function sourceName(externalSystem: string | null): string {
  return externalSystem ?? "your accounting system";
}

export const overdueReceivables: Detector = {
  key: "money.overdue-receivable",
  description: "Invoices past their due date with a balance still outstanding",
  async run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]> {
    const rows = await overdue(prisma, now, "INVOICE");
    const out: DetectedFinding[] = [];

    for (const r of rows) {
      if (!isOpen(r)) continue;
      // A missing or unreadable currency costs the AMOUNT, not the finding:
      // the invoice is still overdue and "90 days past due, amount unknown"
      // beats silently omitting a real debt. The threshold can only be applied
      // when there IS an amount.
      const minor = decimalToMinor(r.balance, r.currency);
      if (minor !== null && (minor <= 0n || minor < MIN_REPORTABLE_MINOR)) continue;
      // With no computable amount, fall back to the raw balance so a
      // settled-but-unreaped zero row is still skipped.
      if (minor === null && isZeroish(r.balance)) continue;

      const days = r.dueAt ? daysBetween(now, r.dueAt) : 0;
      if (days <= 0) continue;

      const who = r.counterpartyName?.trim() || "an unnamed customer";
      const from = sourceName(r.externalSystem);
      // Impact and currency are all-or-nothing. A document with a balance and
      // no currency is unrenderable, so it is reported WITHOUT a number rather
      // than with a guessed one.
      // All-or-nothing: a balance whose currency is unreadable is
      // unrenderable, so it is reported without a number rather than with a
      // guessed one.
      const haveCurrency = minor !== null;

      out.push({
        subjectKey: r.id,
        kind: "loss",
        title: `${who} is ${days} days past due`,
        rationale:
          `An invoice from ${from} fell due ${days} days ago and still ` +
          `carries a balance. Nothing in the box has chased it.` +
          (haveCurrency ? "" : " The vendor sent no currency, so no amount is shown."),
        impactMinor: haveCurrency ? minor : null,
        currency: haveCurrency ? r.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "erp_document",
              sourceId: r.id,
              quote: `${from} receivable, due ${
                r.dueAt?.toISOString().slice(0, 10) ?? "unknown"
              }, balance ${String(r.balance)} ${r.currency ?? "(no currency)"}`,
            },
          ],
        },
        // Bounded, and deliberately not a model's opinion: the further past
        // due, the more certain this is a real problem rather than a document
        // the vendor has not settled yet.
        confidence: Math.min(95, 50 + Math.floor(days / 3)),
      });
    }
    return out;
  },
};

export const overduePayables: Detector = {
  key: "money.overdue-payable",
  description: "Bills the business owes that are past their due date",
  async run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]> {
    const rows = await overdue(prisma, now, "BILL");
    const out: DetectedFinding[] = [];

    for (const r of rows) {
      if (!isOpen(r)) continue;
      // A missing or unreadable currency costs the AMOUNT, not the finding:
      // the invoice is still overdue and "90 days past due, amount unknown"
      // beats silently omitting a real debt. The threshold can only be applied
      // when there IS an amount.
      const minor = decimalToMinor(r.balance, r.currency);
      if (minor !== null && (minor <= 0n || minor < MIN_REPORTABLE_MINOR)) continue;
      // With no computable amount, fall back to the raw balance so a
      // settled-but-unreaped zero row is still skipped.
      if (minor === null && isZeroish(r.balance)) continue;

      const days = r.dueAt ? daysBetween(now, r.dueAt) : 0;
      if (days <= 0) continue;

      const who = r.counterpartyName?.trim() || "an unnamed supplier";
      const from = sourceName(r.externalSystem);
      // All-or-nothing: a balance whose currency is unreadable is
      // unrenderable, so it is reported without a number rather than with a
      // guessed one.
      const haveCurrency = minor !== null;

      out.push({
        subjectKey: r.id,
        // A bill you owe is a RISK, not a loss. Money leaving on time is not a
        // loss; money leaving late costs a relationship or a fee. Filing it as
        // `loss` would inflate the number on /brief with the business's own
        // obligations and make the total meaningless.
        kind: "risk",
        title: `A bill to ${who} is ${days} days overdue`,
        rationale:
          `A payable from ${from} fell due ${days} days ago and is ` +
          `still open. Late payment costs standing, and sometimes a fee.`,
        impactMinor: haveCurrency ? minor : null,
        currency: haveCurrency ? r.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "erp_document",
              sourceId: r.id,
              quote: `${from} payable, due ${
                r.dueAt?.toISOString().slice(0, 10) ?? "unknown"
              }, balance ${String(r.balance)} ${r.currency ?? "(no currency)"}`,
            },
          ],
        },
        confidence: Math.min(95, 50 + Math.floor(days / 3)),
      });
    }
    return out;
  },
};

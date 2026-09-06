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
 * What IS landed is `ErpDocument`: `kind` (RECEIVABLE | PAYABLE), `balance`,
 * `dueAt`, `currency`, `status`, and an `@@index([kind, dueAt])` that these
 * queries ride. POINT-IN-TIME overdue needs no history — only a trend does —
 * so these two run today, against real vendor-synced money, and they are the
 * proof that the loop, the table, the surface and the delivery all work.
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
 * DELEGATES to `toMinorUnits` (@droplet/shared-types money.ts), which is
 * CURRENCY-AWARE. The first draft hardcoded hundredths, which is right for USD
 * and wrong by 100x for JPY and KRW (0 decimals) and by 10x for KWD and BHD
 * (3). That is precisely the "fabricated number" this module's own docstring
 * says it refuses to produce — a confident impact figure, two orders of
 * magnitude out, persisted into `BrainFinding` and then read to the model.
 *
 * Returns null for an unknown currency rather than assuming two decimals: a
 * detector that cannot compute an impact must leave it null.
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
 *  agree on capitalisation. */
const SETTLED = new Set(["paid", "void", "voided", "cancelled", "canceled", "closed", "refunded"]);

function isOpen(status: string | null): boolean {
  if (!status) return true; // no status = not known settled; the balance decides
  return !SETTLED.has(status.trim().toLowerCase());
}

async function overdue(
  prisma: PrismaClient,
  now: Date,
  kind: "RECEIVABLE" | "PAYABLE",
): Promise<
  Array<{
    id: string;
    balance: unknown;
    currency: string | null;
    dueAt: Date | null;
    status: string | null;
    counterpartyName: string | null;
    externalSystem: string;
  }>
> {
  return prisma.erpDocument.findMany({
    where: { kind, dueAt: { lt: now } },
    select: {
      id: true,
      balance: true,
      currency: true,
      dueAt: true,
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

export const overdueReceivables: Detector = {
  key: "money.overdue-receivable",
  description: "Invoices past their due date with a balance still outstanding",
  async run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]> {
    const rows = await overdue(prisma, now, "RECEIVABLE");
    const out: DetectedFinding[] = [];

    for (const r of rows) {
      if (!isOpen(r.status)) continue;
      // A missing or unreadable currency must NOT drop the finding. The
      // invoice is still overdue; only the AMOUNT is unknowable, and reporting
      // "90 days past due, amount unknown" beats silently omitting a real debt.
      // The amount threshold can only be applied when there IS an amount.
      const minor = decimalToMinor(r.balance, r.currency);
      if (minor !== null && (minor <= 0n || minor < MIN_REPORTABLE_MINOR)) continue;
      // With no computable amount, fall back to the raw balance sign so a
      // settled-but-unreaped zero row is still skipped.
      if (minor === null && isZeroish(r.balance)) continue;

      const days = r.dueAt ? daysBetween(now, r.dueAt) : 0;
      if (days <= 0) continue;

      const who = r.counterpartyName?.trim() || "an unnamed customer";
      // Impact and currency are all-or-nothing. A document with a balance and
      // no currency is unrenderable, so it is reported WITHOUT a number rather
      // than with a guessed one.
      const haveCurrency = minor !== null;

      out.push({
        subjectKey: r.id,
        kind: "loss",
        title: `${who} is ${days} days past due`,
        rationale:
          `An invoice from ${r.externalSystem} fell due ${days} days ago and still ` +
          `carries a balance. Nothing in the box has chased it.` +
          (haveCurrency ? "" : " The vendor sent no currency, so no amount is shown."),
        impactMinor: haveCurrency ? minor : null,
        currency: haveCurrency ? r.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "erp_document",
              sourceId: r.id,
              quote: `${r.externalSystem} receivable, due ${
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
    const rows = await overdue(prisma, now, "PAYABLE");
    const out: DetectedFinding[] = [];

    for (const r of rows) {
      if (!isOpen(r.status)) continue;
      // See the receivable branch: an unknown currency costs the AMOUNT, not
      // the finding.
      const minor = decimalToMinor(r.balance, r.currency);
      if (minor !== null && (minor <= 0n || minor < MIN_REPORTABLE_MINOR)) continue;
      if (minor === null && isZeroish(r.balance)) continue;

      const days = r.dueAt ? daysBetween(now, r.dueAt) : 0;
      if (days <= 0) continue;

      const who = r.counterpartyName?.trim() || "an unnamed supplier";
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
          `A payable from ${r.externalSystem} fell due ${days} days ago and is ` +
          `still open. Late payment costs standing, and sometimes a fee.`,
        impactMinor: haveCurrency ? minor : null,
        currency: haveCurrency ? r.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "erp_document",
              sourceId: r.id,
              quote: `${r.externalSystem} payable, due ${
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

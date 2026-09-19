/**
 * Pipeline detector (WARP-2754, ADR-051) — deals whose expected close date has
 * passed while the deal is still open.
 *
 * WHY THIS ONE AND NOT "GONE QUIET". The obvious deal detector is idleness, and
 * it WAS blocked: `LandingDb` omitted `crmActivity`, so every vendor-synced deal
 * had zero activity rows forever and the idle query judged them all neglected.
 * WARP-2750 has since widened that seam and the landing now writes a timeline
 * row whenever the vendor's own values move — so the block is gone.
 *
 * TWO CORRECTIONS to what this comment used to say, both worth keeping because
 * the second one changes the argument:
 *
 *   - it cited `crm.service.ts:878`, which is `jobTitle` in `crmContactToApi`.
 *     The idle predicate is in `listDeals` (search for `opts.idleDays`).
 *     Ticket line numbers in this repo rot; grep for the symbol.
 *   - "reports the ENTIRE synced pipeline as neglected" overstated it. The
 *     no-activity arm still tests `createdAt < cutoff`, so a freshly landed
 *     deal is not idle — the arm is a grace window exactly `idle_days` long.
 *     The bug was real for any connection older than that window, which is
 *     every connection in practice, but it was never unconditional.
 *
 * This detector still does not depend on idleness, and the selection rule below
 * is why.
 *
 * `expectedCloseOn` is different: it is set by a human or by the vendor, it is
 * indexed (`@@index([expectedCloseOn])`), and a date in the past on an open
 * deal is a fact about the deal rather than an inference from missing data.
 * That is the whole selection rule — prefer a signal that is WRONG only when
 * the data is wrong, over one that is wrong whenever the data is merely absent.
 */
import type { PrismaClient } from "@prisma/client";
import type { Detector, DetectedFinding } from "./types";
import { daysBetween } from "./money-overdue";

/** A deal a day past its date is not news. Two weeks of silence is. */
const MIN_DAYS_SLIPPED = 14;

export const dealsSlipping: Detector = {
  key: "crm.deal-slipping",
  description: "Open deals whose expected close date has passed",
  async run(prisma: PrismaClient, now: Date): Promise<DetectedFinding[]> {
    const cutoff = new Date(now.getTime() - MIN_DAYS_SLIPPED * 86_400_000);

    const rows = await prisma.crmDeal.findMany({
      where: {
        // `closedAt` is the explicit terminal marker. Filtering on it rather
        // than inferring "closed" from a stage name: stage names are vendor
        // prose that a customer renames, and the no-guessing rule applies.
        closedAt: null,
        isArchived: false,
        expectedCloseOn: { lt: cutoff },
      },
      select: {
        id: true,
        title: true,
        amountMinor: true,
        currency: true,
        expectedCloseOn: true,
        company: { select: { name: true } },
        stage: { select: { name: true, kind: true } },
      },
      orderBy: { expectedCloseOn: "asc" },
      take: 500,
    });

    const out: DetectedFinding[] = [];
    for (const d of rows) {
      // A stage the pipeline itself marks terminal is closed in practice even
      // if `closedAt` was never written — a real shape on vendor-synced boards.
      if (d.stage?.kind === "WON" || d.stage?.kind === "LOST") continue;
      if (!d.expectedCloseOn) continue;

      const days = daysBetween(now, d.expectedCloseOn);
      if (days < MIN_DAYS_SLIPPED) continue;

      const who = d.company?.name?.trim();
      // All-or-nothing, mirroring CrmDeal_amount_needs_currency: a deal with an
      // amount and no currency is reported without a number.
      const haveMoney = d.amountMinor !== null && d.currency !== null;

      out.push({
        subjectKey: d.id,
        // `risk`, not `loss`. The money has not gone — the forecast has. Filing
        // a slipping deal as a loss would double-count it against the invoices
        // that actually did go unpaid.
        kind: "risk",
        title: `"${d.title}" slipped its close date by ${days} days`,
        rationale:
          `This deal was expected to close on ` +
          `${d.expectedCloseOn.toISOString().slice(0, 10)} and is still open in ` +
          `${d.stage?.name ?? "its current stage"}` +
          `${who ? ` for ${who}` : ""}. Either the date is stale or the deal is.`,
        impactMinor: haveMoney ? d.amountMinor : null,
        currency: haveMoney ? d.currency : null,
        evidence: {
          sources: [
            {
              sourceKind: "crm_deal",
              sourceId: d.id,
              quote: `${d.title} — expected ${d.expectedCloseOn
                .toISOString()
                .slice(0, 10)}, stage "${d.stage?.name ?? "unknown"}", still open`,
            },
          ],
        },
        confidence: Math.min(90, 45 + Math.floor(days / 7) * 5),
      });
    }
    return out;
  },
};

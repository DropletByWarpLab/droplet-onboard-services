/**
 * WARP-2733 (ADR-048) — the caps, and what happens at the ceiling.
 *
 * 🔴 OVER THE CAP IS *REVIEW*, NEVER *DROPPED*.
 *
 * That is the whole design of this file. A bound that discarded work would
 * make a busy morning indistinguishable from a broken worker: fifty invoices
 * arrive, forty-nine are filed, one vanishes, and nothing anywhere says which
 * or why. Instead the fifty-first becomes an ordinary review card with
 * `policyReason: "Droplet has filed a lot in the last hour…"` — visible,
 * clickable, and reconsidered on the next tick once the window has rolled.
 *
 * ── Why a rolling window and not a counter ─────────────────────────────────
 *
 * There is no counter column, deliberately. A counter needs a reset, a reset
 * needs a schedule, and a schedule that misses a tick leaves a box capped
 * forever with no error. Counting rows in the window instead makes the cap a
 * QUESTION rather than a piece of state — it answers itself correctly after a
 * restart, a clock change, or a month of downtime, and there is nothing to
 * migrate.
 *
 * ── What counts ────────────────────────────────────────────────────────────
 *
 * Only what the BOX did. `autoApplied: true` is the filter, so a morning spent
 * clicking Apply does not spend the unattended budget — the cap exists to
 * bound what happens WITHOUT a person, and a person who is plainly present is
 * evidence against needing the bound, not for it.
 */
import type { PrismaClient } from "@prisma/client";

import { BOUNDED_MARKER } from "./policy.js";

export { BOUNDED_MARKER };

/** Auto-applies of any kind, per rolling hour. */
export const HOURLY_APPLY_CAP_DEFAULT = 50;

/** Auto-CREATES, per rolling day. Much tighter: a create is the class that
 *  puts a new row in front of every user of the CRM. */
export const DAILY_CREATE_CAP_DEFAULT = 10;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The kinds that count against the daily CREATE budget. */
const CREATE_KINDS = ["CREATE_CUSTOMER", "CREATE_PROJECT"] as const;

export interface CapState {
  appliedThisHour: number;
  createdToday: number;
  hourlyCap: number;
  dailyCap: number;
  /** True when the hourly budget is spent — bounds every AUTO kind. */
  hourlyReached: boolean;
  /** True when the daily create budget is spent — bounds the create kinds. */
  dailyReached: boolean;
}

export async function readCaps(
  prisma: PrismaClient,
  limits: { hourlyApplyCap: number; dailyCreateCap: number },
  now: Date = new Date(),
): Promise<CapState> {
  const [appliedThisHour, createdToday] = await Promise.all([
    prisma.ingestProposal.count({
      where: {
        autoApplied: true,
        appliedAt: { gte: new Date(now.getTime() - HOUR_MS) },
      },
    }),
    prisma.ingestProposal.count({
      where: {
        autoApplied: true,
        kind: { in: [...CREATE_KINDS] },
        appliedAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    }),
  ]);

  return {
    appliedThisHour,
    createdToday,
    hourlyCap: limits.hourlyApplyCap,
    dailyCap: limits.dailyCreateCap,
    hourlyReached: appliedThisHour >= limits.hourlyApplyCap,
    dailyReached: createdToday >= limits.dailyCreateCap,
  };
}

/**
 * Is the budget for THIS kind spent?
 *
 * A create is bounded by both budgets: it is an apply as well as a create, and
 * the tighter of the two wins. Reading only the daily cap would let a runaway
 * morning mint ten customers inside an hour that had already spent its fifty.
 */
export function capReachedFor(
  kind: string,
  caps: Pick<CapState, "hourlyReached" | "dailyReached">,
): boolean {
  if (caps.hourlyReached) return true;
  return (CREATE_KINDS as readonly string[]).includes(kind) && caps.dailyReached;
}

/**
 * Proposals that were held back by a cap and may now be reconsidered.
 *
 * 🔴 The half that makes "REVIEW, not dropped" true rather than merely stated.
 * Without this, `bounded` is a life sentence: the card sits in the queue
 * forever wearing a reason that stopped applying an hour ago, and the owner
 * clicks it by hand — which is exactly the "manual forever, then silently
 * EXPIRED" outcome the ticket warns about.
 *
 * Matched on the REASON rather than a column, because `policyReason` is
 * already the durable record of why a proposal is in review and adding a
 * second one would give two answers to one question. `BOUNDED_MARKER` lives in
 * `policy.ts` beside the sentences it appears in, so an edit that breaks this
 * sweep breaks a test first.
 */
export async function reconsiderBounded(
  prisma: PrismaClient,
  caps: CapState,
  limit = 25,
): Promise<number> {
  if (caps.hourlyReached && caps.dailyReached) return 0;

  const held = await prisma.ingestProposal.findMany({
    where: {
      status: "PENDING",
      policyClass: "REVIEW",
      policyReason: { contains: BOUNDED_MARKER },
    },
    select: { id: true, kind: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const freed = held.filter((p) => !capReachedFor(p.kind, caps)).map((p) => p.id);
  if (freed.length === 0) return 0;

  // Back to AUTO with the reason cleared. The next tick applies them; nothing
  // is applied from inside this read, so a cap sweep can never become a
  // second, unbounded, apply path.
  const n = await prisma.ingestProposal.updateMany({
    where: { id: { in: freed }, status: "PENDING", policyClass: "REVIEW" },
    data: { policyClass: "AUTO", policyReason: null },
  });
  return n.count;
}

/**
 * WARP-3521 — the shared leaf under cycles and modules.
 *
 * Deliberately imports NOTHING from `pm.service.ts`: that file needs
 * `lockAttachableCycle` to let a work item be planned into a cycle, and the
 * cycle / module services need `PM_ERRORS` and `isPrismaCode` from it. Putting
 * the part both sides share in a leaf keeps the import graph a tree.
 *
 * Errors follow the PM convention (`Error(message)` with a stable string code,
 * mapped to HTTP in the route layer). `PmPlanningError` is the same thing plus
 * a `details` bag for the few refusals that are more useful with a name in them
 * ("Sprint 12 is already active") — `message` IS the code, so every existing
 * `switch (err.message)` mapper handles it unchanged.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

/** A Prisma client OR an interactive-transaction handle. */
type Db = PrismaClient | Prisma.TransactionClient;

// ── Stable error codes ───────────────────────────────────────────────────────
export const PM_PLANNING_ERRORS = {
  CYCLE_NOT_FOUND: "cycle_not_found",
  MODULE_NOT_FOUND: "module_not_found",
  /** The cycle exists but not in this item's project (or is not a valid target). */
  INVALID_CYCLE: "invalid_cycle",
  /** A completed cycle takes no new work and its dates are history. */
  CYCLE_COMPLETED: "cycle_completed",
  CYCLE_ALREADY_ACTIVE: "cycle_already_active",
  CYCLE_NOT_DRAFT: "cycle_not_draft",
  CYCLE_NOT_ACTIVE: "cycle_not_active",
  CYCLE_DATES_REQUIRED: "cycle_dates_required",
  /** End before start, or a cycle longer than MAX_CYCLE_DAYS. */
  INVALID_DATES: "invalid_dates",
  /** A work item of another project offered to a module. */
  INVALID_WORK_ITEM: "invalid_work_item",
} as const;

export class PmPlanningError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, details?: Record<string, unknown>) {
    super(code);
    this.name = "PmPlanningError";
    this.code = code;
    this.details = details;
  }
}

// ── Calendar dates ───────────────────────────────────────────────────────────
// A cycle's dates, a module's dates and (WS-1) a work item's due date are
// CALENDAR dates, not instants. They cross the wire as `YYYY-MM-DD`, are stored
// as midnight UTC, and are only ever read back through the UTC accessors — a
// local-time `new Date("2026-10-05")` round trip is how a date entered west of
// UTC lands a day early (WARP-3372).

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → midnight UTC, or `null` for anything that is not a real calendar date. */
export function parseDateOnly(value: string): Date | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC rolls 2026-02-30 into March; a real date survives the round trip.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`; null-safe. */
export function formatDateOnly(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Calendar days from `start` to `end`, both ends counted. */
export function daysInclusive(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

/** A cycle is a sprint, not a calendar year; this is the sanity bound. */
export const MAX_CYCLE_DAYS = 366;

// ── Planning an item into a cycle ────────────────────────────────────────────

/**
 * Prove a cycle can take new work AND serialise against anyone completing or
 * deleting it, in one statement.
 *
 * The statement is a compare-and-set that touches the cycle row only if it is in
 * this project and not completed. An UPDATE takes a row lock and, under READ
 * COMMITTED, re-evaluates its WHERE against the row a concurrent writer just
 * committed — so an attach racing `completeCycle` (whose first statement is the
 * same kind of CAS on the same row) has exactly two outcomes: it goes first and
 * `completeCycle` then SEES the new item and moves it, or it goes second, finds
 * the cycle completed and is refused. "Completing a cycle never leaves an
 * incomplete item attached to it" holds in both. A plain read-then-write here
 * would admit a third outcome — validated against an active cycle, committed
 * after it completed — and strand an open item in a finished sprint.
 *
 * `count === 0` is the miss, and a second read says WHY, so the caller gets
 * the right status instead of a generic refusal.
 */
export async function lockAttachableCycle(
  db: Db,
  cycleId: string,
  projectId: string,
): Promise<void> {
  const touched = await db.pmCycle.updateMany({
    where: { id: cycleId, projectId, status: { not: "completed" } },
    data: { updatedAt: new Date() },
  });
  if (touched.count === 1) return;

  const cycle = await db.pmCycle.findUnique({
    where: { id: cycleId },
    select: { projectId: true, status: true },
  });
  if (!cycle) throw new Error(PM_PLANNING_ERRORS.CYCLE_NOT_FOUND);
  if (cycle.projectId !== projectId) throw new Error(PM_PLANNING_ERRORS.INVALID_CYCLE);
  throw new Error(PM_PLANNING_ERRORS.CYCLE_COMPLETED);
}

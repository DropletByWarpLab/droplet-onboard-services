/**
 * Money formatting (WARP-2581) — its own module for two reasons.
 *
 * A `src/app/**\/page.tsx` may export ONLY its default component; any other
 * named export fails `next build` at page-data collection, invisibly to tsc
 * and vitest. And these rules are worth testing directly rather than through
 * a rendered table.
 *
 * 🔴 DATES AND "TIME AGO" ARE NOT HERE, deliberately. `lib/erp-format.ts`
 * already owns both for every surface that reads from a connected system, and
 * the copies this module briefly carried had drifted: money's `formatDate`
 * never inherited the calendar-date correction, so an invoice due the 10th
 * rendered "Sep 9" on any box behind UTC. `/money` imports `formatDate` and
 * `syncedAgo` from there. Only the money-SPECIFIC rules live here.
 */

/** Vendor words that mean the document is settled. */
export const PAID_WORDS: ReadonlySet<string> = new Set(["paid", "settled"]);

/** Vendor words that mean it never counted. */
export const VOID_WORDS: ReadonlySet<string> = new Set(["void", "voided", "deleted"]);

export type StatusClass = "open" | "paid" | "overdue" | "void";

/**
 * Which visual class a vendor's own status word belongs to.
 *
 * 🔴 An unrecognised word is `open`, and the surface renders THE WORD, not a
 * translation of it. Deriving "open" from the absence of a paid date — the
 * obvious shortcut — renders a document closed by a workflow that never
 * stamped one as outstanding forever.
 */
export function statusClassFor(status: string | null, isOverdue: boolean): StatusClass {
  const word = (status ?? "").trim().toLowerCase();
  if (VOID_WORDS.has(word)) return "void";
  if (PAID_WORDS.has(word)) return "paid";
  return isOverdue ? "overdue" : "open";
}

/**
 * A figure, with its currency when one is known.
 *
 * The integer part is grouped; the fraction is printed EXACTLY as the vendor
 * sent it. Re-rounding for display is how a page ends up disagreeing with the
 * accounting package it is quoting — and the value arrives as a string
 * precisely so it never passes through a float.
 */
export function formatFigure(value: string | null, currency: string | null): string {
  if (value === null) return "—";
  const [whole, fraction] = value.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rendered = `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
  return currency === null ? rendered : `${rendered} ${currency}`;
}

/** An hour is the line between "read" and "last read" (WARP-2581 §3.1). */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * WARP-3372 — `dueDate` and `startDate` are CALENDAR DATES, not instants.
 *
 * "Due 25 June" means the same day in Los Angeles and in Auckland; it is not a
 * moment in time. The column is a `DateTime` (no schema change), so a date is
 * stored as that day at 00:00:00.000Z, and everything that crosses the API
 * boundary speaks `YYYY-MM-DD`:
 *
 *   in   `YYYY-MM-DD`, or (for a client that predates this — a cached dashboard
 *        tab, a script) an ISO instant ending in `Z`, whose UTC date is taken;
 *   out  `YYYY-MM-DD`, always, never an instant.
 *
 * The dashboard used to send `new Date("2026-06-25").toISOString()` and render
 * the answer through `getDate()`, which is the LOCAL day: west of UTC the date
 * a person typed came back a day early. With a date that is a plain string on
 * the wire there is no zone in it to get wrong, so nothing in this file reads a
 * local-time getter, and `pm-dates.test.ts` runs it under two process zones to
 * keep it that way.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
// The shape `z.string().datetime()` accepted before: seconds and fraction
// optional, `Z` required (no offset), which is what `Date#toISOString` writes.
const INSTANT_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** True when `s` is a REAL calendar date written `YYYY-MM-DD` (2026-02-30 is not). */
export function isDateOnly(s: string): boolean {
  const m = DATE_ONLY.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  // `Date.UTC` rolls 02-30 over to 03-02; the date is real only if it survives.
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/**
 * The value the API accepts for a date field, as the Date to store: that
 * calendar day at 00:00:00.000Z. `null` for anything that is not a date — the
 * caller turns that into a 400, never a guess.
 */
export function parseDateInput(s: string): Date | null {
  if (isDateOnly(s)) return new Date(`${s}T00:00:00.000Z`);
  if (INSTANT_Z.test(s)) {
    const at = new Date(s);
    if (Number.isNaN(at.getTime())) return null;
    // A `Z` instant's calendar date is its UTC date — the day it names, with
    // no zone arithmetic.
    return new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  return null;
}

/** The calendar date a stored value stands for, as `YYYY-MM-DD` (its UTC date). */
export function dateToDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in UTC — what "overdue" is measured against when the
 *  caller does not say which day it is where they are. */
export function todayDateOnly(now: Date = new Date()): string {
  return dateToDateOnly(now);
}

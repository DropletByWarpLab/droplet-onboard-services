/**
 * WARP-1992 — the Reports date scope.
 *
 * Pure range arithmetic, deliberately kept out of the page component so the
 * boundary rules are unit-testable without rendering anything.
 *
 * Every range is HALF-OPEN — `[from, to)`. That is not a stylistic choice:
 * `GET /api/activity` filters `at >= from` and `at < to` (`gte`/`lt` in
 * activity.ts), so an inclusive `to` would silently pull in the first
 * millisecond of the following day. The two must agree, and the endpoint is
 * the one that can't change.
 *
 * WARP-1999 is the open decision about WHAT this scope governs. It genuinely
 * scopes the daily report, Activity, and the money tile's day reads. It
 * canNOT scope the number strip: `GET /api/home` is today-only by
 * construction (its timeline filters `at >= startOfDay`) and its tile values
 * are point-in-time totals, not range aggregates. Until that ticket lands,
 * the strip is labelled as current-state rather than pretending to follow
 * the chip — see `NUMBER_STRIP_SCOPE_NOTE`.
 */

export type ScopeId = "today" | "yesterday" | "last7" | "custom";

export interface DateRange {
  /** Inclusive lower bound, ISO 8601. */
  from: string;
  /** EXCLUSIVE upper bound, ISO 8601. */
  to: string;
}

export interface ScopeOption {
  id: ScopeId;
  label: string;
}

/** Chip order is the order they render. Today is the default. */
export const SCOPE_OPTIONS: ScopeOption[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 days" },
  { id: "custom", label: "Custom" },
];

export const DEFAULT_SCOPE: ScopeId = "today";

/** Brief §3 — a custom range is capped so one picker mistake can't ask the
 *  activity table for a year of rows. */
export const MAX_CUSTOM_SPAN_DAYS = 90;

/** Days covered by "Last 7 days", counting today as one of them. */
const LAST_N_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** Local midnight at the start of `d`'s calendar day. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  // Constructed from calendar parts rather than by adding milliseconds, so a
  // DST transition inside the range doesn't shift the boundary by an hour.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * `YYYY-MM-DD` → local midnight. `new Date("2026-08-14")` parses as UTC and
 * lands on the previous day west of Greenwich, which would silently shift
 * every custom range; parsing the parts avoids that.
 */
export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, da);
  // Rejects 2026-13-45 and 2026-02-30, which would otherwise roll over into
  // the following month instead of failing. Same guard the ERP routes apply.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) {
    return null;
  }
  return d;
}

export interface CustomRangeInput {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive — the user picks a day, not a boundary. */
  end: string;
}

export type CustomRangeError =
  | "invalid-start"
  | "invalid-end"
  | "reversed"
  | "too-long";

/** Human-facing copy for each rejection. Sentence case, no exclamation. */
export const CUSTOM_RANGE_ERROR_COPY: Record<CustomRangeError, string> = {
  "invalid-start": "That start date isn't a real date.",
  "invalid-end": "That end date isn't a real date.",
  reversed: "The end date is before the start date.",
  "too-long": `Pick a range of ${MAX_CUSTOM_SPAN_DAYS} days or fewer.`,
};

export function validateCustomRange(
  input: CustomRangeInput,
): CustomRangeError | null {
  const start = parseIsoDate(input.start);
  if (!start) return "invalid-start";
  const end = parseIsoDate(input.end);
  if (!end) return "invalid-end";
  if (end.getTime() < start.getTime()) return "reversed";
  // +1 because both ends are inclusive days: the 1st to the 1st is one day.
  const spanDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) return "too-long";
  return null;
}

/**
 * Resolve a scope to its half-open range.
 *
 * `now` is injected rather than read from the clock so the boundary tests
 * are deterministic. Returns `null` for a `custom` scope whose input is
 * missing or invalid — the caller renders the picker's error instead of
 * quietly falling back to today, which would show the wrong data under a
 * label the user chose.
 */
export function rangeFor(
  scope: ScopeId,
  now: Date,
  custom?: CustomRangeInput,
): DateRange | null {
  const today = startOfDay(now);

  switch (scope) {
    case "today":
      return iso(today, addDays(today, 1));
    case "yesterday":
      return iso(addDays(today, -1), today);
    case "last7":
      // Inclusive of today, so the lower bound is 6 days back, not 7.
      return iso(addDays(today, -(LAST_N_DAYS - 1)), addDays(today, 1));
    case "custom": {
      if (!custom || validateCustomRange(custom) !== null) return null;
      const start = parseIsoDate(custom.start)!;
      const end = parseIsoDate(custom.end)!;
      // The picked end day is inclusive; the boundary is the midnight after.
      return iso(start, addDays(end, 1));
    }
  }
}

function iso(from: Date, to: Date): DateRange {
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The label under the export modal and the custom picker: `1 Aug – 14 Aug`. */
export function formatRangeLabel(range: DateRange, locale?: string): string {
  const from = new Date(range.from);
  // `to` is exclusive, so the last day the user thinks of as included is the
  // day before it. Showing the raw boundary would read as one day too many.
  const lastDay = new Date(new Date(range.to).getTime() - 1);
  const fmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const a = fmt.format(from);
  const b = fmt.format(lastDay);
  return a === b ? a : `${a} – ${b}`;
}

/**
 * WARP-1999, option A until decided otherwise: the number strip reports
 * current state and says so, rather than appearing to follow a scope it
 * cannot apply.
 */
export const NUMBER_STRIP_SCOPE_NOTE = "As of now";

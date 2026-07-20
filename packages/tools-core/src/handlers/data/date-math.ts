/**
 * WARP-1424 — `date_math` LLM tool.
 *
 * Misc dev-utility: calendar arithmetic the model would otherwise get
 * wrong — add/subtract a duration (with month-end clamping), signed
 * difference between two dates, and next-weekday resolution. All
 * arithmetic runs in UTC via the built-in `Date`. Tier-1 read; pure
 * computation, no I/O.
 *
 * Shape tracking: a date-only input (`YYYY-MM-DD`) yields a date-only
 * result string; a datetime input yields a full ISO UTC string (`...Z`).
 * Naive datetimes (no `Z`/offset) are treated as UTC. One deliberate
 * exception: when add/subtract on a date-only input lands off UTC
 * midnight (hours/minutes components), the result is promoted to a full
 * ISO datetime rather than silently truncating the time-of-day.
 *
 * add/subtract order: `years` folds into `months` (years*12 + months)
 * and is applied first with a single month-end clamp (2025-01-31 +
 * 1 month = 2025-02-28; 2024-02-29 + 1 year = 2025-02-28), then
 * weeks/days/hours/minutes are applied as exact spans. Subtract is add
 * with every component negated — clamping still applies.
 *
 * diff totals are signed (`other_date − date`) and may be fractional
 * when datetimes are involved (e.g. a 36 h gap → totalDays 1.5); the
 * `breakdown` is an integer days/hours/minutes decomposition of the
 * absolute difference.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const OPERATIONS = ["add", "subtract", "diff", "next_weekday"] as const;
type Operation = (typeof OPERATIONS)[number];

/** Index-aligned with `Date#getUTCDay()` (0 = Sunday). */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const AMOUNT_FIELDS = ["years", "months", "weeks", "days", "hours", "minutes"] as const;
type AmountField = (typeof AMOUNT_FIELDS)[number];
type Amount = Record<AmountField, number>;

const MAX_COMPONENT = 10000;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:\d{2})?$/i;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const inputSchema = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: ["add", "subtract", "diff", "next_weekday"],
      description:
        "'add'/'subtract' a duration, 'diff' two dates (other_date - date), or find the 'next_weekday' strictly after `date`.",
    },
    date: {
      type: "string",
      description:
        "ISO-8601 base date: either date-only 'YYYY-MM-DD' or a datetime like '2025-01-31T10:00:00Z' / '...+02:00'. A naive datetime (no Z/offset) is treated as UTC.",
    },
    amount: {
      type: "object",
      properties: {
        years: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
        months: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
        weeks: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
        days: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
        hours: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
        minutes: { type: "integer", minimum: -MAX_COMPONENT, maximum: MAX_COMPONENT },
      },
      minProperties: 1,
      additionalProperties: false,
      description:
        "Duration for add/subtract. Integer fields, each optional but at least one required; |each| <= 10000.",
    },
    other_date: {
      type: "string",
      description: "Second date for diff (result is other_date - date). Same formats as `date`.",
    },
    weekday: {
      type: "string",
      description: "Target weekday for next_weekday: 'monday'..'sunday' (case-insensitive).",
    },
  },
  required: ["operation", "date"],
  additionalProperties: false,
} as const;

function fail(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

type ParseOutcome =
  | { ok: true; ms: number; dateOnly: boolean }
  | { ok: false; result: ToolResult };

/** True when parsing `ymd` (YYYY-MM-DD) did not roll the calendar over —
 *  V8 happily parses '2025-02-30' as March 2, so re-check the components. */
function calendarMatches(ymd: string, ms: number): boolean {
  const [y, mo, d] = ymd.split("-").map(Number);
  const parsed = new Date(ms);
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === mo - 1 && parsed.getUTCDate() === d;
}

/** Parse an ISO-8601 date-only or datetime string as a UTC instant. */
function parseDateArg(value: unknown, field: "date" | "other_date"): ParseOutcome {
  if (typeof value !== "string") {
    return { ok: false, result: fail("INVALID_DATE", `\`${field}\` must be an ISO-8601 date string`) };
  }
  const s = value.trim();
  if (DATE_ONLY_RE.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(ms) || !calendarMatches(s, ms)) {
      return { ok: false, result: fail("INVALID_DATE", `\`${field}\` is not a valid calendar date: '${s}'`) };
    }
    return { ok: true, ms, dateOnly: true };
  }
  const m = DATETIME_RE.exec(s);
  if (m) {
    // Naive datetime (no Z/offset) is treated as UTC by appending Z.
    const ms = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? "Z").toUpperCase()}`);
    // The calendar check only holds as-written for UTC instants; an offset
    // shifts the components, so re-check against the same-string UTC parse.
    const utcMs = Date.parse(`${m[1]}T${m[2]}Z`);
    if (!Number.isNaN(ms) && !Number.isNaN(utcMs) && calendarMatches(m[1], utcMs)) {
      return { ok: true, ms, dateOnly: false };
    }
  }
  return {
    ok: false,
    result: fail(
      "INVALID_DATE",
      `\`${field}\` is not ISO-8601 ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'): '${s}'`,
    ),
  };
}

function daysInUtcMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month + 1, 0); // day 0 of the next month = last day of `month`
  return d.getUTCDate();
}

/** Add calendar months (years pre-folded in) with month-end clamping. */
function addCalendarMonths(ms: number, months: number): number {
  if (months === 0) return ms;
  const d = new Date(ms);
  const idx = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInUtcMonth(year, month));
  const out = new Date(ms); // preserves time-of-day
  out.setUTCFullYear(year, month, day);
  return out.getTime();
}

function readAmount(raw: unknown): { ok: true; amount: Amount } | { ok: false; result: ToolResult } {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      result: fail("MISSING_AMOUNT", "`amount` (object) is required for add/subtract"),
    };
  }
  const rec = raw as Record<string, unknown>;
  const amount: Amount = { years: 0, months: 0, weeks: 0, days: 0, hours: 0, minutes: 0 };
  let present = 0;
  for (const field of AMOUNT_FIELDS) {
    const v = rec[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      return { ok: false, result: fail("INVALID_AMOUNT", `amount.${field} must be an integer`) };
    }
    if (Math.abs(v) > MAX_COMPONENT) {
      return {
        ok: false,
        result: fail("AMOUNT_OUT_OF_RANGE", `amount.${field} must be within ±${MAX_COMPONENT}`),
      };
    }
    amount[field] = v;
    present += 1;
  }
  if (present === 0) {
    return {
      ok: false,
      result: fail(
        "EMPTY_AMOUNT",
        "amount must include at least one of: years, months, weeks, days, hours, minutes",
      ),
    };
  }
  return { ok: true, amount };
}

function isUtcMidnight(ms: number): boolean {
  return ((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY === 0;
}

function formatUtc(ms: number, dateOnly: boolean): string {
  const iso = new Date(ms).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso;
}

function runAddSubtract(
  operation: "add" | "subtract",
  base: { ms: number; dateOnly: boolean },
  rawAmount: unknown,
): ToolResult {
  const read = readAmount(rawAmount);
  if (!read.ok) return read.result;
  const a = read.amount;
  const sign = operation === "subtract" ? -1 : 1;

  // Calendar part first (years fold into months, single month-end clamp)…
  let ms = addCalendarMonths(base.ms, sign * (a.years * 12 + a.months));
  // …then the exact spans (UTC has no DST, so a day is always 24 h).
  ms += sign * ((a.weeks * 7 + a.days) * MS_PER_DAY + a.hours * MS_PER_HOUR + a.minutes * MS_PER_MINUTE);

  // Date-only stays date-only unless hours/minutes moved it off midnight.
  const resultDateOnly = base.dateOnly && isUtcMidnight(ms);
  return {
    ok: true,
    data: {
      type: "date_math",
      operation,
      input: formatUtc(base.ms, base.dateOnly),
      result: formatUtc(ms, resultDateOnly),
    },
  };
}

function runDiff(base: { ms: number; dateOnly: boolean }, rawOther: unknown): ToolResult {
  if (rawOther === undefined || rawOther === null) {
    return fail("MISSING_OTHER_DATE", "`other_date` is required for diff");
  }
  const other = parseDateArg(rawOther, "other_date");
  if (!other.ok) return other.result;

  const diffMs = other.ms - base.ms;
  const absMs = Math.abs(diffMs);
  return {
    ok: true,
    data: {
      type: "date_math",
      operation: "diff",
      date: formatUtc(base.ms, base.dateOnly),
      otherDate: formatUtc(other.ms, other.dateOnly),
      // Signed totals; fractional when datetimes are involved (36 h → 1.5 days).
      totalDays: diffMs / MS_PER_DAY,
      totalHours: diffMs / MS_PER_HOUR,
      totalMinutes: diffMs / MS_PER_MINUTE,
      // Integer decomposition of the absolute difference.
      breakdown: {
        days: Math.floor(absMs / MS_PER_DAY),
        hours: Math.floor((absMs % MS_PER_DAY) / MS_PER_HOUR),
        minutes: Math.floor((absMs % MS_PER_HOUR) / MS_PER_MINUTE),
      },
      direction: diffMs > 0 ? "future" : diffMs < 0 ? "past" : "same",
    },
  };
}

function runNextWeekday(base: { ms: number; dateOnly: boolean }, rawWeekday: unknown): ToolResult {
  if (rawWeekday === undefined || rawWeekday === null) {
    return fail("MISSING_WEEKDAY", "`weekday` is required for next_weekday");
  }
  if (typeof rawWeekday !== "string") {
    return fail("INVALID_WEEKDAY", "`weekday` must be a string ('monday'..'sunday')");
  }
  const target = (WEEKDAYS as readonly string[]).indexOf(rawWeekday.trim().toLowerCase());
  if (target === -1) {
    return fail("INVALID_WEEKDAY", `unknown weekday '${rawWeekday}' — expected 'monday'..'sunday'`);
  }
  const current = new Date(base.ms).getUTCDay();
  // Strictly after `date`: the same weekday jumps a full week.
  let delta = (target - current + 7) % 7;
  if (delta === 0) delta = 7;
  const ms = base.ms + delta * MS_PER_DAY;
  return {
    ok: true,
    data: {
      type: "date_math",
      operation: "next_weekday",
      input: formatUtc(base.ms, base.dateOnly),
      result: formatUtc(ms, base.dateOnly),
      weekday: WEEKDAYS[target],
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const operation = args.operation;
  if (typeof operation !== "string" || !(OPERATIONS as readonly string[]).includes(operation)) {
    return fail("INVALID_OPERATION", "operation must be one of: add, subtract, diff, next_weekday");
  }
  const base = parseDateArg(args.date, "date");
  if (!base.ok) return base.result;

  switch (operation as Operation) {
    case "add":
    case "subtract":
      return runAddSubtract(operation as "add" | "subtract", base, args.amount);
    case "diff":
      return runDiff(base, args.other_date);
    case "next_weekday":
      return runNextWeekday(base, args.weekday);
  }
}

const tool: Tool = {
  name: "date_math",
  description:
    "Calendar/date arithmetic in UTC: 'add'/'subtract' a duration (years, months, weeks, days, hours, minutes — months clamp to month-end, e.g. Jan 31 + 1 month = Feb 28), 'diff' two dates (signed totals plus a days/hours/minutes breakdown of other_date - date), or 'next_weekday' (first occurrence strictly after the date). Accepts ISO-8601 date-only or datetime; naive datetimes are treated as UTC; date-only inputs yield date-only results. Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

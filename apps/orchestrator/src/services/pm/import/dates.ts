/**
 * WARP-3527 — read the dates a tracker export writes.
 *
 * Every tracker spells dates differently and the SAME tracker spells them
 * differently per instance (Jira's `d/MMM/yy h:mm a` is a per-site setting).
 * What we accept:
 *   2024-03-12            2024-03-12T09:41:00Z     2024-03-12 09:41
 *   12/Mar/24 9:41 AM     12-Mar-2024              Mar 12, 2024
 *   03/12/2024            12.03.2024               (numeric — order below)
 *
 * The one genuinely ambiguous family is numeric `a/b/yyyy`: 03/04/2024 is
 * March 4 in the US and 3 April everywhere else. We never guess per row.
 * `inferDateOrder` reads the WHOLE column — one value with a part over 12 is
 * proof of the order — and when no value settles it the result says
 * `ambiguous: true` so the wizard can ask, defaulting to month-first.
 *
 * Calendar dates are DATES (WS-1's rule): a due date is stored as 00:00:00Z of
 * the day as written, never converted through a time zone. Timestamps
 * (`createdAt`) are read as UTC when the file gives no offset.
 */

import type { DateOrder } from "./types.js";

export interface ParsedDate {
  year: number;
  month: number;
  day: number;
  hasTime: boolean;
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC when the text carried an offset; null when it did not. */
  offsetMinutes: number | null;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** A month name to 1..12, own keys only (a cell reading "valueOf" is not a month). */
function monthNumber(name: string): number | undefined {
  const k = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(MONTHS, k) ? MONTHS[k] : undefined;
}

// time-of-day tail shared by every pattern
const TIME = String.raw`(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*([AaPp][Mm])?\s*(Z|z|UTC|GMT|[+-]\d{2}:?\d{2})?)?`;
const ISO = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})${TIME}$`);
const NUMERIC = new RegExp(String.raw`^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})${TIME}$`);
const D_MON_Y = new RegExp(String.raw`^(\d{1,2})[\s/.\-]+([A-Za-z]{3,9})\.?[\s/.\-,]+(\d{2,4})${TIME}$`);
const MON_D_Y = new RegExp(String.raw`^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})${TIME}$`);

function fullYear(y: number, digits: number): number {
  if (digits >= 4) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function build(
  year: number,
  month: number,
  day: number,
  t: string[],
): ParsedDate | null {
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  let hasTime = false;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let offsetMinutes: number | null = null;
  if (t[0] !== undefined) {
    hasTime = true;
    hour = Number(t[0]);
    minute = Number(t[1]);
    second = t[2] !== undefined ? Number(t[2]) : 0;
    const ampm = t[3]?.toLowerCase();
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      if (ampm === "am" && hour === 12) hour = 0;
      if (ampm === "pm" && hour < 12) hour += 12;
    }
    if (hour > 23 || minute > 59 || second > 59) return null;
    const off = t[4];
    if (off) {
      if (/^(z|utc|gmt)$/i.test(off)) offsetMinutes = 0;
      else {
        const m = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
        if (m) offsetMinutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
      }
    }
  }
  return { year, month, day, hasTime, hour, minute, second, offsetMinutes };
}

/** Parse one cell. `order` only matters for numeric `a/b/yyyy`. */
export function parseImportDate(raw: string, order: DateOrder = "MDY"): ParsedDate | null {
  const s = raw.trim();
  if (s === "") return null;

  let m = ISO.exec(s);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]), m.slice(4));

  m = NUMERIC.exec(s);
  if (m) {
    const [a, b, c] = [m[1], m[2], m[3]];
    if (a.length === 4) return build(Number(a), Number(b), Number(c), m.slice(4)); // 2024/03/12
    if (c.length === 3) return null;
    const year = fullYear(Number(c), c.length);
    if (order === "DMY") return build(year, Number(b), Number(a), m.slice(4));
    if (order === "YMD") return null; // year-last text cannot be year-first
    return build(year, Number(a), Number(b), m.slice(4));
  }

  m = D_MON_Y.exec(s);
  if (m) {
    const month = monthNumber(m[2]);
    if (!month) return null;
    return build(fullYear(Number(m[3]), m[3].length), month, Number(m[1]), m.slice(4));
  }

  m = MON_D_Y.exec(s);
  if (m) {
    const month = monthNumber(m[1]);
    if (!month) return null;
    return build(fullYear(Number(m[3]), m[3].length), month, Number(m[2]), m.slice(4));
  }
  return null;
}

/** The calendar day as written: 00:00:00Z. Never shifted by an offset. */
export function toDateOnlyUtc(p: ParsedDate): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/** The instant, UTC when the text had no offset. */
export function toInstantUtc(p: ParsedDate): Date {
  const ms = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(ms - (p.offsetMinutes ?? 0) * 60_000);
}

export interface InferredOrder {
  order: DateOrder;
  /** True when the column cannot settle day-first vs month-first. */
  ambiguous: boolean;
}

/**
 * Decide day-first vs month-first from every value in a column. A numeric date
 * whose first part exceeds 12 can only be day-first; whose second part does,
 * only month-first. Both kinds present means the column is inconsistent, which
 * is reported as ambiguous too — importing it under either order would
 * silently mis-date half the rows.
 */
export function inferDateOrder(values: readonly string[]): InferredOrder {
  let sawNumeric = false;
  let firstOver12 = false;
  let secondOver12 = false;
  for (const v of values) {
    const m = NUMERIC.exec(v.trim());
    if (!m || m[1].length === 4) continue;
    sawNumeric = true;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (!sawNumeric) return { order: "MDY", ambiguous: false };
  if (firstOver12 && !secondOver12) return { order: "DMY", ambiguous: false };
  if (secondOver12 && !firstOver12) return { order: "MDY", ambiguous: false };
  return { order: "MDY", ambiguous: true };
}

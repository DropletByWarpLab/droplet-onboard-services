/**
 * WARP-1964 — value normalization for exported cells.
 *
 * A database column arrives typed; an exported cell arrives as whatever the
 * report writer printed. These three functions are where that difference is
 * absorbed, and they are the sharpest correctness surface on this track:
 * a mis-parsed timestamp silently drops a patient off today's schedule, and a
 * mis-parsed amount is wrong by a factor of a thousand.
 *
 * PURE: no I/O, no clock.
 */

/** Trim a cell; an empty or whitespace-only cell becomes `undefined`, which is
 *  what a NULL column yields on the SQL track and what `api-dto.projectRow`
 *  yields for a field the API omitted. */
export function normalizeText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

const ISO_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;

const US_RE =
  /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]\.?M\.?)?)?$/i;

/**
 * Build a UTC millisecond value from calendar parts, rejecting any combination
 * that is not a real date.
 *
 * `Date.UTC` silently rolls over — `Date.UTC(2026, 12, 45)` is a valid instant
 * some way into the next year, and `2026-02-30` becomes March. Left unchecked
 * that turns a mis-mapped column (a phone number, an account code) into a
 * confident, wrong appointment time rather than an honest "cannot parse". So
 * the parts are read back off the constructed date and required to match.
 */
function utcFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
): number | undefined {
  // Out-of-range minutes and seconds roll WITHIN a day, so the calendar
  // round-trip below cannot see them: `9:70` would quietly become `10:10`.
  // Out-of-range months, days and hours all shift the date, so they need no
  // separate check — the round-trip catches every one of them.
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (!Number.isFinite(utc)) return undefined;
  const back = new Date(utc);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return undefined;
  }
  return utc;
}

/** Apply a `Z` / `±HH:MM` suffix to a wall-clock UTC millisecond value. */
function applyOffset(utcMs: number, offset: string | undefined): number {
  if (!offset || offset.toUpperCase() === "Z") return utcMs;
  const sign = offset.startsWith("-") ? 1 : -1;
  const digits = offset.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return utcMs + sign * (hours * 60 + minutes) * 60_000;
}

/**
 * Parse an exported date/time into the canonical `YYYY-MM-DDTHH:mm:ss.sssZ`
 * form, or `undefined` when the cell is not a date this function recognises.
 *
 * Recognises ISO-8601 (`2026-08-14T09:30:00Z`, `2026-08-14 09:30`,
 * `2026-08-14`) and the US layout a Windows report writer produces
 * (`8/14/2026 9:30 AM`, `08/14/2026 14:05`). An explicit `Z` or `±HH:MM` is
 * honoured.
 *
 * **A value with no zone is treated as UTC**, deliberately. `scheduleDayBounds`
 * in the read registry builds its `[from, to)` window as
 * `${date}T00:00:00.000Z`, so the SQL track already compares a practice's
 * local wall-clock column against UTC bounds. Converting here would make this
 * track disagree with the other two about which appointments are "today".
 * Real local-timezone day boundaries are the WARP-1095 refinement noted in
 * `read-queries.ts`, and they belong in one place for all three tracks.
 *
 * `Date` string parsing is deliberately not used: for anything that is not
 * strict ISO its behaviour is implementation-defined, and `new Date("8/14/2026")`
 * silently applies the *host's* timezone — which would make the box's own TZ
 * setting change which patients appear on the schedule.
 */
export function parseExportTimestamp(raw: string | undefined): string | undefined {
  const text = normalizeText(raw);
  if (text === undefined) return undefined;

  const iso = ISO_RE.exec(text);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0", off] = iso;
    const utc = utcFromParts(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms.padEnd(3, "0")),
    );
    if (utc === undefined) return undefined;
    return new Date(applyOffset(utc, off)).toISOString();
  }

  const us = US_RE.exec(text);
  if (us) {
    const [, mo, d, y, h = "0", mi = "0", s = "0", meridiem] = us;
    let hour = Number(h);
    if (meridiem) {
      // 12 AM is midnight and 12 PM is noon — the one case where the usual
      // "add twelve for PM" rule is wrong in both directions.
      const pm = /^p/i.test(meridiem);
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
      // No separate 1–12 range check: a nonsense "13:00 PM" becomes hour 25 and
      // is rejected by the bound in utcFromParts.
    }
    const utc = utcFromParts(Number(y), Number(mo), Number(d), hour, Number(mi), Number(s));
    if (utc === undefined) return undefined;
    return new Date(utc).toISOString();
  }

  return undefined;
}

/**
 * Parse an exported monetary amount, or `undefined` when the cell is not a
 * number. Handles a currency symbol, thousands separators, a trailing or
 * leading sign, and the accounting convention where parentheses mean negative
 * (`(1,234.56)` → `-1234.56`), which is what an AR ageing report prints.
 *
 * Separator disambiguation: when both `.` and `,` appear, the **last** one is
 * the decimal separator, which resolves `1,234.56` and `1.234,56` correctly.
 * When only commas appear, a single comma followed by exactly two digits is
 * read as a decimal separator (`12,50`) and anything else as thousands
 * (`1,234`). That last case is genuinely ambiguous in the abstract; this is the
 * standard reading, and it is unit-tested both ways so a change is visible.
 */
export function parseMoney(raw: string | undefined): number | undefined {
  const text = normalizeText(raw);
  if (text === undefined) return undefined;

  let negative = false;
  let body = text;

  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
  }

  // Strip everything that is not a digit, separator or sign (currency symbols,
  // non-breaking spaces, stray letters like a trailing "CR").
  body = body.replace(/[^\d.,+-]/g, "");

  if (body.startsWith("-")) {
    negative = !negative;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }
  if (body.endsWith("-")) {
    negative = !negative;
    body = body.slice(0, -1);
  }
  if (body === "") return undefined;

  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");

  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const intPart = body.slice(0, decimalAt).replace(/[.,]/g, "");
    const fracPart = body.slice(decimalAt + 1).replace(/[.,]/g, "");
    normalized = `${intPart}.${fracPart}`;
  } else if (lastComma >= 0) {
    const commaCount = (body.match(/,/g) ?? []).length;
    const trailingDigits = body.length - lastComma - 1;
    if (commaCount === 1 && trailingDigits === 2) {
      normalized = `${body.slice(0, lastComma)}.${body.slice(lastComma + 1)}`;
    } else {
      normalized = body.replace(/,/g, "");
    }
  } else {
    normalized = body;
  }

  if (!/^\d*\.?\d*$/.test(normalized) || normalized === "" || normalized === ".") return undefined;

  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  return negative ? -value : value;
}

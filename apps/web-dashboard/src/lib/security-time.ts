/**
 * WARP-2977 P2b (ADR-059 §3.6) — time on the Security pages is SITE time.
 *
 * The opening hours, the mode card and the special days all speak in the
 * site's timezone (`SecurityModeView.displayTimezone` /
 * `SecurityHoursView.timezone`), never the browser's: an owner checking
 * "Closes at 6:00 PM" from another city must read the shop's 6 PM. Every
 * formatter here therefore TAKES the zone — none defaults to the device's.
 * The one fallback: the mode card formats in `deviceTimeZone()` when
 * `displayTimezone` is null (no hours set and no valid workspace zone).
 * Never UTC.
 *
 * Output is en-US ("6:00 PM"), matching the rest of the dashboard's copy, with
 * the narrow no-break space newer ICU puts before AM/PM normalised to a plain
 * space so copy and tests compare as written.
 */

const LOCALE = "en-US";

/** ICU ≥ 72 separates "6:00" and "PM" with U+202F; some zones use U+00A0. */
function plainSpaces(s: string): string {
  return s.replace(/[  ]/g, " ");
}

function toDate(instant: string | Date): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

/** 'HH:MM' (24 h, as `<input type="time">` gives it) → minutes since midnight, or null when malformed. */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since midnight (0–1439) → 'HH:MM'. Throws on anything else — a caller bug, never user input. */
export function minutesToHhmm(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new RangeError(`minutes out of range: ${minutes}`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 'HH:MM' → "6:00 PM", for showing an opening-hours value (a wall time, no zone involved). */
export function formatWallTime(hhmm: string): string {
  const minutes = hhmmToMinutes(hhmm);
  if (minutes === null) return hhmm;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The instant's clock time in the site zone: "6:00 PM". */
export function formatSiteTime(instant: string | Date, timeZone: string): string {
  return plainSpaces(
    new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "numeric", minute: "2-digit" }).format(toDate(instant)),
  );
}

/** The instant's site-local calendar date, 'YYYY-MM-DD'. */
export function siteDateOf(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(toDate(instant));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days from site-local date `a` to `b` (both 'YYYY-MM-DD'). */
function dayDiff(a: string, b: string): number {
  const ms = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/**
 * An instant as the mode card says it, relative to `now`, in the site zone:
 *   · same site day        → "6:00 PM"
 *   · the next site day    → "9:00 AM tomorrow"
 *   · within 6 days either way → "Fri 6:02 PM"
 *   · further              → "Sep 30, 6:02 PM"
 */
export function formatSiteWhen(instant: string | Date, timeZone: string, now: Date): string {
  const at = toDate(instant);
  const time = formatSiteTime(at, timeZone);
  const diff = dayDiff(siteDateOf(now, timeZone), siteDateOf(at, timeZone));
  if (diff === 0) return time;
  if (diff === 1) return `${time} tomorrow`;
  if (Math.abs(diff) <= 6) {
    const weekday = new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: "short" }).format(at);
    return `${weekday} ${time}`;
  }
  const date = new Intl.DateTimeFormat(LOCALE, { timeZone, month: "short", day: "numeric" }).format(at);
  return `${plainSpaces(date)}, ${time}`;
}

/**
 * The device's own zone. Only ever a SUGGESTION next to the site zone in the
 * hours editor, and the mode card's display zone when
 * `SecurityModeView.displayTimezone` is null. Never a default for the hours.
 */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

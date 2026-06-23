/**
 * Calendar UX clarity (Samantha QA #bugs) — pure helpers behind the
 * date + 15-minute time-dropdown picker (<DateTimePicker>).
 *
 * The picker keeps the *exact* contract the native `datetime-local` inputs
 * used: its value is a `YYYY-MM-DDTHH:mm` **local** string (no timezone
 * suffix). EventForm's isoToLocalInput / localInputToIso and the
 * duration-slide logic in handleStartChange both operate on that same string,
 * so as long as we split and recombine it losslessly the surrounding ISO
 * round-trip is unchanged.
 */

export interface LocalParts {
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:mm` */
  time: string;
}

export interface TimeOption {
  /** `HH:mm`, the machine value also fed back into the local-input string. */
  value: string;
  /** Display label in 24-hour `HH:mm` format, e.g. "09:30". */
  label: string;
}

/** The picker's time granularity: a dropdown slot every 15 minutes. */
export const QUARTER_HOUR_MINUTES = 15;

/**
 * Split a `YYYY-MM-DDTHH:mm[:ss]` local-input string into its date + time
 * parts. A trailing seconds component (some browsers emit `:00`) is dropped so
 * the time always lines up with the HH:mm grid. An empty input yields empty
 * parts.
 */
export function splitLocalInput(value: string): LocalParts {
  if (!value) return { date: "", time: "" };
  const [date = "", rawTime = ""] = value.split("T");
  // Keep only HH:mm even if a :ss (or :ss.mmm) suffix is present.
  const time = rawTime.slice(0, 5);
  return { date, time };
}

/**
 * Recombine a date + time back into a `YYYY-MM-DDTHH:mm` local-input string.
 * If either part is missing we return an empty string so a half-filled picker
 * doesn't emit a malformed (unparseable) value to the form.
 */
export function joinLocalInput(date: string, time: string): string {
  if (!date || !time) return "";
  return `${date}T${time}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The 96 quarter-hour slots of a day, 00:00 → 23:45, each with a 24-hour
 * "HH:mm" display label. The locale is pinned to "en-GB" (24 h clock, no
 * AM/PM) so server-side pre-render and browser hydration always produce
 * identical option text, preventing React hydration mismatches on locales that
 * default to a 12-hour clock (e.g. en-US).
 */
export function quarterHourOptions(): TimeOption[] {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const opts: TimeOption[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += QUARTER_HOUR_MINUTES) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const value = `${pad2(h)}:${pad2(m)}`;
    // A neutral anchor date — only the time portion is formatted.
    const label = fmt.format(new Date(2026, 0, 1, h, m));
    opts.push({ value, label });
  }
  return opts;
}

/**
 * Snap an arbitrary `HH:mm` to the nearest quarter-hour grid slot so a value
 * carried over from a free-typed or imported time still selects an option in
 * the dropdown. Clamped to the day's last slot (23:45) so rounding 23:53 up
 * never rolls into the next day.
 */
export function snapTimeToQuarter(time: string): string {
  if (!time) return "";
  const [hStr = "0", mStr = "0"] = time.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  const total = h * 60 + m;
  const snapped =
    Math.round(total / QUARTER_HOUR_MINUTES) * QUARTER_HOUR_MINUTES;
  const lastSlot = 24 * 60 - QUARTER_HOUR_MINUTES; // 23:45
  const clamped = Math.min(snapped, lastSlot);
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

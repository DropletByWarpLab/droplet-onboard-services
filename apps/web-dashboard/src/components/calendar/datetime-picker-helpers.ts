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
 * Build the 96 quarter-hour slots of a day, 00:00 → 23:45. `value` is always
 * the machine `HH:mm` string regardless of locale — only `label` is localized.
 */
function buildQuarterHourOptions(
  fmt: Intl.DateTimeFormat,
): TimeOption[] {
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
 * Quarter-hour slots with 24-hour "HH:mm" labels, locale pinned to "en-GB".
 *
 * The pin is a hydration constraint, not a formatting preference: the server
 * pre-render and the browser's FIRST render must emit byte-identical option
 * text, and the server has no way to know the visitor's clock format. Any
 * attempt to localize here directly re-introduces the React hydration mismatch
 * this pin was added to prevent.
 *
 * Renderers should pair this with {@link quarterHourOptionsForDevice}, swapping
 * to it after mount — see `DateTimePicker` (WARP-1793).
 */
export function quarterHourOptions(): TimeOption[] {
  return buildQuarterHourOptions(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }),
  );
}

/**
 * The same 96 slots labelled in the **device's own** locale and clock format —
 * "9:45 AM" where the phone is set to 12-hour, "09:45" where it is set to 24.
 *
 * WARP-1793: QA read "09:45"/"14:30" on a US iPhone and had to double-check
 * whether an afternoon meeting had landed in the morning. `hour: "numeric"`
 * (not "2-digit") is deliberate so en-US reads "9:45 AM" rather than the
 * clumsier "09:45 AM".
 *
 * CLIENT ONLY. Calling this during SSR or in the first client render will
 * desynchronize hydration for every visitor whose locale is not en-GB.
 */
export function quarterHourOptionsForDevice(): TimeOption[] {
  return buildQuarterHourOptions(
    // `undefined` locale = the runtime's own resolved locale.
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
  );
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

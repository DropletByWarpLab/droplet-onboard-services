import type { FileEntryInfo } from "./types";

/**
 * WARP-1916 — day-filter helpers for the Recents page.
 *
 * Day boundaries are the USER'S LOCAL day: "what did I touch on July 23"
 * means July 23 on the user's own clock, so every comparison goes through
 * local Date components — never a UTC slice of the ISO string, which would
 * shift late-evening (or early-morning, west of UTC) files onto the wrong
 * calendar day.
 */

/** Local-calendar day key (`YYYY-MM-DD`) for an ISO timestamp. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Files whose modified timestamp falls on `day` (a `YYYY-MM-DD` string, as
 * produced by an `<input type="date">`) in the user's local timezone.
 * Preserves the incoming order — recents arrive newest-first.
 */
export function filterByDay(files: FileEntryInfo[], day: string): FileEntryInfo[] {
  return files.filter((f) => localDayKey(f.modifiedAt) === day);
}

/**
 * Human heading for a `YYYY-MM-DD` day, e.g. "Thursday, July 23, 2026".
 * Parsed via `T00:00:00` (LOCAL midnight) on purpose: a bare `new Date(day)`
 * is UTC midnight and renders the previous day anywhere west of UTC.
 */
export function formatDayHeading(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

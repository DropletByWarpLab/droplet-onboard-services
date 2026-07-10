import type { CalendarEvent } from "@/lib/hooks/useCalendar";

/** Local-day key (`YYYY-MM-DD`) used to bucket and mark days across the calendar
 *  surface. Single source of truth — previously duplicated verbatim in
 *  `calendar/page.tsx`, `MiniMonth.tsx`, and `MonthView.tsx`. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse a `?date=YYYY-MM-DD` deep-link param (Home calendar widget →
 *  /calendar, WARP-1131) into a local-midnight Date. Returns null for
 *  anything malformed (wrong shape) or non-existent (e.g. 2026-02-31 —
 *  the Date constructor would silently roll it into March) so callers can
 *  fall back to today. */
export function parseDateParam(raw: string | null | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const exists =
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  return exists ? date : null;
}

/** Distinct hues for subscribed calendars in the rail. Local events use the
 *  brand accent; external sources draw from this palette via {@link paletteColor}. */
export const SOURCE_PALETTE = ["#0891b2", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"];

/** Shared key + neutral swatch for the "Other calendars" catch-all row — events
 *  that aren't local and don't map to a currently-known source. */
export const EXTERNAL_KEY = "external";
export const EXTERNAL_COLOR = "#94a3b8";

/** Stable color for a source id: the id is hashed into {@link SOURCE_PALETTE}
 *  so a given calendar keeps its color regardless of fetch order or how many
 *  sources exist. The previous positional `palette[i % n]` reshuffled colors
 *  when sources reordered and silently repeated past `n` sources. */
export function paletteColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return SOURCE_PALETTE[Math.abs(h) % SOURCE_PALETTE.length];
}

/** Canonical visibility key for an event, shared by the show/hide filter and
 *  the rail's "Calendars" rows so both sides key off the same identity. Local
 *  events → `"local"`; events from a *known* source → that source id; anything
 *  else (a null or unrecognized `sourceId`) → {@link EXTERNAL_KEY} so it stays
 *  toggleable via the catch-all row rather than being permanently visible with
 *  no control. */
export function eventVisibilityKey(e: CalendarEvent, knownSourceIds: Set<string>): string {
  if (e.source === "local") return "local";
  if (e.sourceId && knownSourceIds.has(e.sourceId)) return e.sourceId;
  return EXTERNAL_KEY;
}

/** Chronological comparator by start time. Compares epoch millis rather than
 *  the raw ISO strings: sources that emit zoned offsets (`+02:00`) or differing
 *  precision sort correctly, and it stays consistent with the `.getTime()`
 *  filters used elsewhere on the same list. */
export function compareByStart(a: CalendarEvent, b: CalendarEvent): number {
  return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
}

/**
 * WARP-1916 — day-filter helpers for the Recents page.
 *
 * Day boundaries are the USER'S LOCAL day: a file saved at 23:59 belongs to
 * that evening's date, not to whatever day it was in UTC. Every fixture is
 * built from local-time Date components (never `new Date()` "now", never a
 * hand-written `Z` timestamp), so the assertions hold in any timezone and
 * can't flake across midnight.
 */
import { describe, it, expect } from "vitest";
import { localDayKey, filterByDay, formatDayHeading } from "./recents-day-filter";
import type { FileEntryInfo } from "./types";

/** ISO timestamp for a LOCAL wall-clock moment (month is 1-based). */
const localIso = (y: number, m: number, d: number, hh = 12, mm = 0, ss = 0) =>
  new Date(y, m - 1, d, hh, mm, ss).toISOString();

const file = (name: string, modifiedAt: string): FileEntryInfo => ({
  name,
  path: `/${name}`,
  isDirectory: false,
  size: 1024,
  modifiedAt,
  mimeType: "text/plain",
});

describe("localDayKey — local-calendar day of a timestamp", () => {
  it("maps a mid-day timestamp to its local date", () => {
    expect(localDayKey(localIso(2026, 7, 23, 14, 30))).toBe("2026-07-23");
  });

  it("start of the local day (00:00:00) belongs to that day", () => {
    // In any non-UTC timezone this moment sits on a DIFFERENT UTC date than
    // local date — a UTC-based implementation returns the wrong key here.
    expect(localDayKey(localIso(2026, 7, 23, 0, 0, 0))).toBe("2026-07-23");
  });

  it("end of the local day (23:59:59) still belongs to that day", () => {
    expect(localDayKey(localIso(2026, 7, 23, 23, 59, 59))).toBe("2026-07-23");
  });

  it("one second before local midnight is the PREVIOUS day", () => {
    expect(localDayKey(localIso(2026, 7, 22, 23, 59, 59))).toBe("2026-07-22");
  });

  it("zero-pads single-digit months and days", () => {
    expect(localDayKey(localIso(2026, 3, 5, 9, 0))).toBe("2026-03-05");
  });
});

describe("filterByDay — narrows a recents list to one local day", () => {
  const jul22Late = file("late-night.md", localIso(2026, 7, 22, 23, 59, 59));
  const jul23Start = file("first-thing.md", localIso(2026, 7, 23, 0, 0, 0));
  const jul23Mid = file("budget.xlsx", localIso(2026, 7, 23, 14, 5));
  const jul24 = file("next-day.md", localIso(2026, 7, 24, 0, 0, 0));
  const all = [jul22Late, jul23Start, jul23Mid, jul24];

  it("keeps exactly the files modified on the chosen day, inclusive of both edges", () => {
    expect(filterByDay(all, "2026-07-23")).toEqual([jul23Start, jul23Mid]);
  });

  it("a 23:59:59 file the night before never leaks into the next day", () => {
    expect(filterByDay(all, "2026-07-23")).not.toContain(jul22Late);
  });

  it("the chosen day's own midnight file never leaks into the day before", () => {
    expect(filterByDay(all, "2026-07-22")).toEqual([jul22Late]);
  });

  it("returns [] when nothing was touched that day", () => {
    expect(filterByDay(all, "2026-07-21")).toEqual([]);
  });

  it("preserves the incoming order (recents arrive newest-first)", () => {
    const reversed = [jul23Mid, jul23Start];
    expect(filterByDay(reversed, "2026-07-23")).toEqual([jul23Mid, jul23Start]);
  });
});

describe("formatDayHeading — human heading for a YYYY-MM-DD day", () => {
  it("formats the day as a local calendar date, never shifted by UTC parsing", () => {
    // Independent construction: numeric local-Date components vs the
    // helper's string input. A `new Date("2026-07-23")` (UTC-midnight)
    // implementation renders July 22 in any timezone west of UTC.
    const expected = new Date(2026, 6, 23).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    expect(formatDayHeading("2026-07-23")).toBe(expected);
  });

  it("handles zero-padded single-digit months and days", () => {
    const expected = new Date(2026, 2, 5).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    expect(formatDayHeading("2026-03-05")).toBe(expected);
  });
});

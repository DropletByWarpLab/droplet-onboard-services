// Pure helpers for the time surface (WARP-3526): duration parsing and display,
// and calendar-date arithmetic that never reads the machine's zone by accident.

import { describe, it, expect } from "vitest";
import {
  addDays,
  browserTimeZone,
  entryDay,
  fmtYmd,
  formatClock,
  formatMinutes,
  formatWeekRange,
  mondayOf,
  parseDuration,
  startedAtForDay,
  weekdayShort,
  ymdInZone,
} from "./format";

describe("formatMinutes", () => {
  it("reads as a person would say it", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(5)).toBe("5m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(1440)).toBe("24h");
  });

  it("does not show a negative or fractional number of minutes", () => {
    expect(formatMinutes(-5)).toBe("0m");
    expect(formatMinutes(89.6)).toBe("1h 30m");
  });
});

describe("parseDuration", () => {
  it.each([
    ["90", 90],
    [" 15 ", 15],
    ["45m", 45],
    ["45 min", 45],
    ["45 minutes", 45],
    ["1h", 60],
    ["2 hours", 120],
    ["1hr", 60],
    ["1h30m", 90],
    ["1h 30m", 90],
    ["1 hour 30 minutes", 90],
    ["1h and 30m", 90],
    ["1.5h", 90],
    ["1,5h", 90],
    ["0.25h", 15],
    ["1:30", 90],
    ["0:45", 45],
    ["24h", 1440],
    ["1440", 1440],
    ["1H 30M", 90],
  ])("reads %j as %i minutes", (input, minutes) => {
    expect(parseDuration(input)).toBe(minutes);
  });

  it.each([
    "",
    "   ",
    "abc",
    "0",
    "0m",
    "-5",
    "1441",
    "25h",
    "24h 1m",
    "1.5", // a bare decimal is neither minutes nor hours — ambiguous, so refused
    "1:60",
    "1h30", // a trailing number with no unit
    "1x",
    "h",
    "30m 1h 5",
  ])("refuses %j", (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});

describe("formatClock", () => {
  it("is a running clock, hours not wrapping at a day", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(12 * 60_000 + 34_000)).toBe("00:12:34");
    expect(formatClock(3_600_000 + 5_000)).toBe("01:00:05");
    expect(formatClock(26 * 3_600_000)).toBe("26:00:00");
    expect(formatClock(-5000)).toBe("00:00:00");
  });
});

describe("calendar dates (YYYY-MM-DD)", () => {
  it("adds days across month, year and leap-day edges, in UTC arithmetic", () => {
    expect(addDays("2026-09-28", 7)).toBe("2026-10-05");
    expect(addDays("2026-12-29", 7)).toBe("2027-01-05");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("finds the Monday on or before any date", () => {
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(mondayOf("2026-09-30")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28"); // a Sunday
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
  });

  it("names the weekday and the day for a column header", () => {
    expect(weekdayShort("2026-09-28")).toBe("Mon");
    expect(weekdayShort("2026-10-04")).toBe("Sun");
    expect(fmtYmd("2026-09-28")).toBe("Sep 28");
  });

  it("labels a week, with the year once unless it spans two", () => {
    expect(formatWeekRange("2026-09-28")).toBe("Sep 28 – Oct 4, 2026");
    expect(formatWeekRange("2026-12-28")).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});

describe("zone-aware days", () => {
  it("reads the calendar date on the wall clock in the zone, not in UTC", () => {
    const instant = new Date("2026-10-05T03:30:00.000Z");
    expect(ymdInZone(instant, "UTC")).toBe("2026-10-05");
    expect(ymdInZone(instant, "America/Los_Angeles")).toBe("2026-10-04");
    expect(ymdInZone(instant, "Pacific/Kiritimati")).toBe("2026-10-05");
  });

  it("files an entry under the local day it started on", () => {
    expect(entryDay("2026-10-05T03:30:00.000Z", "America/Los_Angeles")).toBe("2026-10-04");
  });

  it("falls back to UTC rather than throwing when the browser reports no zone", () => {
    expect(typeof browserTimeZone()).toBe("string");
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});

describe("startedAtForDay — when a hand-logged entry says the work began", () => {
  it("is nothing for a NEW entry today: the box stamps its own clock, so a fast browser clock can never make today the future", () => {
    expect(startedAtForDay("2026-10-04", "2026-10-04")).toBeUndefined();
  });

  it("is local midday for any other day, whichever zone the browser is in", () => {
    const iso = startedAtForDay("2026-10-01", "2026-10-04");
    expect(iso).toBeDefined();
    const d = new Date(iso as string);
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(0);
    expect(ymdInZone(d, browserTimeZone())).toBe("2026-10-01");
  });

  it("for an EDIT onto today must say something — the earlier of now and local midday, never nothing", () => {
    // Local-time strings (no offset), so the test does not depend on the runner's zone.
    const morning = new Date("2026-10-04T08:00:00");
    const afternoon = new Date("2026-10-04T15:00:00");
    expect(startedAtForDay("2026-10-04", "2026-10-04", morning)).toBe(morning.toISOString());
    expect(startedAtForDay("2026-10-04", "2026-10-04", afternoon)).toBe(new Date("2026-10-04T12:00:00").toISOString());
  });

  it("is local midday for an edit onto another day, exactly as for a new entry", () => {
    expect(startedAtForDay("2026-10-01", "2026-10-04", new Date("2026-10-04T08:00:00"))).toBe(
      startedAtForDay("2026-10-01", "2026-10-04"),
    );
  });
});

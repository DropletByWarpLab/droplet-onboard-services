// WARP-3523 — date-only arithmetic. The AC: "Dates round-trip as calendar
// dates. Dragging across a DST boundary keeps the calendar date." Pinned to
// zones west and east of UTC, including ones whose DST change falls inside the
// dates under test (LA fall-back 2026-11-01, Auckland spring-forward 2026-09-27).

import { describe, it, expect, afterAll } from "vitest";
import {
  addDays,
  addMonths,
  compareDateOnly,
  dayNumber,
  daysInMonth,
  diffDays,
  eachDay,
  endOfMonth,
  formatDay,
  fromDayNum,
  isDateOnly,
  isPlausibleScheduleDate,
  MAX_YEAR,
  MIN_YEAR,
  parseDateOnly,
  plausibleScheduleRange,
  startOfMonth,
  startOfWeek,
  todayLocal,
  toWireDate,
  weekdayOf,
  weekdayShort,
} from "./dateOnly";

const originalTz = process.env.TZ;
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const ZONES = ["America/Los_Angeles", "Pacific/Auckland", "UTC", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago"];

describe("isDateOnly", () => {
  it("accepts real calendar dates, leap days included", () => {
    expect(isDateOnly("2026-10-03")).toBe(true);
    expect(isDateOnly("2028-02-29")).toBe(true);
    expect(isDateOnly("2000-02-29")).toBe(true);
  });

  it("rejects impossible, malformed and non-string input", () => {
    expect(isDateOnly("2026-02-30")).toBe(false);
    expect(isDateOnly("2027-02-29")).toBe(false);
    expect(isDateOnly("1900-02-29")).toBe(false);
    expect(isDateOnly("2026-13-01")).toBe(false);
    expect(isDateOnly("2026-00-10")).toBe(false);
    expect(isDateOnly("2026-10-00")).toBe(false);
    expect(isDateOnly("2026-1-3")).toBe(false);
    expect(isDateOnly("2026-10-03T00:00:00.000Z")).toBe(false);
    expect(isDateOnly(null)).toBe(false);
    expect(isDateOnly(20261003)).toBe(false);
  });
});

describe("the year is bounded, so a keystroke is never a date", () => {
  it("accepts 1900 through 2200 and nothing outside", () => {
    expect([MIN_YEAR, MAX_YEAR]).toEqual([1900, 2200]);
    expect(isDateOnly("1900-01-01")).toBe(true);
    expect(isDateOnly("2200-12-31")).toBe(true);
    expect(isDateOnly("1899-12-31")).toBe(false);
    expect(isDateOnly("2201-01-01")).toBe(false);
  });

  it("refuses the intermediate values a segmented date input reports while the year is typed", () => {
    for (const typed of ["0002-10-20", "0020-10-20", "0202-10-20", "0000-10-20", "9999-12-31"]) {
      expect(isDateOnly(typed)).toBe(false);
    }
    expect(isDateOnly("2026-10-20")).toBe(true);
  });

  it("an API value in an implausible year reads as no date rather than as a date nobody meant", () => {
    expect(parseDateOnly("0002-10-20T00:00:00.000Z")).toBeNull();
    expect(parseDateOnly("0002-10-20")).toBeNull();
    expect(parseDateOnly("2026-10-20T00:00:00.000Z")).toBe("2026-10-20");
  });

  it("the plausible span for scheduling is five years back to twenty ahead of today", () => {
    expect(plausibleScheduleRange("2026-10-03")).toEqual({ min: "2021-01-01", max: "2046-12-31" });
    // Clamped to the hard bounds at the edges of the calendar.
    expect(plausibleScheduleRange("1902-06-01").min).toBe("1900-01-01");
    expect(plausibleScheduleRange("2199-06-01").max).toBe("2200-12-31");
    expect(isPlausibleScheduleDate("2021-01-01", "2026-10-03")).toBe(true);
    expect(isPlausibleScheduleDate("2046-12-31", "2026-10-03")).toBe(true);
    expect(isPlausibleScheduleDate("2020-12-31", "2026-10-03")).toBe(false);
    expect(isPlausibleScheduleDate("2047-01-01", "2026-10-03")).toBe(false);
    expect(isPlausibleScheduleDate("0202-10-20", "2026-10-03")).toBe(false);
    expect(isPlausibleScheduleDate("2026-02-30", "2026-10-03")).toBe(false);
    expect(isPlausibleScheduleDate("", "2026-10-03")).toBe(false);
  });
});

describe("day numbers agree with UTC for every day 1899..2101 (the oracle)", () => {
  it("round-trips and matches Date.UTC", () => {
    let n = Math.round(Date.UTC(1899, 11, 31) / 86_400_000);
    const end = Math.round(Date.UTC(2101, 0, 1) / 86_400_000);
    for (; n <= end; n += 1) {
      const iso = new Date(n * 86_400_000).toISOString().slice(0, 10);
      expect(fromDayNum(n)).toBe(iso);
      expect(dayNumber(iso)).toBe(n);
    }
  });

  it("weekdayOf matches the UTC weekday", () => {
    for (let n = 17_000; n < 22_000; n += 1) {
      const date = new Date(n * 86_400_000);
      expect(weekdayOf(date.toISOString().slice(0, 10))).toBe(date.getUTCDay());
    }
  });
});

describe("arithmetic", () => {
  it("addDays crosses month, year and leap boundaries in both directions", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-03", 0)).toBe("2026-10-03");
    expect(addDays("2026-10-03", 366)).toBe("2027-10-04");
  });

  it("diffDays is signed and exact", () => {
    expect(diffDays("2026-10-03", "2026-10-03")).toBe(0);
    expect(diffDays("2026-10-03", "2026-10-10")).toBe(7);
    expect(diffDays("2026-10-10", "2026-10-03")).toBe(-7);
    expect(diffDays("2026-10-31", "2026-11-02")).toBe(2);
    expect(diffDays("2026-01-01", "2027-01-01")).toBe(365);
  });

  it("addMonths clamps the day into the target month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-10-15", 3)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("month and week anchors", () => {
    expect(startOfMonth("2026-10-17")).toBe("2026-10-01");
    expect(endOfMonth("2026-10-17")).toBe("2026-10-31");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(daysInMonth(2026, 2)).toBe(28);
    // 2026-10-03 is a Saturday.
    expect(weekdayOf("2026-10-03")).toBe(6);
    expect(startOfWeek("2026-10-03", 0)).toBe("2026-09-27");
    expect(startOfWeek("2026-10-03", 1)).toBe("2026-09-28");
    expect(startOfWeek("2026-09-27", 0)).toBe("2026-09-27");
    expect(startOfWeek("2026-09-27", 1)).toBe("2026-09-21");
  });

  it("eachDay is inclusive, empty when reversed, and bounded", () => {
    expect(eachDay("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(eachDay("2026-11-02", "2026-10-30")).toEqual([]);
    expect(eachDay("2026-01-01", "2030-01-01", 10)).toHaveLength(10);
  });

  it("compares chronologically", () => {
    expect(compareDateOnly("2026-10-03", "2026-10-04")).toBe(-1);
    expect(compareDateOnly("2027-01-01", "2026-12-31")).toBe(1);
    expect(compareDateOnly("2026-10-03", "2026-10-03")).toBe(0);
  });
});

describe("wire values", () => {
  it("parses the API's ISO datetime (UTC midnight) and a bare date to the same calendar date", () => {
    expect(parseDateOnly("2026-10-03T00:00:00.000Z")).toBe("2026-10-03");
    expect(parseDateOnly("2026-10-03")).toBe("2026-10-03");
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly("")).toBeNull();
    expect(parseDateOnly("not a date")).toBeNull();
  });

  it("a date that does not exist is not a date, even though the shared reader would pass it through", () => {
    expect(parseDateOnly("2026-02-30")).toBeNull();
    expect(parseDateOnly("2026-02-30T00:00:00.000Z")).toBeNull();
    expect(parseDateOnly("2028-02-29T00:00:00.000Z")).toBe("2028-02-29");
  });

  it("serialises a calendar date as UTC midnight, exactly what PATCH's z.string().datetime() takes", () => {
    expect(toWireDate("2026-10-03")).toBe("2026-10-03T00:00:00.000Z");
    expect(new Date(toWireDate("2026-10-03")).toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });
});

describe.each(ZONES)("calendar dates are zone-independent — TZ=%s", (tz) => {
  it("an API date reads back as the same calendar date and label", () => {
    process.env.TZ = tz;
    const wire = toWireDate("2026-10-03");
    expect(parseDateOnly(wire)).toBe("2026-10-03");
    expect(formatDay("2026-10-03", "short", "en-US")).toBe("Oct 3");
    expect(formatDay("2026-10-03", "long", "en-US")).toBe("Oct 3, 2026");
    expect(formatDay("2026-10-03", "weekday", "en-US")).toBe("Saturday, October 3");
    expect(weekdayShort("2026-10-03", "en-US")).toBe("Sat");
    expect(formatDay("2026-10-01", "monthYear", "en-US")).toBe("October 2026");
  });

  it("stepping day by day over the LA fall-back and the Auckland spring-forward never skips or repeats a date", () => {
    process.env.TZ = tz;
    expect(eachDay("2026-10-30", "2026-11-03")).toEqual([
      "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03",
    ]);
    expect(eachDay("2026-09-25", "2026-09-29")).toEqual([
      "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29",
    ]);
    expect(eachDay("2026-03-06", "2026-03-10")).toEqual([
      "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10",
    ]);
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-09-26", 2)).toBe("2026-09-28");
    expect(diffDays("2026-10-31", "2026-11-02")).toBe(2);
    expect(diffDays("2026-09-26", "2026-09-28")).toBe(2);
  });

  it("a year of days is 365 steps, DST or not", () => {
    process.env.TZ = tz;
    expect(diffDays("2026-01-01", "2027-01-01")).toBe(365);
    expect(eachDay("2026-01-01", "2026-12-31")).toHaveLength(365);
  });
});

describe("todayLocal is the viewer's wall-calendar day", () => {
  // 2026-10-03T06:30:00Z is Oct 2 23:30 in Los Angeles (UTC-7) and Oct 3 19:30 in Auckland (UTC+13).
  const instant = new Date("2026-10-03T06:30:00.000Z");

  it("west of UTC the day is still yesterday", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(todayLocal(instant)).toBe("2026-10-02");
  });

  it("east of UTC the day has already turned", () => {
    process.env.TZ = "Pacific/Auckland";
    expect(todayLocal(instant)).toBe("2026-10-03");
  });

  it("reproduces the defect the helper exists to avoid: a local-time read of a date-only value is a day early in LA", () => {
    process.env.TZ = "America/Los_Angeles";
    // If the runtime ignored the TZ switch this would not hold and the whole
    // matrix above would be vacuous — so assert the premise, not just the cure.
    expect(new Date("2026-10-03T00:00:00.000Z").getDate()).toBe(2);
    expect(parseDateOnly("2026-10-03T00:00:00.000Z")).toBe("2026-10-03");
  });
});

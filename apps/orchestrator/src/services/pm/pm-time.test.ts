/**
 * WARP-3526 (ADR-069 WS-10) — the pure half of time tracking: minute maths,
 * week and range windows in a named zone, day bucketing, and CSV cells.
 *
 * No database, no clock but the one each test passes in. The behaviour that
 * needs Postgres (one timer per person, the minutes CHECK, the cascades, report
 * totals equalling the sum of worklogs) is in __tests__/pm-time.pg.test.ts.
 *
 * Every zone case is chosen to fail if the implementation reads the PROCESS
 * zone (`getDay`, `new Date(y, m, d)`): the orchestrator container sets no TZ,
 * and a developer laptop does. The DST weeks are the other trap — a "week" is
 * 167 hours in March and 169 in November in New York, so any `+ 7 * 86_400_000`
 * shortcut lands an hour off and files late-Sunday entries on Monday.
 */
import { describe, it, expect } from "vitest";
import {
  FUTURE_START_SKEW_MS,
  MAX_REPORT_DAYS,
  MAX_TIME_YEAR,
  MIN_TIME_YEAR,
  WORKLOG_MAX_MINUTES,
  WORKLOG_MIN_MINUTES,
  dayIndex,
  groupKey,
  localDay,
  resolveRange,
  resolveWeek,
  resolveZone,
  timerMinutes,
} from "./pm-time.js";
import { csvCell, csvLine } from "./pm-time-csv.js";

const at = (iso: string): Date => new Date(iso);
const HOUR = 3_600_000;

describe("worklog bounds", () => {
  it("is one minute to one day", () => {
    expect(WORKLOG_MIN_MINUTES).toBe(1);
    expect(WORKLOG_MAX_MINUTES).toBe(24 * 60);
  });
});

describe("timerMinutes — what stopping a timer writes", () => {
  const start = at("2026-10-04T09:00:00.000Z");
  const after = (ms: number): Date => new Date(start.getTime() + ms);

  it("writes at least one minute, however short the run — a stopped timer always leaves an entry", () => {
    expect(timerMinutes(start, after(0))).toEqual({ minutes: 1, capped: false });
    expect(timerMinutes(start, after(20_000))).toEqual({ minutes: 1, capped: false });
  });

  it("rounds to the nearest minute, half up", () => {
    expect(timerMinutes(start, after(89_000)).minutes).toBe(1);
    expect(timerMinutes(start, after(90_000)).minutes).toBe(2);
    expect(timerMinutes(start, after(25 * 60_000 + 29_000)).minutes).toBe(25);
    expect(timerMinutes(start, after(25 * 60_000 + 30_000)).minutes).toBe(26);
  });

  it("keeps exactly a day as a day, and caps anything longer — and says it was capped", () => {
    expect(timerMinutes(start, after(24 * HOUR))).toEqual({ minutes: 1440, capped: false });
    expect(timerMinutes(start, after(24 * HOUR + 29_000))).toEqual({ minutes: 1440, capped: false });
    expect(timerMinutes(start, after(24 * HOUR + 31_000))).toEqual({ minutes: 1440, capped: true });
    expect(timerMinutes(start, after(72 * HOUR))).toEqual({ minutes: 1440, capped: true });
  });

  it("treats a start in the future (a clock that moved back) as the minimum, not a negative or zero entry", () => {
    expect(timerMinutes(start, after(-5 * 60_000))).toEqual({ minutes: 1, capped: false });
  });
});

describe("resolveZone", () => {
  it("defaults to UTC when no zone is given", () => {
    expect(resolveZone(undefined)).toBe("UTC");
  });

  it("accepts an IANA name and returns the runtime's canonical spelling", () => {
    expect(resolveZone("America/New_York")).toBe("America/New_York");
    expect(resolveZone("us/eastern")).toBe("America/New_York");
  });

  it("refuses a zone the runtime cannot resolve — never a quiet UTC", () => {
    expect(() => resolveZone("Mars/Olympus_Mons")).toThrow("invalid_timezone");
    expect(() => resolveZone("")).toThrow("invalid_timezone");
  });

  it("refuses a raw UTC offset: it has no DST rules, so a week in it would silently stop following summer time", () => {
    expect(() => resolveZone("+05:00")).toThrow("invalid_timezone");
    expect(() => resolveZone("-0800")).toThrow("invalid_timezone");
  });
});

describe("localDay", () => {
  it("is the calendar date on the wall clock in the zone, not in UTC", () => {
    const instant = at("2026-10-05T03:30:00.000Z");
    expect(localDay(instant, "UTC")).toBe("2026-10-05");
    expect(localDay(instant, "America/Los_Angeles")).toBe("2026-10-04");
    expect(localDay(instant, "Pacific/Kiritimati")).toBe("2026-10-05");
    expect(localDay(at("2026-10-05T11:00:00.000Z"), "Pacific/Kiritimati")).toBe("2026-10-06");
  });
});

describe("resolveWeek — weeks start on Monday in the zone", () => {
  it("snaps any date inside a week back to that week's Monday and lists seven days Monday to Sunday", () => {
    for (const day of ["2026-09-28", "2026-09-30", "2026-10-04"]) {
      const w = resolveWeek(day, "UTC", at("2026-10-04T12:00:00.000Z"));
      expect(w.weekStart).toBe("2026-09-28");
      expect(w.days).toEqual([
        "2026-09-28",
        "2026-09-29",
        "2026-09-30",
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
        "2026-10-04",
      ]);
      expect(w.from.toISOString()).toBe("2026-09-28T00:00:00.000Z");
      expect(w.to.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    }
  });

  it("starts the next week on the following Monday — Sunday night is still the old week", () => {
    expect(resolveWeek("2026-10-05", "UTC", at("2026-10-05T00:00:00.000Z")).weekStart).toBe("2026-10-05");
  });

  it("defaults to the week containing now, on the wall clock of the ZONE", () => {
    // 2026-10-04 23:30Z is still Sunday in UTC and already Monday 12:30 in
    // Auckland (NZDT, UTC+13) — a different week.
    const now = at("2026-10-04T23:30:00.000Z");
    expect(resolveWeek(undefined, "UTC", now).weekStart).toBe("2026-09-28");
    expect(resolveWeek(undefined, "Pacific/Auckland", now).weekStart).toBe("2026-10-05");
  });

  it("bounds the window at local midnight, so the week is 169 hours across the November fall-back", () => {
    const w = resolveWeek("2026-10-26", "America/New_York", at("2026-10-28T12:00:00.000Z"));
    expect(w.weekStart).toBe("2026-10-26");
    expect(w.from.toISOString()).toBe("2026-10-26T04:00:00.000Z"); // 00:00 EDT
    expect(w.to.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // 00:00 EST
    expect((w.to.getTime() - w.from.getTime()) / HOUR).toBe(169);
  });

  it("bounds the window at local midnight, so the week is 167 hours across the March spring-forward", () => {
    const w = resolveWeek("2026-03-02", "America/New_York", at("2026-03-04T12:00:00.000Z"));
    expect(w.from.toISOString()).toBe("2026-03-02T05:00:00.000Z"); // 00:00 EST
    expect(w.to.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // 00:00 EDT
    expect((w.to.getTime() - w.from.getTime()) / HOUR).toBe(167);
  });

  it("refuses a date that is not on the calendar", () => {
    expect(() => resolveWeek("2026-02-30", "UTC", new Date())).toThrow("invalid_week_start");
    expect(() => resolveWeek("next week", "UTC", new Date())).toThrow("invalid_week_start");
    expect(() => resolveWeek("2026-9-28", "UTC", new Date())).toThrow("invalid_week_start");
  });
});

describe("dayIndex — which column of the week an entry belongs in", () => {
  const w = resolveWeek("2026-10-26", "America/New_York", at("2026-10-28T12:00:00.000Z"));

  it("files an entry under the local day it STARTED on", () => {
    // 23:50 Sunday EST (the 25-hour day) is 04:50Z Monday — UTC says Monday,
    // the wall clock says Sunday.
    expect(dayIndex(w.days, at("2026-11-02T04:50:00.000Z"), "America/New_York")).toBe(6);
    expect(dayIndex(w.days, at("2026-10-26T04:00:00.000Z"), "America/New_York")).toBe(0);
  });

  it("is -1 for an instant outside the week", () => {
    expect(dayIndex(w.days, at("2026-11-02T05:00:00.000Z"), "America/New_York")).toBe(-1);
    expect(dayIndex(w.days, at("2026-10-26T03:59:00.000Z"), "America/New_York")).toBe(-1);
  });
});

describe("resolveRange — an inclusive calendar range in the zone", () => {
  it("is whole local days, from the first one's midnight up to the midnight after the last", () => {
    const r = resolveRange("2026-09-01", "2026-09-30", "UTC");
    expect(r.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(r.days).toBe(30);
  });

  it("is one day when the two dates are the same", () => {
    const r = resolveRange("2026-10-04", "2026-10-04", "America/Los_Angeles");
    expect(r.from.toISOString()).toBe("2026-10-04T07:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-05T07:00:00.000Z");
    expect(r.days).toBe(1);
  });

  it("refuses a range that runs backwards, is not a date, or is longer than a year and a day", () => {
    expect(() => resolveRange("2026-10-05", "2026-10-04", "UTC")).toThrow("invalid_range");
    expect(() => resolveRange("2026-13-01", "2026-13-02", "UTC")).toThrow("invalid_range");
    expect(MAX_REPORT_DAYS).toBe(366);
    expect(() => resolveRange("2025-01-01", "2026-01-02", "UTC")).toThrow("invalid_range"); // 367 days
    expect(resolveRange("2025-01-01", "2026-01-01", "UTC").days).toBe(366);
  });
});

describe("the years a week or a range may be asked about (WARP-3526 review S4)", () => {
  // `YYYY-MM-DD` with four digits is all the route's schema checks, so 9999-12-27
  // reached `zonedDateMinuteToUtc("10000-…")`, whose bare RangeError was a 500,
  // and 0001-01-01 was read as 1901 by `Date.UTC`'s two-digit-year rule — an
  // empty week instead of an error.
  it("is 2000 to 2100", () => {
    expect([MIN_TIME_YEAR, MAX_TIME_YEAR]).toEqual([2000, 2100]);
  });

  it.each(["9999-12-27", "9999-12-31", "0001-01-01", "0099-12-31", "1999-12-31", "2101-01-01"])(
    "refuses the week of %s as invalid_week_start — a 400, not a crash and not a quietly wrong week",
    (day) => {
      expect(() => resolveWeek(day, "UTC", new Date())).toThrow("invalid_week_start");
    },
  );

  it("accepts the first and last years, and snapping a first-year date back into the year before is fine", () => {
    expect(resolveWeek("2000-01-01", "UTC", new Date()).weekStart).toBe("1999-12-27");
    const last = resolveWeek("2100-12-31", "UTC", new Date());
    expect(last.weekStart).toBe("2100-12-27");
    expect(last.to.toISOString()).toBe("2101-01-03T00:00:00.000Z");
  });

  it("does not hold the box's own clock to it: a default week is whatever 'now' is", () => {
    // A box that has not yet synced its clock reports 1970; that is a clock
    // problem, not a bad request, and the caller sent no date to be refused.
    expect(resolveWeek(undefined, "UTC", new Date("1970-01-07T12:00:00.000Z")).weekStart).toBe("1970-01-05");
  });

  it.each([
    ["9999-12-30", "9999-12-31"],
    ["0001-01-01", "0001-01-02"],
    ["0099-06-01", "0099-06-02"],
    ["1999-12-31", "2000-01-02"],
    ["2100-12-31", "2101-01-01"],
    ["2026-01-01", "9999-12-31"],
  ])("refuses the range %s to %s as invalid_range", (from, to) => {
    expect(() => resolveRange(from, to, "UTC")).toThrow("invalid_range");
  });

  it("accepts a range inside the years", () => {
    expect(resolveRange("2000-01-01", "2000-01-02", "UTC").days).toBe(2);
    expect(resolveRange("2100-12-30", "2100-12-31", "UTC").days).toBe(2);
  });
});

describe("groupKey", () => {
  const row = {
    workItemId: "wi-1",
    userId: "u-1",
    startedAt: at("2026-10-05T03:30:00.000Z"),
    minutes: 30,
  };

  it("groups by person, by work item, or by local day", () => {
    expect(groupKey(row, "user", "UTC")).toBe("u-1");
    expect(groupKey(row, "item", "UTC")).toBe("wi-1");
    expect(groupKey(row, "day", "UTC")).toBe("2026-10-05");
    expect(groupKey(row, "day", "America/Los_Angeles")).toBe("2026-10-04");
  });
});

describe("future-start allowance", () => {
  it("is a few minutes — enough for clock skew, not enough to log tomorrow", () => {
    expect(FUTURE_START_SKEW_MS).toBe(5 * 60_000);
  });
});

describe("csvCell — RFC 4180 quoting and formula-injection neutralisation", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("Front desk")).toBe("Front desk");
    expect(csvCell("")).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes a value with a comma, a quote or a line break, doubling the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvCell("line one\rline two")).toBe('"line one\rline two"');
  });

  it("prefixes a single quote when a value would open as a formula in a spreadsheet", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
  });

  it("neutralises a formula behind leading whitespace — spreadsheets trim before deciding — and a leading tab or carriage return", () => {
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    expect(csvCell("\t5")).toBe("'\t5");
    expect(csvCell("\r5")).toBe('"\'\r5"');
  });

  it("does not touch a leader that is not at the start", () => {
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("Q3 - plan")).toBe("Q3 - plan");
    expect(csvCell("email@example.com")).toBe("email@example.com");
  });

  it("writes a number as a number: a negative one is data, not a formula", () => {
    expect(csvCell(90)).toBe("90");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(1.5)).toBe("1.5");
  });
});

describe("csvLine", () => {
  it("joins cells with commas and ends the record with CRLF", () => {
    expect(csvLine(["User", "Minutes"])).toBe("User,Minutes\r\n");
    expect(csvLine(["Sam, the owner", 90, "=2+2"])).toBe('"Sam, the owner",90,\'=2+2\r\n');
  });
});

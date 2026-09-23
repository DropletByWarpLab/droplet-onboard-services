/**
 * WARP-2977 P2b — lib/zoned-time.ts: the ONE RFC 5545 wall-clock converter
 * (moved verbatim from services/ics.ts, still pinned by
 * src/__tests__/ics.test.ts) and the helpers the opening hours add around it.
 *
 * Every case runs with the process TZ unset AND under Pacific/Kiritimati
 * (UTC+14) and Pacific/Pago_Pago (UTC−11): a helper that reads the PROCESS
 * zone (`getDay`, `getHours`, `new Date(y, m, d)`) gives a different answer
 * in at least one of them. The orchestrator container sets no TZ; a laptop
 * does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalZone,
  isCalendarYmd,
  isValidIanaZone,
  isoWeekdayOf,
  localPartsOf,
  timeZoneOffsetMs,
  ymdAddDays,
  zonedDateMinuteToUtc,
  zonedWallClockToUtc,
} from "./zoned-time.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** [label, TZ to set, getHours() of 2026-01-01T12:00Z under it]. */
const PROCESS_ZONES: Array<[string, string | undefined, number | undefined]> = [
  ["unset", undefined, undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati", 2],
  ["Pacific/Pago_Pago", "Pacific/Pago_Pago", 1],
];

describe.each(PROCESS_ZONES)("zoned-time — process TZ %s", (_label, zone, noonHours) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    // Node re-reads TZ on assignment only; deleting it does not reset the cache.
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  it("the process zone is really in force", () => {
    if (noonHours !== undefined) expect(new Date(Date.UTC(2026, 0, 1, 12)).getHours()).toBe(noonHours);
  });

  describe("zonedWallClockToUtc — RFC 5545 §3.3.5 exact instants", () => {
    it("a time in the spring-forward gap takes the pre-gap offset (NY 2026-03-08 02:30 → 07:30Z)", () => {
      expect(zonedWallClockToUtc(2026, 3, 8, 2, 30, 0, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    });

    it("a repeated time is its FIRST occurrence (NY 2026-11-01 01:30 → 05:30Z)", () => {
      expect(zonedWallClockToUtc(2026, 11, 1, 1, 30, 0, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    });

    it("first occurrence east of UTC too (Berlin 2026-10-25 02:30 → 00:30Z)", () => {
      expect(zonedWallClockToUtc(2026, 10, 25, 2, 30, 0, "Europe/Berlin").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    });

    it("a midnight gap stays on its own date (Santiago 2026-09-06 00:00 → 04:00Z)", () => {
      const at = zonedWallClockToUtc(2026, 9, 6, 0, 0, 0, "America/Santiago");
      expect(at.toISOString()).toBe("2026-09-06T04:00:00.000Z");
      expect(localPartsOf(at, "America/Santiago").ymd).toBe("2026-09-06");
    });

    it("a quarter-hour zone (Kathmandu +05:45)", () => {
      expect(zonedWallClockToUtc(2026, 6, 1, 9, 0, 0, "Asia/Kathmandu").toISOString()).toBe("2026-06-01T03:15:00.000Z");
      expect(timeZoneOffsetMs(Date.UTC(2026, 5, 1), "Asia/Kathmandu")).toBe((5 * 60 + 45) * 60_000);
    });

    it("an unknown zone is an Invalid Date, never a UTC guess", () => {
      expect(Number.isNaN(zonedWallClockToUtc(2026, 6, 1, 9, 0, 0, "Mars/Base").getTime())).toBe(true);
    });
  });

  describe("zonedDateMinuteToUtc", () => {
    it("resolves a date + minute through the same converter", () => {
      expect(zonedDateMinuteToUtc("2026-03-08", 150, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    });

    it("minute 1440 is midnight at the END of the date", () => {
      expect(zonedDateMinuteToUtc("2026-12-31", 1440, "Europe/London").toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("throws on an unknown zone or a minute out of range", () => {
      expect(() => zonedDateMinuteToUtc("2026-01-01", 0, "Mars/Base")).toThrow(RangeError);
      expect(() => zonedDateMinuteToUtc("2026-01-01", 1441, "UTC")).toThrow(RangeError);
      expect(() => zonedDateMinuteToUtc("2026-01-01", -1, "UTC")).toThrow(RangeError);
    });
  });

  describe("isValidIanaZone / canonicalZone", () => {
    it("accepts IANA names and refuses everything else", () => {
      expect(isValidIanaZone("Europe/London")).toBe(true);
      expect(isValidIanaZone("America/Argentina/Buenos_Aires")).toBe(true);
      expect(isValidIanaZone("UTC")).toBe(true);
      expect(isValidIanaZone("Mars/Base")).toBe(false);
      expect(isValidIanaZone("")).toBe(false);
      expect(isValidIanaZone("+05:00")).toBe(false);
      expect(isValidIanaZone("-0300")).toBe(false);
      expect(isValidIanaZone(`Europe/${"x".repeat(60)}`)).toBe(false);
      expect(isValidIanaZone(undefined)).toBe(false);
      expect(isValidIanaZone(42)).toBe(false);
    });

    it("canonicalises an alias and a case variant to one spelling", () => {
      expect(canonicalZone("US/Eastern")).toBe("America/New_York");
      expect(canonicalZone("europe/london")).toBe("Europe/London");
      expect(() => canonicalZone("Mars/Base")).toThrow(RangeError);
    });
  });

  describe("localPartsOf — the site's date, weekday and minute, never the process's", () => {
    // 2026-09-27T23:30Z is Monday 13:30 in Kiritimati and Sunday 16:30 in Los Angeles.
    const at = new Date("2026-09-27T23:30:00.000Z");

    it("east of UTC: the next calendar day", () => {
      expect(localPartsOf(at, "Pacific/Kiritimati")).toEqual({ ymd: "2026-09-28", isoWeekday: 1, minuteOfDay: 13 * 60 + 30 });
    });

    it("west of UTC: the same calendar day", () => {
      expect(localPartsOf(at, "America/Los_Angeles")).toEqual({ ymd: "2026-09-27", isoWeekday: 7, minuteOfDay: 16 * 60 + 30 });
    });

    it("midnight is minute 0, not 1440", () => {
      expect(localPartsOf(new Date("2026-01-01T00:00:00.000Z"), "UTC")).toEqual({ ymd: "2026-01-01", isoWeekday: 4, minuteOfDay: 0 });
    });

    it("throws on an unknown zone or an invalid instant", () => {
      expect(() => localPartsOf(at, "Mars/Base")).toThrow(RangeError);
      expect(() => localPartsOf(new Date(NaN), "UTC")).toThrow(RangeError);
    });
  });

  describe("calendar dates", () => {
    it("isoWeekdayOf: 1 = Monday … 7 = Sunday", () => {
      expect(isoWeekdayOf("2026-09-21")).toBe(1);
      expect(isoWeekdayOf("2026-09-26")).toBe(6);
      expect(isoWeekdayOf("2026-09-27")).toBe(7);
      expect(isoWeekdayOf("2028-02-29")).toBe(2);
    });

    it("ymdAddDays crosses months, years and leap days", () => {
      expect(ymdAddDays("2026-02-28", 1)).toBe("2026-03-01");
      expect(ymdAddDays("2028-02-28", 1)).toBe("2028-02-29");
      expect(ymdAddDays("2026-12-31", 1)).toBe("2027-01-01");
      expect(ymdAddDays("2026-01-01", -1)).toBe("2025-12-31");
      expect(ymdAddDays("2026-09-23", 370)).toBe("2027-09-28");
      expect(() => ymdAddDays("2026-01-01", 0.5)).toThrow(RangeError);
    });

    it("isCalendarYmd refuses shapes and dates that do not exist", () => {
      expect(isCalendarYmd("2026-09-23")).toBe(true);
      expect(isCalendarYmd("2028-02-29")).toBe(true);
      expect(isCalendarYmd("2026-02-29")).toBe(false);
      expect(isCalendarYmd("2026-13-01")).toBe(false);
      expect(isCalendarYmd("2026-04-31")).toBe(false);
      expect(isCalendarYmd("2026-9-23")).toBe(false);
      expect(isCalendarYmd("0000-01-01")).toBe(false);
    });
  });
});

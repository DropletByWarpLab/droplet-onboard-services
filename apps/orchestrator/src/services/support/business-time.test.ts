/**
 * WARP-3530 (ADR-069 §6) — business time: the one place in the SLA engine where
 * DST bugs live, so it is a pure library with its own exhaustive suite.
 *
 * Nothing here reads a clock: every function takes explicit instants, so every
 * case is deterministic by construction ("the injected clock" is the argument).
 * The whole example block runs with the process TZ unset AND under
 * Pacific/Kiritimati (UTC+14) and Pacific/Pago_Pago (UTC-11), because a helper
 * that reads the PROCESS zone (`getDay`, `getHours`, `new Date(y, m, d)`) gives
 * a different answer in at least one of them — the orchestrator container sets
 * no TZ, a laptop does (the same discipline as lib/zoned-time.test.ts).
 *
 * Expected instants are written out from the calendar, never read back from the
 * implementation. The randomised block at the end compares the library with a
 * brute-force oracle that decides "is this quarter-hour business time?" from
 * wall-clock parts alone — a second, independent formulation of the semantics.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localPartsOf, ymdAddDays } from "../../lib/zoned-time.js";
import {
  addBusinessMinutes,
  businessMinutesBetween,
  parseClock,
  validateCalendarForSave,
  type BusinessCalendar,
} from "./business-time.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROCESS_ZONES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
  ["Pacific/Pago_Pago", "Pacific/Pago_Pago"],
];

const d = (iso: string): Date => new Date(iso);
const iso = (x: Date): string => x.toISOString();

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Mon-Fri 09:00-17:00 local. */
const office = (timezone: string, over: Partial<BusinessCalendar> = {}): BusinessCalendar => ({
  timezone,
  windows: WEEKDAYS.map((day) => ({ day, start: "09:00", end: "17:00" })),
  holidays: [],
  ...over,
});

/** Mon-Fri overnight 22:00-06:00 local: a window belongs to the day it STARTS on. */
const nights = (timezone: string, over: Partial<BusinessCalendar> = {}): BusinessCalendar => ({
  timezone,
  windows: WEEKDAYS.map((day) => ({ day, start: "22:00", end: "06:00" })),
  holidays: [],
  ...over,
});

/** Open every day, all day, expressed as windows rather than as `null`. */
const round = (timezone: string): BusinessCalendar => ({
  timezone,
  windows: EVERY_DAY.map((day) => ({ day, start: "00:00", end: "24:00" })),
  holidays: [],
});

/** One overnight window, Saturday 22:00 -> Sunday 06:00: the shape that straddles
 *  every weekend DST transition. */
const saturdayNight = (timezone: string): BusinessCalendar => ({
  timezone,
  windows: [{ day: 6, start: "22:00", end: "06:00" }],
  holidays: [],
});

// 2026-10-04 is a Sunday: Mon 10-05 ... Fri 10-09, Sat 10-10, Sun 10-11, Mon 10-12.

describe.each(PROCESS_ZONES)("business time — process TZ %s", (_label, zone) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    // Node re-reads TZ on assignment only; deleting it does not reset the cache.
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  describe("addBusinessMinutes — a Mon-Fri 09:00-17:00 UTC office", () => {
    const cal = office("UTC");

    it("adds inside one window", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:00Z"), 60, cal))).toBe("2026-10-05T11:00:00.000Z");
    });

    it("zero minutes is the start itself, even outside business hours", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:00Z"), 0, cal))).toBe("2026-10-05T10:00:00.000Z");
      expect(iso(addBusinessMinutes(d("2026-10-10T03:00:00Z"), 0, cal))).toBe("2026-10-10T03:00:00.000Z");
    });

    it("a target that exactly fills the window is due at close, not at the next opening", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T09:00:00Z"), 480, cal))).toBe("2026-10-05T17:00:00.000Z");
      expect(iso(addBusinessMinutes(d("2026-10-05T15:00:00Z"), 120, cal))).toBe("2026-10-05T17:00:00.000Z");
    });

    it("one minute more rolls into the next business day", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T09:00:00Z"), 481, cal))).toBe("2026-10-06T09:01:00.000Z");
    });

    it("a start before opening begins counting at opening", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T07:00:00Z"), 60, cal))).toBe("2026-10-05T10:00:00.000Z");
    });

    it("a start after closing begins counting the next business morning", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T18:30:00Z"), 30, cal))).toBe("2026-10-06T09:30:00.000Z");
    });

    it("a start exactly at closing has no time left today", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T17:00:00Z"), 1, cal))).toBe("2026-10-06T09:01:00.000Z");
    });

    it("a start on a closed day waits for Monday", () => {
      expect(iso(addBusinessMinutes(d("2026-10-10T12:00:00Z"), 60, cal))).toBe("2026-10-12T10:00:00.000Z");
      expect(iso(addBusinessMinutes(d("2026-10-11T23:59:00Z"), 1, cal))).toBe("2026-10-12T09:01:00.000Z");
    });

    it("runs across a weekend", () => {
      expect(iso(addBusinessMinutes(d("2026-10-09T16:00:00Z"), 120, cal))).toBe("2026-10-12T10:00:00.000Z");
    });

    it("ten business days is the second Friday's close", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T09:00:00Z"), 480 * 10, cal))).toBe("2026-10-16T17:00:00.000Z");
    });

    it("keeps seconds and milliseconds, and accepts fractional minutes", () => {
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:30.250Z"), 1, cal))).toBe("2026-10-05T10:01:30.250Z");
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:00Z"), 1.5, cal))).toBe("2026-10-05T10:01:30.000Z");
    });

    it("refuses a negative, non-finite or NaN length and an invalid start", () => {
      for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => addBusinessMinutes(d("2026-10-05T10:00:00Z"), bad, cal)).toThrow(RangeError);
      }
      expect(() => addBusinessMinutes(new Date(Number.NaN), 5, cal)).toThrow(RangeError);
    });
  });

  describe("businessMinutesBetween — the same office", () => {
    const cal = office("UTC");
    const between = (a: string, b: string) => businessMinutesBetween(d(a), d(b), cal);

    it("counts only business time", () => {
      expect(between("2026-10-05T10:00:00Z", "2026-10-05T12:30:00Z")).toBe(150);
      expect(between("2026-10-05T07:00:00Z", "2026-10-05T10:00:00Z")).toBe(60);
      expect(between("2026-10-05T16:00:00Z", "2026-10-05T23:00:00Z")).toBe(60);
    });

    it("skips the weekend", () => {
      expect(between("2026-10-09T16:00:00Z", "2026-10-12T10:00:00Z")).toBe(120);
      expect(between("2026-10-10T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(0);
    });

    it("a full day is eight hours and a full week forty", () => {
      expect(between("2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z")).toBe(480);
      expect(between("2026-10-05T00:00:00Z", "2026-10-12T00:00:00Z")).toBe(2400);
    });

    it("is zero for an empty span and negative when reversed", () => {
      expect(between("2026-10-05T10:00:00Z", "2026-10-05T10:00:00Z")).toBe(0);
      expect(between("2026-10-05T12:30:00Z", "2026-10-05T10:00:00Z")).toBe(-150);
    });

    it("returns fractional minutes for a partial minute", () => {
      expect(between("2026-10-05T10:00:00Z", "2026-10-05T10:00:30Z")).toBe(0.5);
    });
  });

  describe("holidays", () => {
    it("a holiday contributes no time and the clock waits for the next open day", () => {
      const cal = office("UTC", { holidays: ["2026-10-06"] });
      expect(iso(addBusinessMinutes(d("2026-10-05T16:00:00Z"), 120, cal))).toBe("2026-10-07T10:00:00.000Z");
      expect(businessMinutesBetween(d("2026-10-05T09:00:00Z"), d("2026-10-07T09:00:00Z"), cal)).toBe(480);
    });

    it("a start inside a holiday begins counting after it", () => {
      const cal = office("UTC", { holidays: ["2026-10-06"] });
      expect(iso(addBusinessMinutes(d("2026-10-06T10:00:00Z"), 30, cal))).toBe("2026-10-07T09:30:00.000Z");
    });

    it("a long weekend: Friday and Monday closed", () => {
      const cal = office("UTC", { holidays: ["2026-10-12", "2026-10-09"] });
      expect(iso(addBusinessMinutes(d("2026-10-08T16:30:00Z"), 60, cal))).toBe("2026-10-13T09:30:00.000Z");
    });

    it("a holiday on a day that was closed anyway changes nothing, and a repeat is harmless", () => {
      const cal = office("UTC", { holidays: ["2026-10-10", "2026-10-10", "2026-10-11"] });
      expect(iso(addBusinessMinutes(d("2026-10-09T16:00:00Z"), 120, cal))).toBe("2026-10-12T10:00:00.000Z");
    });

    it("a holiday is a date in the CALENDAR's zone, not in UTC", () => {
      // 2026-10-06 in Sydney is closed; a UTC reading would also close the end of Oct 5 local.
      const cal = office("Australia/Sydney", { holidays: ["2026-10-06"] });
      // Mon 10-05 16:00 AEDT = 05:00Z; 60 minutes to close (17:00 AEDT = 06:00Z), then Tue is closed,
      // Wed 10-07 09:00 AEDT = Tue 22:00Z; +60 -> 10:00 AEDT = 23:00Z.
      expect(iso(addBusinessMinutes(d("2026-10-05T05:00:00Z"), 120, cal))).toBe("2026-10-06T23:00:00.000Z");
    });

    it("scans across a very long closure", () => {
      const holidays: string[] = [];
      for (let i = 0; i < 400; i += 1) holidays.push(ymdAddDays("2026-10-06", i));
      const cal = office("UTC", { holidays });
      // 2026-10-06 + 399 days = 2027-11-09 is the last holiday; the next business day is Wed 2027-11-10.
      expect(iso(addBusinessMinutes(d("2026-10-05T16:30:00Z"), 60, cal))).toBe("2027-11-10T09:30:00.000Z");
    });
  });

  describe("overnight windows", () => {
    const cal = nights("UTC");

    it("a window belongs to the day it starts on and runs into the next morning", () => {
      expect(iso(addBusinessMinutes(d("2026-10-09T23:00:00Z"), 120, cal))).toBe("2026-10-10T01:00:00.000Z");
    });

    it("the tail of Friday's window is the last business time of the week", () => {
      // Fri 23:00 -> Sat 06:00 is 420 min; 180 more start at Monday 22:00 (Saturday and Sunday open nothing).
      expect(iso(addBusinessMinutes(d("2026-10-09T23:00:00Z"), 600, cal))).toBe("2026-10-13T01:00:00.000Z");
    });

    it("counts the evening and the morning but not the day between", () => {
      expect(businessMinutesBetween(d("2026-10-09T22:00:00Z"), d("2026-10-10T06:00:00Z"), cal)).toBe(480);
      expect(businessMinutesBetween(d("2026-10-10T06:00:00Z"), d("2026-10-12T22:00:00Z"), cal)).toBe(0);
      expect(businessMinutesBetween(d("2026-10-12T00:00:00Z"), d("2026-10-13T00:00:00Z"), cal)).toBe(120);
      expect(businessMinutesBetween(d("2026-10-13T00:00:00Z"), d("2026-10-13T12:00:00Z"), cal)).toBe(360);
    });

    it("a holiday removes the windows that START on it, tail included", () => {
      const fridayOff = nights("UTC", { holidays: ["2026-10-09"] });
      expect(iso(addBusinessMinutes(d("2026-10-09T23:00:00Z"), 60, fridayOff))).toBe("2026-10-12T23:00:00.000Z");
    });

    it("a holiday on the morning after leaves the previous evening's window whole", () => {
      const saturdayOff = nights("UTC", { holidays: ["2026-10-10"] });
      expect(iso(addBusinessMinutes(d("2026-10-09T23:00:00Z"), 120, saturdayOff))).toBe("2026-10-10T01:00:00.000Z");
    });

    it("an overnight window that ends at 00:00 stops at midnight", () => {
      const lateEvening: BusinessCalendar = { timezone: "UTC", windows: [{ day: 1, start: "22:00", end: "00:00" }], holidays: [] };
      expect(iso(addBusinessMinutes(d("2026-10-05T22:30:00Z"), 120, lateEvening))).toBe("2026-10-12T22:30:00.000Z");
    });
  });

  describe("windows are normalised", () => {
    it("overlapping, adjacent and duplicate windows never count twice", () => {
      const overlapping: BusinessCalendar = {
        timezone: "UTC",
        windows: [
          { day: 1, start: "09:00", end: "12:00" },
          { day: 1, start: "11:00", end: "14:00" },
          { day: 1, start: "09:00", end: "12:00" },
          { day: 1, start: "14:00", end: "17:00" },
        ],
        holidays: [],
      };
      expect(businessMinutesBetween(d("2026-10-05T00:00:00Z"), d("2026-10-06T00:00:00Z"), overlapping)).toBe(480);
      expect(iso(addBusinessMinutes(d("2026-10-05T09:00:00Z"), 480, overlapping))).toBe("2026-10-05T17:00:00.000Z");
    });

    it("a lunch break is a gap", () => {
      const lunch: BusinessCalendar = {
        timezone: "UTC",
        windows: [
          { day: 1, start: "13:00", end: "17:00" },
          { day: 1, start: "09:00", end: "12:00" },
        ],
        holidays: [],
      };
      expect(iso(addBusinessMinutes(d("2026-10-05T11:00:00Z"), 120, lunch))).toBe("2026-10-05T14:00:00.000Z");
      expect(businessMinutesBetween(d("2026-10-05T09:00:00Z"), d("2026-10-05T17:00:00Z"), lunch)).toBe(420);
    });

    it("an overnight window overlapping the next day's own window is one stretch", () => {
      const cal: BusinessCalendar = {
        timezone: "UTC",
        windows: [
          { day: 1, start: "22:00", end: "08:00" },
          { day: 2, start: "06:00", end: "12:00" },
        ],
        holidays: [],
      };
      // Mon 22:00 -> Tue 12:00 is one stretch of 14 hours, nothing counted twice.
      expect(businessMinutesBetween(d("2026-10-05T22:00:00Z"), d("2026-10-06T12:00:00Z"), cal)).toBe(14 * 60);
    });
  });

  describe("zero-length days and empty calendars", () => {
    it("a day with no window is skipped", () => {
      const noWednesday = office("UTC");
      noWednesday.windows = noWednesday.windows.filter((w) => w.day !== 3);
      expect(iso(addBusinessMinutes(d("2026-10-06T16:30:00Z"), 60, noWednesday))).toBe("2026-10-08T09:30:00.000Z");
    });

    it("a window whose start equals its end is no time at all, not a day-long window", () => {
      const cal: BusinessCalendar = {
        timezone: "UTC",
        windows: [
          { day: 1, start: "09:00", end: "09:00" },
          { day: 2, start: "09:00", end: "17:00" },
        ],
        holidays: [],
      };
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:00Z"), 60, cal))).toBe("2026-10-06T10:00:00.000Z");
      expect(businessMinutesBetween(d("2026-10-05T00:00:00Z"), d("2026-10-06T00:00:00Z"), cal)).toBe(0);
    });

    it("a calendar with no business time measures zero and refuses to schedule anything", () => {
      const closed: BusinessCalendar = { timezone: "UTC", windows: [], holidays: [] };
      expect(businessMinutesBetween(d("2026-10-05T00:00:00Z"), d("2026-10-30T00:00:00Z"), closed)).toBe(0);
      expect(iso(addBusinessMinutes(d("2026-10-05T10:00:00Z"), 0, closed))).toBe("2026-10-05T10:00:00.000Z");
      expect(() => addBusinessMinutes(d("2026-10-05T10:00:00Z"), 1, closed)).toThrow(RangeError);
    });
  });

  describe("24/7", () => {
    it("a null calendar is plain elapsed time", () => {
      expect(iso(addBusinessMinutes(d("2026-10-10T03:17:00Z"), 90, null))).toBe("2026-10-10T04:47:00.000Z");
      expect(businessMinutesBetween(d("2026-10-10T03:17:00Z"), d("2026-10-12T03:17:00Z"), null)).toBe(2880);
      expect(businessMinutesBetween(d("2026-10-12T03:17:00Z"), d("2026-10-10T03:17:00Z"), null)).toBe(-2880);
    });

    it("seven all-day windows are the same as null, in any zone, through any DST change", () => {
      for (const tz of ["UTC", "America/New_York", "Europe/Berlin", "Australia/Sydney", "America/Santiago"]) {
        const cal = round(tz);
        for (const [from, to] of [
          ["2026-03-07T12:00:00Z", "2026-03-12T12:00:00Z"],
          ["2026-10-30T12:00:00Z", "2026-11-04T12:00:00Z"],
          ["2026-03-28T12:00:00Z", "2026-03-31T12:00:00Z"],
          ["2026-10-02T12:00:00Z", "2026-10-06T12:00:00Z"],
          ["2026-09-04T12:00:00Z", "2026-09-08T12:00:00Z"],
          ["2026-04-03T12:00:00Z", "2026-04-07T12:00:00Z"],
        ] as const) {
          const elapsed = (d(to).getTime() - d(from).getTime()) / 60000;
          expect(businessMinutesBetween(d(from), d(to), cal), `${tz} ${from}`).toBe(elapsed);
          expect(iso(addBusinessMinutes(d(from), elapsed, cal)), `${tz} ${from}`).toBe(iso(d(to)));
        }
      }
    });

    it("a day lasts 23 hours when the clocks go forward and 25 when they go back", () => {
      const ny = round("America/New_York");
      // Sun 2026-03-08 00:00 EST (05:00Z) -> Mon 03-09 00:00 EDT (04:00Z)
      expect(businessMinutesBetween(d("2026-03-08T05:00:00Z"), d("2026-03-09T04:00:00Z"), ny)).toBe(23 * 60);
      // Sun 2026-11-01 00:00 EDT (04:00Z) -> Mon 11-02 00:00 EST (05:00Z)
      expect(businessMinutesBetween(d("2026-11-01T04:00:00Z"), d("2026-11-02T05:00:00Z"), ny)).toBe(25 * 60);
    });
  });

  describe("DST — a Mon-Fri 09:00-17:00 local office keeps its LOCAL hours", () => {
    it("US spring forward: Friday close is 22:00Z, Monday open is 13:00Z", () => {
      const ny = office("America/New_York");
      // Fri 2026-03-06 16:30 EST (21:30Z) + 60 -> 30 left today, 30 on Monday from 09:00 EDT (13:00Z).
      expect(iso(addBusinessMinutes(d("2026-03-06T21:30:00Z"), 60, ny))).toBe("2026-03-09T13:30:00.000Z");
      expect(businessMinutesBetween(d("2026-03-06T21:30:00Z"), d("2026-03-09T13:30:00Z"), ny)).toBe(60);
    });

    it("US fall back: Friday close is 21:00Z, Monday open is 14:00Z", () => {
      const ny = office("America/New_York");
      // Fri 2026-10-30 16:30 EDT (20:30Z) + 60 -> Mon 2026-11-02 09:30 EST (14:30Z).
      expect(iso(addBusinessMinutes(d("2026-10-30T20:30:00Z"), 60, ny))).toBe("2026-11-02T14:30:00.000Z");
      expect(businessMinutesBetween(d("2026-10-30T20:30:00Z"), d("2026-11-02T14:30:00Z"), ny)).toBe(60);
    });

    it("EU spring forward and fall back", () => {
      const berlin = office("Europe/Berlin");
      // Fri 2026-03-27 16:30 CET (15:30Z) + 60 -> Mon 03-30 09:30 CEST (07:30Z).
      expect(iso(addBusinessMinutes(d("2026-03-27T15:30:00Z"), 60, berlin))).toBe("2026-03-30T07:30:00.000Z");
      // Fri 2026-10-23 16:30 CEST (14:30Z) + 60 -> Mon 10-26 09:30 CET (08:30Z).
      expect(iso(addBusinessMinutes(d("2026-10-23T14:30:00Z"), 60, berlin))).toBe("2026-10-26T08:30:00.000Z");
    });

    it("southern hemisphere: Sydney, Auckland and Santiago go the other way round", () => {
      // Sydney DST starts Sun 2026-10-04: Fri 10-02 16:30 AEST (06:30Z) + 60 -> Mon 10-05 09:30 AEDT (Oct 4 22:30Z).
      expect(iso(addBusinessMinutes(d("2026-10-02T06:30:00Z"), 60, office("Australia/Sydney")))).toBe("2026-10-04T22:30:00.000Z");
      // Sydney DST ends Sun 2026-04-05: Fri 04-03 16:30 AEDT (05:30Z) + 60 -> Mon 04-06 09:30 AEST (Apr 5 23:30Z).
      expect(iso(addBusinessMinutes(d("2026-04-03T05:30:00Z"), 60, office("Australia/Sydney")))).toBe("2026-04-05T23:30:00.000Z");
      // Auckland DST starts Sun 2026-09-27: Fri 09-25 16:30 NZST (04:30Z) + 60 -> Mon 09-28 09:30 NZDT (Sep 27 20:30Z).
      expect(iso(addBusinessMinutes(d("2026-09-25T04:30:00Z"), 60, office("Pacific/Auckland")))).toBe("2026-09-27T20:30:00.000Z");
      // Santiago DST starts Sun 2026-09-06 (midnight): Fri 09-04 16:30 -04 (20:30Z) + 60 -> Mon 09-07 09:30 -03 (12:30Z).
      expect(iso(addBusinessMinutes(d("2026-09-04T20:30:00Z"), 60, office("America/Santiago")))).toBe("2026-09-07T12:30:00.000Z");
    });

    it("half-hour and 45-minute offsets (India, Nepal, Lord Howe)", () => {
      // Kolkata is +05:30: Mon 2026-10-05 09:00 IST = 03:30Z.
      expect(iso(addBusinessMinutes(d("2026-10-05T03:30:00Z"), 60, office("Asia/Kolkata")))).toBe("2026-10-05T04:30:00.000Z");
      // Kathmandu is +05:45: Mon 09:00 = 03:15Z.
      expect(iso(addBusinessMinutes(d("2026-10-05T03:15:00Z"), 480, office("Asia/Kathmandu")))).toBe("2026-10-05T11:15:00.000Z");
      // Lord Howe: +10:30 standard, +11:00 summer. Fri 2026-10-02 16:30 LHST (06:00Z) + 60 -> Mon 10-05 09:30 LHDT (Oct 4 22:30Z).
      expect(iso(addBusinessMinutes(d("2026-10-02T06:00:00Z"), 60, office("Australia/Lord_Howe")))).toBe("2026-10-04T22:30:00.000Z");
    });
  });

  describe("DST — an overnight window is as long as the night really is", () => {
    // Saturday 22:00 -> Sunday 06:00 local, over each weekend's transition.
    const cases: Array<[string, string, string, string, number]> = [
      // [zone, window start, window end, label, real minutes]
      ["America/New_York", "2026-03-08T03:00:00Z", "2026-03-08T10:00:00Z", "US spring forward", 420],
      ["America/New_York", "2026-11-01T02:00:00Z", "2026-11-01T11:00:00Z", "US fall back", 540],
      ["Europe/Berlin", "2026-03-28T21:00:00Z", "2026-03-29T04:00:00Z", "EU spring forward", 420],
      ["Europe/Berlin", "2026-10-24T20:00:00Z", "2026-10-25T05:00:00Z", "EU fall back", 540],
      ["Australia/Sydney", "2026-10-03T12:00:00Z", "2026-10-03T19:00:00Z", "Sydney spring forward", 420],
      ["Australia/Sydney", "2026-04-04T11:00:00Z", "2026-04-04T20:00:00Z", "Sydney fall back", 540],
      ["Pacific/Auckland", "2026-09-26T10:00:00Z", "2026-09-26T17:00:00Z", "Auckland spring forward", 420],
      ["Pacific/Auckland", "2026-04-04T09:00:00Z", "2026-04-04T18:00:00Z", "Auckland fall back", 540],
      ["America/Santiago", "2026-09-06T02:00:00Z", "2026-09-06T09:00:00Z", "Santiago spring forward (midnight)", 420],
      ["America/Santiago", "2026-04-05T01:00:00Z", "2026-04-05T10:00:00Z", "Santiago fall back (midnight)", 540],
      ["Australia/Lord_Howe", "2026-10-03T11:30:00Z", "2026-10-03T19:00:00Z", "Lord Howe spring forward (30 minutes)", 450],
      ["Australia/Lord_Howe", "2026-04-04T11:00:00Z", "2026-04-04T19:30:00Z", "Lord Howe fall back (30 minutes)", 510],
    ];

    it.each(cases)("%s: %s -> %s (%s) is %d real minutes", (tz, from, to, _label, minutes) => {
      const cal = saturdayNight(tz);
      expect(businessMinutesBetween(d(from), d(to), cal)).toBe(minutes);
      // The window ends exactly where the night ends...
      expect(iso(addBusinessMinutes(d(from), minutes, cal))).toBe(iso(d(to)));
      // ...and one more minute waits for the next Saturday night, which is a week later
      // at the same LOCAL time (22:00 local, so the UTC hour may differ by the DST shift).
      const next = addBusinessMinutes(d(from), minutes + 1, cal);
      expect(next.getTime()).toBeGreaterThan(d(to).getTime() + 6 * 86_400_000);
      const local = localPartsOf(new Date(next.getTime() - 60_000), tz);
      expect(local.minuteOfDay).toBe(22 * 60);
      expect(local.isoWeekday).toBe(6);
    });
  });

  describe("DST — the awkward wall clocks resolve the way RFC 5545 says", () => {
    it("a window ending inside the repeated hour ends at its FIRST occurrence", () => {
      // NY Sunday 2026-11-01: 01:30 happens twice. Sunday 00:00-01:30 = 00:00 EDT (04:00Z) to the first 01:30 (05:30Z).
      const cal: BusinessCalendar = { timezone: "America/New_York", windows: [{ day: 0, start: "00:00", end: "01:30" }], holidays: [] };
      expect(businessMinutesBetween(d("2026-11-01T04:00:00Z"), d("2026-11-01T08:00:00Z"), cal)).toBe(90);
    });

    it("a window starting in the spring-forward gap starts at the pre-gap offset", () => {
      // NY Sunday 2026-03-08: 02:30 does not exist; it is read at the pre-gap offset (EST) = 07:30Z = 03:30 EDT.
      const cal: BusinessCalendar = { timezone: "America/New_York", windows: [{ day: 0, start: "02:30", end: "04:00" }], holidays: [] };
      expect(businessMinutesBetween(d("2026-03-08T05:00:00Z"), d("2026-03-08T12:00:00Z"), cal)).toBe(30);
      expect(iso(addBusinessMinutes(d("2026-03-08T05:00:00Z"), 1, cal))).toBe("2026-03-08T07:31:00.000Z");
    });

    it("a window that lies wholly inside the gap is read at the pre-gap offset and keeps its length", () => {
      const cal: BusinessCalendar = { timezone: "America/New_York", windows: [{ day: 0, start: "02:30", end: "02:45" }], holidays: [] };
      // 02:30-02:45 EST is 07:30Z-07:45Z (which the clocks then call 03:30-03:45 EDT): a real quarter hour.
      expect(businessMinutesBetween(d("2026-03-08T05:00:00Z"), d("2026-03-08T12:00:00Z"), cal)).toBe(15);
      // The same wall-clock window a week later, with no transition, is the same quarter hour.
      expect(businessMinutesBetween(d("2026-03-15T05:00:00Z"), d("2026-03-15T12:00:00Z"), cal)).toBe(15);
    });

    it("a window that ends before it starts once the gap is applied is dropped, never run backwards", () => {
      // 02:50 is read at the pre-gap offset (07:50Z) but 03:10 exists as EDT (07:10Z): the end precedes the start.
      const backwards: BusinessCalendar = { timezone: "America/New_York", windows: [{ day: 0, start: "02:50", end: "03:10" }], holidays: [] };
      expect(businessMinutesBetween(d("2026-03-08T05:00:00Z"), d("2026-03-08T12:00:00Z"), backwards)).toBe(0);
      // 02:30-03:30 collapses to a point (07:30Z-07:30Z).
      const point: BusinessCalendar = { timezone: "America/New_York", windows: [{ day: 0, start: "02:30", end: "03:30" }], holidays: [] };
      expect(businessMinutesBetween(d("2026-03-08T05:00:00Z"), d("2026-03-08T12:00:00Z"), point)).toBe(0);
      expect(businessMinutesBetween(d("2026-03-15T05:00:00Z"), d("2026-03-15T12:00:00Z"), point)).toBe(60);
    });
  });

  describe("composition", () => {
    const zones = ["UTC", "America/New_York", "Europe/Berlin", "Australia/Sydney", "Pacific/Auckland", "Asia/Kathmandu", "Australia/Lord_Howe"];

    it("adding in two steps is adding the sum, and the count of what was added is what was asked for", () => {
      for (const tz of zones) {
        for (const cal of [office(tz), nights(tz), round(tz), office(tz, { holidays: ["2026-03-10", "2026-10-27"] })]) {
          for (const from of ["2026-03-06T17:45:00Z", "2026-10-30T19:10:00Z", "2026-10-02T05:20:00Z", "2026-04-03T04:05:00Z"]) {
            for (const [m1, m2] of [
              [0, 90],
              [45, 400],
              [480, 480],
              [1000, 1],
            ]) {
              const start = d(from);
              const once = addBusinessMinutes(start, m1 + m2, cal);
              const twice = addBusinessMinutes(addBusinessMinutes(start, m1, cal), m2, cal);
              expect(iso(twice), `${tz} ${from} ${m1}+${m2}`).toBe(iso(once));
              expect(businessMinutesBetween(start, once, cal), `${tz} ${from} ${m1}+${m2}`).toBe(m1 + m2);
              if (m1 + m2 > 0) {
                // minimal: one millisecond earlier it has not yet been reached
                expect(businessMinutesBetween(start, new Date(once.getTime() - 1), cal)).toBeLessThan(m1 + m2);
              }
            }
          }
        }
      }
    });
  });
});

// ── calendar validation ──────────────────────────────────────────────────────

describe("parseClock", () => {
  it("reads HH:MM, and 24:00 only where it is allowed", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("24:00", true)).toBe(1440);
    expect(() => parseClock("24:00")).toThrow(RangeError);
  });

  it.each(["9:00", "09:0", "0900", "24:01", "25:00", "12:60", "-1:00", "ab:cd", "", " 09:00"])("refuses %j", (bad) => {
    expect(() => parseClock(bad, true)).toThrow(RangeError);
  });
});

describe("validateCalendarForSave", () => {
  const good = (): Record<string, unknown> => ({
    timezone: "America/New_York",
    windows: [{ day: 1, start: "09:00", end: "17:00" }],
    holidays: ["2026-12-25"],
  });

  it("accepts a calendar and returns it normalised (canonical zone, sorted unique holidays)", () => {
    const cal = validateCalendarForSave({
      timezone: "us/eastern",
      windows: [{ day: 1, start: "09:00", end: "17:00" }],
      holidays: ["2026-12-26", "2026-12-25", "2026-12-26"],
    });
    expect(cal.timezone).toBe("America/New_York");
    expect(cal.holidays).toEqual(["2026-12-25", "2026-12-26"]);
  });

  it("accepts an overnight window and a 24:00 end", () => {
    expect(() =>
      validateCalendarForSave({ ...good(), windows: [{ day: 5, start: "22:00", end: "06:00" }, { day: 6, start: "00:00", end: "24:00" }] }),
    ).not.toThrow();
  });

  it.each([
    ["an unknown zone", { timezone: "Mars/Olympus" }],
    ["a UTC offset instead of a zone", { timezone: "+05:00" }],
    ["a day out of range", { windows: [{ day: 7, start: "09:00", end: "17:00" }] }],
    ["a fractional day", { windows: [{ day: 1.5, start: "09:00", end: "17:00" }] }],
    ["a bad clock", { windows: [{ day: 1, start: "9am", end: "17:00" }] }],
    ["a start equal to the end", { windows: [{ day: 1, start: "09:00", end: "09:00" }] }],
    ["no windows at all", { windows: [] }],
    ["windows that are all zero length", { windows: [{ day: 1, start: "08:00", end: "08:00" }] }],
    ["a holiday that is not a date", { holidays: ["2026-02-30"] }],
    ["a holiday in the wrong format", { holidays: ["12/25/2026"] }],
    ["windows that are not an array", { windows: "9-5" }],
    ["too many windows", { windows: Array.from({ length: 101 }, () => ({ day: 1, start: "09:00", end: "10:00" })) }],
  ])("refuses %s", (_label, over) => {
    expect(() => validateCalendarForSave({ ...good(), ...over })).toThrow(RangeError);
  });

  it("refuses something that is not an object", () => {
    expect(() => validateCalendarForSave(null)).toThrow(RangeError);
    expect(() => validateCalendarForSave("calendar")).toThrow(RangeError);
  });
});

// ── a brute-force oracle ─────────────────────────────────────────────────────

/** A small seeded generator (mulberry32) so a failure names a reproducible case. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const QUARTER = 15 * 60_000;

/** Is the quarter-hour STARTING at `ms` business time? Decided from wall-clock
 *  parts alone, by the rule "a window belongs to the date it starts on, an
 *  overnight window runs into the next morning, a holiday removes the windows
 *  that start on it" — never from instants, so it shares nothing with the
 *  interval arithmetic it checks. */
function oracleIsBusiness(ms: number, cal: BusinessCalendar): boolean {
  const here = localPartsOf(new Date(ms), cal.timezone);
  const yesterday = ymdAddDays(here.ymd, -1);
  const weekdayOf = (ymd: string) => {
    const p = localPartsOf(new Date(`${ymd}T12:00:00Z`), "UTC");
    return p.isoWeekday % 7;
  };
  const minutes = (clock: string): number => {
    const [h, m] = clock.split(":").map(Number);
    return h! * 60 + m!;
  };
  const startsToday = cal.windows.filter((w) => w.day === weekdayOf(here.ymd) && !cal.holidays.includes(here.ymd));
  for (const w of startsToday) {
    const s = minutes(w.start);
    const e = minutes(w.end);
    if (s === e) continue;
    if (s < e ? here.minuteOfDay >= s && here.minuteOfDay < e : here.minuteOfDay >= s) return true;
  }
  const startedYesterday = cal.windows.filter((w) => w.day === weekdayOf(yesterday) && !cal.holidays.includes(yesterday));
  for (const w of startedYesterday) {
    const s = minutes(w.start);
    const e = minutes(w.end);
    if (e < s && here.minuteOfDay < e) return true;
  }
  return false;
}

function oracleBetween(a: number, b: number, cal: BusinessCalendar): number {
  let slices = 0;
  for (let t = a; t < b; t += QUARTER) if (oracleIsBusiness(t, cal)) slices += 1;
  return slices * 15;
}

function oracleAdd(a: number, minutes: number, cal: BusinessCalendar): number {
  if (minutes === 0) return a;
  let remaining = minutes / 15;
  for (let t = a; ; t += QUARTER) {
    if (oracleIsBusiness(t, cal)) {
      remaining -= 1;
      if (remaining === 0) return t + QUARTER;
    }
    if (t - a > 120 * 86_400_000) throw new Error("oracle ran away");
  }
}

describe("against a brute-force oracle (quarter-hour resolution, seeded)", () => {
  // Zone, and the weeks around its own DST transitions.
  const ZONES: Array<[string, string[]]> = [
    ["UTC", ["2026-10-05T00:00:00Z"]],
    ["America/New_York", ["2026-03-04T00:00:00Z", "2026-10-28T00:00:00Z"]],
    ["Europe/Berlin", ["2026-03-25T00:00:00Z", "2026-10-21T00:00:00Z"]],
    ["Australia/Sydney", ["2026-09-30T00:00:00Z", "2026-04-01T00:00:00Z"]],
    ["Pacific/Auckland", ["2026-09-23T00:00:00Z", "2026-04-01T00:00:00Z"]],
    ["Australia/Lord_Howe", ["2026-09-30T00:00:00Z", "2026-04-01T00:00:00Z"]],
    ["Asia/Kathmandu", ["2026-10-05T00:00:00Z"]],
    ["Asia/Kolkata", ["2026-10-05T00:00:00Z"]],
  ];

  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

  function randomCalendar(r: () => number, timezone: string, around: string): BusinessCalendar {
    const windows: BusinessCalendar["windows"][number][] = [];
    for (const day of EVERY_DAY) {
      if (r() < 0.35) continue; // closed
      // A day window that starts and ends well away from the 01:00-04:00 transition hours.
      const s = 6 * 60 + 15 * Math.floor(r() * 24); // 06:00-11:45
      const e = 13 * 60 + 15 * Math.floor(r() * 36); // 13:00-21:45
      windows.push({ day, start: hhmm(s), end: hhmm(e) });
      if (r() < 0.3) {
        // a night shift that starts at 22:00/22:30/23:00 and ends at 05:00-06:30
        windows.push({ day, start: pick(r, ["22:00", "22:30", "23:00"]), end: pick(r, ["05:00", "05:30", "06:30"]) });
      }
    }
    if (windows.length === 0) windows.push({ day: 1, start: "09:00", end: "17:00" });
    const holidays: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      if (r() < 0.6) holidays.push(ymdAddDays(around.slice(0, 10), Math.floor(r() * 14)));
    }
    return { timezone, windows, holidays };
  }

  it("agrees on add and between for random calendars across each zone's transitions", () => {
    const r = rng(3530);
    let cases = 0;
    for (const [tz, anchors] of ZONES) {
      for (const anchor of anchors) {
        for (let k = 0; k < 3; k += 1) {
          const cal = randomCalendar(r, tz, anchor);
          for (let j = 0; j < 4; j += 1) {
            const start = d(anchor).getTime() + QUARTER * Math.floor(r() * 4 * 24 * 12); // within 12 days
            const minutes = 15 * Math.floor(r() * 120); // up to 30 hours of business time
            const label = `${tz} seed-case ${cases} ${JSON.stringify(cal)} start=${new Date(start).toISOString()} +${minutes}`;
            const got = addBusinessMinutes(new Date(start), minutes, cal).getTime();
            expect(got, label).toBe(oracleAdd(start, minutes, cal));
            const end = start + QUARTER * Math.floor(r() * 4 * 24 * 6);
            expect(businessMinutesBetween(new Date(start), new Date(end), cal), label).toBe(oracleBetween(start, end, cal));
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(100);
  }, 60_000);
});

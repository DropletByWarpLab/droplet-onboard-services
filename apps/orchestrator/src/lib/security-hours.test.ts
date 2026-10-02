/**
 * WARP-2977 P2b — lib/security-hours.ts, the opening-hours evaluator.
 *
 * Instants are written as SITE wall clocks through the one converter
 * (`wall`), and every case runs with the process TZ unset and under two
 * far-off zones, so nothing here can pass by reading the process clock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HOURS_HORIZON_DAYS,
  changeAfter,
  hhmmToMinutes,
  lastChangeAtOrBefore,
  minutesToHhmm,
  openWindowsBetween,
  openingAfter,
  scheduledModeAt,
  siteClock,
  siteClockCopy,
  siteDayClockCopy,
  validateDay,
  validateWeek,
  weekFrom,
  type DayHours,
  type SiteHours,
} from "./security-hours.js";
import { ymdAddDays, zonedWallClockToUtc, type IsoWeekday } from "./zoned-time.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROCESS_ZONES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
  ["Pacific/Pago_Pago", "Pacific/Pago_Pago"],
];

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";

const closed: DayHours = { kind: "closed" };
const allDay: DayHours = { kind: "open_all_day" };
function hours(opens: string, closes: string): DayHours {
  return { kind: "hours", opensMin: hhmmToMinutes(opens)!, closesMin: hhmmToMinutes(closes)! };
}

/** A set week in `tz`; unlisted weekdays are closed. */
function site(
  tz: string,
  days: Partial<Record<IsoWeekday, DayHours>>,
  exceptions: Record<string, DayHours> = {},
): SiteHours {
  const week = weekFrom(
    ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...(days[weekday] ?? closed) })),
  );
  return { state: "set", timezone: tz, week, exceptions: new Map(Object.entries(exceptions)) };
}

/** The instant of a site wall clock, 'YYYY-MM-DD', 'HH:MM[:SS]'. */
function wall(ymd: string, time: string, tz: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi, s = 0] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, h!, mi!, s, tz);
}

const WEEKDAYS_9_5 = site(LONDON, { 1: hours("09:00", "17:00"), 2: hours("09:00", "17:00"), 3: hours("09:00", "17:00"), 4: hours("09:00", "17:00"), 5: hours("09:00", "17:00") });

// 2026-09-21 is a Monday; 2026-09-25 a Friday.
describe.each(PROCESS_ZONES)("security-hours — process TZ %s", (_label, zone) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  describe("scheduledModeAt", () => {
    it("a plain 09–17 day is half-open: 16:59:59 open, 17:00:00 closed, 09:00:00 open", () => {
      expect(scheduledModeAt(WEEKDAYS_9_5, wall("2026-09-23", "16:59:59", LONDON))).toBe("open");
      expect(scheduledModeAt(WEEKDAYS_9_5, wall("2026-09-23", "17:00:00", LONDON))).toBe("closed");
      expect(scheduledModeAt(WEEKDAYS_9_5, wall("2026-09-23", "09:00:00", LONDON))).toBe("open");
      expect(scheduledModeAt(WEEKDAYS_9_5, wall("2026-09-23", "08:59:59", LONDON))).toBe("closed");
      expect(scheduledModeAt(WEEKDAYS_9_5, wall("2026-09-26", "12:00", LONDON))).toBe("closed");
    });

    it("Fri 18:00–02:00: Sat 01:00 is open through Friday's tail, Sat 02:00 is closed", () => {
      const h = site(LONDON, { 5: hours("18:00", "02:00") });
      expect(scheduledModeAt(h, wall("2026-09-25", "17:59", LONDON))).toBe("closed");
      expect(scheduledModeAt(h, wall("2026-09-25", "18:00", LONDON))).toBe("open");
      expect(scheduledModeAt(h, wall("2026-09-26", "01:00", LONDON))).toBe("open");
      expect(scheduledModeAt(h, wall("2026-09-26", "02:00", LONDON))).toBe("closed");
    });

    it("a Saturday exception does NOT cut Friday's tail; a Friday exception removes Friday AND its tail", () => {
      const week = { 5: hours("18:00", "02:00"), 6: hours("10:00", "16:00") } as const;
      const satOff = site(LONDON, week, { "2026-09-26": closed });
      expect(scheduledModeAt(satOff, wall("2026-09-26", "01:00", LONDON))).toBe("open");
      expect(scheduledModeAt(satOff, wall("2026-09-26", "11:00", LONDON))).toBe("closed");
      const friOff = site(LONDON, week, { "2026-09-25": closed });
      expect(scheduledModeAt(friOff, wall("2026-09-25", "19:00", LONDON))).toBe("closed");
      expect(scheduledModeAt(friOff, wall("2026-09-26", "01:00", LONDON))).toBe("closed");
      expect(scheduledModeAt(friOff, wall("2026-09-26", "11:00", LONDON))).toBe("open");
    });

    it("an exception replaces its date's window (a late night on a normally-closed Sunday)", () => {
      const h = site(LONDON, {}, { "2026-09-27": hours("20:00", "23:00") });
      expect(scheduledModeAt(h, wall("2026-09-27", "21:00", LONDON))).toBe("open");
      expect(scheduledModeAt(h, wall("2026-10-04", "21:00", LONDON))).toBe("closed");
    });

    it("a window DST collapses to nothing is dropped (NY 2026-03-08 02:30–03:00 lies in the gap)", () => {
      const h = site(NEW_YORK, { 7: hours("02:30", "03:00") });
      expect(scheduledModeAt(h, new Date("2026-03-08T07:15:00.000Z"))).toBe("closed");
      expect(openingAfter(h, new Date("2026-03-08T00:00:00.000Z"))?.toISOString()).toBe("2026-03-15T06:30:00.000Z");
    });

    it("not set: open all the time", () => {
      expect(scheduledModeAt({ state: "not_set" }, new Date("2026-09-23T03:00:00.000Z"))).toBe("open");
    });
  });

  describe("changeAfter / openingAfter", () => {
    it("the next boundary of a plain week", () => {
      expect(changeAfter(WEEKDAYS_9_5, wall("2026-09-23", "12:00", LONDON))).toEqual({ at: wall("2026-09-23", "17:00", LONDON), to: "closed" });
      expect(changeAfter(WEEKDAYS_9_5, wall("2026-09-23", "17:00", LONDON))).toEqual({ at: wall("2026-09-24", "09:00", LONDON), to: "open" });
      // Friday evening → Monday morning.
      expect(changeAfter(WEEKDAYS_9_5, wall("2026-09-25", "18:00", LONDON))).toEqual({ at: wall("2026-09-28", "09:00", LONDON), to: "open" });
      expect(openingAfter(WEEKDAYS_9_5, wall("2026-09-23", "12:00", LONDON))).toEqual(wall("2026-09-24", "09:00", LONDON));
    });

    it("Friday's tail is found from Saturday (the D−1 lookup)", () => {
      const h = site(LONDON, { 5: hours("18:00", "02:00") });
      expect(changeAfter(h, wall("2026-09-26", "01:00", LONDON))).toEqual({ at: wall("2026-09-26", "02:00", LONDON), to: "closed" });
    });

    it("Mon + Tue open all day has no midnight boundary", () => {
      const h = site(LONDON, { 1: allDay, 2: allDay });
      expect(changeAfter(h, wall("2026-09-21", "23:59", LONDON))).toEqual({ at: wall("2026-09-23", "00:00", LONDON), to: "closed" });
      expect(lastChangeAtOrBefore(h, wall("2026-09-22", "12:00", LONDON))).toEqual(wall("2026-09-21", "00:00", LONDON));
    });

    it("a Fri 18:00–02:00 tail merges with a Sat 01:00 opening: one window to Sat 05:00", () => {
      const h = site(LONDON, { 5: hours("18:00", "02:00"), 6: hours("01:00", "05:00") });
      expect(changeAfter(h, wall("2026-09-25", "19:00", LONDON))).toEqual({ at: wall("2026-09-26", "05:00", LONDON), to: "closed" });
      expect(openingAfter(h, wall("2026-09-25", "19:00", LONDON))).toEqual(wall("2026-10-02", "18:00", LONDON));
    });

    it("all closed: no opening ahead, and cheap — closed days cost no Intl call", () => {
      const h = site(LONDON, {});
      const noon = wall("2026-09-23", "12:00", LONDON);
      const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
      try {
        expect(openingAfter(h, noon)).toBeNull();
        expect(changeAfter(h, noon)).toBeNull();
        // One call each for "which local date is it".
        expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
      expect(scheduledModeAt(h, wall("2026-09-23", "12:00", LONDON))).toBe("closed");
    });

    it("24/7: no change ahead, never a fake one at the horizon", () => {
      const h = site(LONDON, { 1: allDay, 2: allDay, 3: allDay, 4: allDay, 5: allDay, 6: allDay, 7: allDay });
      expect(changeAfter(h, wall("2026-09-23", "12:00", LONDON))).toBeNull();
      expect(openingAfter(h, wall("2026-09-23", "12:00", LONDON))).toBeNull();
      expect(lastChangeAtOrBefore(h, wall("2026-09-23", "12:00", LONDON))).toBeNull();
      expect(scheduledModeAt(h, wall("2026-09-23", "12:00", LONDON))).toBe("open");
    });

    it("an exception-only change 200 days out is found", () => {
      const now = wall("2026-09-23", "12:00", LONDON);
      const day = ymdAddDays("2026-09-23", 200);
      const h = site(LONDON, {}, { [day]: hours("10:00", "12:00") });
      expect(openingAfter(h, now)).toEqual(wall(day, "10:00", LONDON));
      expect(changeAfter(h, now)).toEqual({ at: wall(day, "10:00", LONDON), to: "open" });
    });

    it("the horizon covers the furthest special day a person may set (today + 366)", () => {
      const now = wall("2026-09-23", "12:00", LONDON);
      const day = ymdAddDays("2026-09-23", 366);
      expect(openingAfter(site(LONDON, {}, { [day]: allDay }), now)).toEqual(wall(day, "00:00", LONDON));
      expect(HOURS_HORIZON_DAYS).toBeGreaterThanOrEqual(366);
    });

    it("stepping every minute across NY fall-back night with a 01:30 close gives exactly ONE open→closed change", () => {
      // Sat 2026-10-31 18:00 → Sun 01:30, and 01:30 happens twice that night.
      const h = site(NEW_YORK, { 6: hours("18:00", "01:30") });
      const start = new Date("2026-11-01T00:00:00.000Z"); // Sat 20:00 EDT
      const end = new Date("2026-11-01T09:00:00.000Z"); // Sun 04:00 EST
      const changes: Array<{ at: string; to: string }> = [];
      let prev = scheduledModeAt(h, start);
      for (let t = start.getTime() + 60_000; t <= end.getTime(); t += 60_000) {
        const m = scheduledModeAt(h, new Date(t));
        if (m !== prev) changes.push({ at: new Date(t).toISOString(), to: m });
        prev = m;
      }
      expect(changes).toEqual([{ at: "2026-11-01T05:30:00.000Z", to: "closed" }]);
      expect(changeAfter(h, start)).toEqual({ at: new Date("2026-11-01T05:30:00.000Z"), to: "closed" });
    });

    it("not set: no boundary in either direction", () => {
      const t = new Date("2026-09-23T03:00:00.000Z");
      expect(changeAfter({ state: "not_set" }, t)).toBeNull();
      expect(openingAfter({ state: "not_set" }, t)).toBeNull();
      expect(lastChangeAtOrBefore({ state: "not_set" }, t)).toBeNull();
    });
  });

  describe("lastChangeAtOrBefore", () => {
    it("the boundary that stamps a schedule flip — at or before t", () => {
      expect(lastChangeAtOrBefore(WEEKDAYS_9_5, wall("2026-09-23", "12:00", LONDON))).toEqual(wall("2026-09-23", "09:00", LONDON));
      expect(lastChangeAtOrBefore(WEEKDAYS_9_5, wall("2026-09-23", "20:00", LONDON))).toEqual(wall("2026-09-23", "17:00", LONDON));
      expect(lastChangeAtOrBefore(WEEKDAYS_9_5, wall("2026-09-23", "17:00", LONDON))).toEqual(wall("2026-09-23", "17:00", LONDON));
      // Sunday: Friday's close.
      expect(lastChangeAtOrBefore(WEEKDAYS_9_5, wall("2026-09-27", "12:00", LONDON))).toEqual(wall("2026-09-25", "17:00", LONDON));
    });
  });

  describe("openWindowsBetween — the 7-day preview", () => {
    it("clips to [from, to) and lists every open window in between", () => {
      const from = wall("2026-09-23", "12:00", LONDON);
      const to = new Date(from.getTime() + 7 * 86_400_000);
      const w = openWindowsBetween(WEEKDAYS_9_5, from, to);
      expect(w.map((x) => [x.start.toISOString(), x.end.toISOString()])).toEqual([
        [from.toISOString(), wall("2026-09-23", "17:00", LONDON).toISOString()],
        [wall("2026-09-24", "09:00", LONDON).toISOString(), wall("2026-09-24", "17:00", LONDON).toISOString()],
        [wall("2026-09-25", "09:00", LONDON).toISOString(), wall("2026-09-25", "17:00", LONDON).toISOString()],
        [wall("2026-09-28", "09:00", LONDON).toISOString(), wall("2026-09-28", "17:00", LONDON).toISOString()],
        [wall("2026-09-29", "09:00", LONDON).toISOString(), wall("2026-09-29", "17:00", LONDON).toISOString()],
        [wall("2026-09-30", "09:00", LONDON).toISOString(), to.toISOString()],
      ]);
    });

    it("not set: the whole range; an empty range: nothing", () => {
      const from = new Date("2026-09-23T00:00:00.000Z");
      const to = new Date("2026-09-24T00:00:00.000Z");
      expect(openWindowsBetween({ state: "not_set" }, from, to)).toEqual([{ start: from, end: to }]);
      expect(openWindowsBetween(WEEKDAYS_9_5, to, from)).toEqual([]);
    });
  });
});

describe("validation and formatting", () => {
  it("validateDay: equal times and out-of-range minutes", () => {
    expect(validateDay(hours("09:00", "17:00"))).toBeNull();
    expect(validateDay(hours("18:00", "02:00"))).toBeNull();
    expect(validateDay({ kind: "hours", opensMin: 540, closesMin: 540 })).toBe("SAME_OPEN_CLOSE");
    expect(validateDay({ kind: "hours", opensMin: 540, closesMin: 1440 })).toBe("MINUTE_RANGE");
    expect(validateDay({ kind: "hours", opensMin: -1, closesMin: 60 })).toBe("MINUTE_RANGE");
    expect(validateDay({ kind: "hours", opensMin: 1.5, closesMin: 60 })).toBe("MINUTE_RANGE");
    expect(validateDay(closed)).toBeNull();
    expect(validateDay(allDay)).toBeNull();
  });

  it("validateWeek: exactly 7, each weekday once, each day valid", () => {
    const seven = ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...closed }));
    expect(validateWeek(seven)).toBeNull();
    expect(validateWeek(seven.slice(0, 6))?.code).toBe("WEEKDAYS");
    expect(validateWeek([...seven.slice(0, 6), { weekday: 1, ...closed }])?.code).toBe("WEEKDAYS");
    expect(validateWeek([...seven.slice(0, 6), { weekday: 8, ...closed }])?.code).toBe("WEEKDAYS");
    expect(validateWeek([...seven.slice(0, 6), { weekday: 7, kind: "hours", opensMin: 60, closesMin: 60 }])).toMatchObject({
      code: "SAME_OPEN_CLOSE",
      weekday: 7,
    });
    expect(() => weekFrom(seven.slice(0, 6))).toThrow(RangeError);
  });

  it("HH:MM round-trips; nonsense is refused", () => {
    expect(hhmmToMinutes("00:00")).toBe(0);
    expect(hhmmToMinutes("23:59")).toBe(1439);
    expect(hhmmToMinutes("24:00")).toBeNull();
    expect(hhmmToMinutes("9:00")).toBeNull();
    expect(minutesToHhmm(545)).toBe("09:05");
    expect(() => minutesToHhmm(1440)).toThrow(RangeError);
  });

  it("server copy formats in the SITE zone: 24-hour for audit rows, the dashboard's 12-hour for what /security shows", () => {
    const at = new Date("2026-09-29T08:00:00.000Z");
    expect(siteClock(at, LONDON)).toBe("09:00");
    expect(siteClockCopy(at, LONDON)).toBe("9:00 AM");
    expect(siteClockCopy(at, "Pacific/Kiritimati")).toBe("10:00 PM");
    expect(siteClockCopy(new Date("2026-09-29T11:05:00.000Z"), LONDON)).toBe("12:05 PM");
    expect(siteClockCopy(new Date("2026-09-28T23:05:00.000Z"), LONDON)).toBe("12:05 AM");
  });

  // The same rules as the dashboard's formatSiteWhen (apps/web-dashboard/src/lib/security-time.ts).
  it.each([
    ["the same site day", "2026-09-29T16:02:00.000Z", "5:02 PM"],
    ["the next site day", "2026-09-30T08:00:00.000Z", "9:00 AM tomorrow"],
    ["within 6 days ahead", "2026-10-02T08:00:00.000Z", "Fri 9:00 AM"],
    ["within 6 days back", "2026-09-26T16:02:00.000Z", "Sat 5:02 PM"],
    ["further", "2026-09-10T16:02:00.000Z", "Sep 10, 5:02 PM"],
  ])("siteDayClockCopy, %s", (_n, iso, want) => {
    expect(siteDayClockCopy(new Date(iso), LONDON, new Date("2026-09-29T11:00:00.000Z"))).toBe(want);
  });

  it("siteDayClockCopy counts days in the SITE zone, not UTC", () => {
    // 23:30 UTC on the 29th is already the 30th in Kiritimati (UTC+14): tomorrow there only if now is the 29th there.
    expect(siteDayClockCopy(new Date("2026-09-29T23:30:00.000Z"), "Pacific/Kiritimati", new Date("2026-09-29T08:00:00.000Z"))).toBe(
      "1:30 PM tomorrow",
    );
  });
});

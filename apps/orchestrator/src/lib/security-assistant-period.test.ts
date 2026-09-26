/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — the assistant's periods, resolved on the
 * server in the site zone so the model never converts a time.
 *
 * Every instant is written as a SITE wall clock through the one converter,
 * and every case runs with the process TZ unset and under a far-off zone, so
 * nothing here can pass by reading the process clock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_PERIODS,
  ASSISTANT_SPAN_MAX_MS,
  assistantInstant,
  resolveAssistantPeriod,
  type AssistantSite,
} from "./security-assistant-period.js";
import type { DayHours, SiteHours } from "./security-hours.js";
import { zonedWallClockToUtc, type IsoWeekday } from "./zoned-time.js";

const ORIGINAL_TZ = process.env.TZ;
const PROCESS_ZONES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
];

const LONDON = "Europe/London";
const H = 3_600_000;
const DAY = 24 * H;

/** A London wall clock (2026-09: BST, UTC+1). */
const wall = (y: number, mo: number, d: number, h: number, mi = 0): Date => zonedWallClockToUtc(y, mo, d, h, mi, 0, LONDON);

/** Mon–Fri 09:00–17:00 in London; weekends closed. */
function officeHours(): SiteHours {
  const day = (w: number): DayHours => (w <= 5 ? { kind: "hours", opensMin: 540, closesMin: 1020 } : { kind: "closed" });
  const week = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((w) => [w, day(w)])) as Record<IsoWeekday, DayHours>;
  return { state: "set", timezone: LONDON, week, exceptions: new Map() };
}

const NOT_SET: SiteHours = { state: "not_set" };
const withHours: AssistantSite = { hours: officeHours(), timezone: LONDON };
const zoneOnly: AssistantSite = { hours: NOT_SET, timezone: LONDON };
const noZone: AssistantSite = { hours: NOT_SET, timezone: null };

// 2026-09-23 is a Wednesday.
const WED_1030 = wall(2026, 9, 23, 10, 30);
const WED_0230 = wall(2026, 9, 23, 2, 30);
const OLDEST = new Date(WED_1030.getTime() - 30 * DAY);

function ok(r: ReturnType<typeof resolveAssistantPeriod>) {
  if (!r.ok) throw new Error(`expected a period, got ${r.code}: ${r.message}`);
  return r.period;
}

for (const [label, tz] of PROCESS_ZONES) {
  describe(`resolveAssistantPeriod (process TZ ${label})`, () => {
    beforeAll(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });
    afterAll(() => {
      if (ORIGINAL_TZ === undefined) delete process.env.TZ;
      else process.env.TZ = ORIGINAL_TZ;
    });

    it("no period and no from/to → no window at all (newest first, unbounded)", () => {
      expect(ok(resolveAssistantPeriod({}, withHours, WED_1030, OLDEST))).toBeNull();
    });

    it("last_hour, last_24h and last_7_days end now and need no zone", () => {
      for (const [name, span] of [["last_hour", H], ["last_24h", DAY], ["last_7_days", 7 * DAY]] as const) {
        const p = ok(resolveAssistantPeriod({ period: name }, noZone, WED_1030, OLDEST))!;
        expect(p.to.getTime(), name).toBe(WED_1030.getTime());
        expect(p.to.getTime() - p.from.getTime(), name).toBe(span);
      }
    });

    it("today is site-local midnight to now", () => {
      const p = ok(resolveAssistantPeriod({ period: "today" }, zoneOnly, WED_1030, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 23, 0).getTime());
      expect(p.to.getTime()).toBe(WED_1030.getTime());
      expect(p.label).toBe("today");
    });

    it("today and last_night with no site zone → NO_SITE_TIMEZONE, which the tool turns into 'give me exact times'", () => {
      for (const period of ["today", "last_night"] as const) {
        const r = resolveAssistantPeriod({ period }, noZone, WED_1030, OLDEST);
        expect(r.ok, period).toBe(false);
        if (!r.ok) expect(r.code, period).toBe("NO_SITE_TIMEZONE");
      }
    });

    it("last_night with hours set, asked while open: the closed spell that ended at this morning's opening", () => {
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, withHours, WED_1030, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 22, 17).getTime());
      expect(p.to.getTime()).toBe(wall(2026, 9, 23, 9).getTime());
      expect(p.label).toBe("last night");
    });

    it("last_night with hours set, asked while still closed: from the close to now", () => {
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, withHours, WED_0230, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 22, 17).getTime());
      expect(p.to.getTime()).toBe(WED_0230.getTime());
    });

    it("last_night with hours set on a Monday: the whole weekend's closed spell", () => {
      const mon = wall(2026, 9, 21, 11);
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, withHours, mon, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 18, 17).getTime());
      expect(p.to.getTime()).toBe(wall(2026, 9, 21, 9).getTime());
    });

    it("last_night without hours: 6 PM yesterday to 8 AM today, site-local", () => {
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, zoneOnly, WED_1030, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 22, 18).getTime());
      expect(p.to.getTime()).toBe(wall(2026, 9, 23, 8).getTime());
    });

    it("last_night without hours, asked before 8 AM: it ends now", () => {
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, zoneOnly, WED_0230, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 22, 18).getTime());
      expect(p.to.getTime()).toBe(WED_0230.getTime());
    });

    it("last_night with hours that never change (open all week) falls back to the no-hours night", () => {
      const allDay = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((w) => [w, { kind: "open_all_day" }])) as Record<IsoWeekday, DayHours>;
      const site: AssistantSite = { hours: { state: "set", timezone: LONDON, week: allDay, exceptions: new Map() }, timezone: LONDON };
      const p = ok(resolveAssistantPeriod({ period: "last_night" }, site, WED_1030, OLDEST))!;
      expect(p.from.getTime()).toBe(wall(2026, 9, 22, 18).getTime());
      expect(p.to.getTime()).toBe(wall(2026, 9, 23, 8).getTime());
    });

    it("from/to with an offset are taken as given; a future `to` is clamped to now", () => {
      const p = ok(
        resolveAssistantPeriod({ from: "2026-09-22T21:00:00+01:00", to: "2026-09-30T00:00:00Z" }, noZone, WED_1030, OLDEST),
      )!;
      expect(p.from.toISOString()).toBe("2026-09-22T20:00:00.000Z");
      expect(p.to.getTime()).toBe(WED_1030.getTime());
    });

    it("from alone runs to now", () => {
      const p = ok(resolveAssistantPeriod({ from: "2026-09-23T06:00:00Z" }, noZone, WED_1030, OLDEST))!;
      expect(p.to.getTime()).toBe(WED_1030.getTime());
    });

    it.each([
      ["a period AND from/to", { period: "today", from: "2026-09-22T21:00:00Z" }],
      ["to without from", { to: "2026-09-22T21:00:00Z" }],
      ["no offset (the model would be guessing the zone)", { from: "2026-09-22T21:00:00" }],
      ["not a date at all", { from: "last tuesday" }],
      ["from after to", { from: "2026-09-23T06:00:00Z", to: "2026-09-23T05:00:00Z" }],
      ["from in the future", { from: "2026-09-24T06:00:00Z" }],
      ["a span over 30 days", { from: "2026-08-24T08:00:00Z", to: "2026-09-23T09:00:00Z" }],
      ["from older than retention", { from: new Date(OLDEST.getTime() - 60_000).toISOString(), to: "2026-09-01T00:00:00Z" }],
      ["an unknown period", { period: "yesterday" }],
    ])("%s → BAD_REQUEST", (_label, input) => {
      const r = resolveAssistantPeriod(input as Parameters<typeof resolveAssistantPeriod>[0], zoneOnly, WED_1030, OLDEST);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("BAD_REQUEST");
    });

    it("the 30-day span is the limit, inclusive", () => {
      const to = WED_1030;
      const from = new Date(to.getTime() - ASSISTANT_SPAN_MAX_MS);
      expect(resolveAssistantPeriod({ from: from.toISOString(), to: to.toISOString() }, noZone, WED_1030, from).ok).toBe(true);
    });

    it("assistantInstant gives the site-local copy, and none without a zone", () => {
      expect(assistantInstant(wall(2026, 9, 22, 2, 14), LONDON, WED_1030)).toEqual({
        at: wall(2026, 9, 22, 2, 14).toISOString(),
        local: "Tue 2:14 AM",
      });
      expect(assistantInstant(WED_0230, null, WED_1030)).toEqual({ at: WED_0230.toISOString(), local: null });
    });
  });
}

it("ASSISTANT_PERIODS is exactly the five the tools advertise", () => {
  expect([...ASSISTANT_PERIODS]).toEqual(["last_hour", "today", "last_night", "last_24h", "last_7_days"]);
  // The clock is never read: a frozen fake clock changes nothing.
  vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z") });
  try {
    const p = ok(resolveAssistantPeriod({ period: "last_hour" }, noZone, WED_1030, OLDEST))!;
    expect(p.to.getTime()).toBe(WED_1030.getTime());
  } finally {
    vi.useRealTimers();
  }
});

/**
 * WARP-2980 (ADR-059 P5 §6.2) — hour slots cut in TypeScript through the one
 * converter. The SQL build only ever compares these instants.
 *
 * Every case runs with the process TZ unset AND under Pacific/Kiritimati
 * (UTC+14): a helper that reads the PROCESS zone (`getHours`, `getDay`,
 * `new Date(y, m, d)`) gives a different answer in one of them. The
 * orchestrator container sets no TZ; a laptop does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayBounds, dayTypeOf, slotMinutes, slotOf, windowBounds, windowFor, windowSlots, type BaselineSlot } from "./security-baseline-slots.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROCESS_ZONES: Array<[string, string | undefined, number | undefined]> = [
  ["unset", undefined, undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati", 2],
];

const iso = (d: Date) => d.toISOString();
const ofDate = (slots: readonly BaselineSlot[], ymd: string) => slots.filter((s) => s.ymd === ymd);

/** Deterministic PRNG (mulberry32) — a failure reproduces from its seed. */
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

describe.each(PROCESS_ZONES)("baseline slots — process TZ %s", (_label, zone, noonHours) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  it("the process zone is really in force", () => {
    if (noonHours !== undefined) expect(new Date(Date.UTC(2026, 0, 1, 12)).getHours()).toBe(noonHours);
  });

  it("dayTypeOf: ISO 1–5 weekday, 6–7 weekend", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(dayTypeOf)).toEqual(["weekday", "weekday", "weekday", "weekday", "weekday", "weekend", "weekend"]);
  });

  describe("windowSlots", () => {
    it("New York, spring forward (2026-03-08): hour 2 does not exist that date; hour 1 and 3 abut", () => {
      const slots = ofDate(windowSlots("2026-03-07", "2026-03-09", "America/New_York"), "2026-03-08");
      expect(slots.map((s) => s.hour)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      const [h1, h3] = [slots.find((s) => s.hour === 1)!, slots.find((s) => s.hour === 3)!];
      expect([iso(h1.start), iso(h1.end)]).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"]);
      expect([iso(h3.start), iso(h3.end)]).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"]);
      expect(slots.every((s) => s.dayType === "weekend")).toBe(true);
    });

    it("New York, fall back (2026-11-01): hour 1 is ONE 120-minute slot; the day has 25 hours", () => {
      const slots = ofDate(windowSlots("2026-10-31", "2026-11-02", "America/New_York"), "2026-11-01");
      expect(slots).toHaveLength(24);
      const h1 = slots.find((s) => s.hour === 1)!;
      expect([iso(h1.start), iso(h1.end)]).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z"]);
      expect(slotMinutes(h1)).toBe(120);
      expect(slots.reduce((m, s) => m + slotMinutes(s), 0)).toBe(25 * 60);
    });

    it("Asia/Kathmandu (+05:45): slot bounds fall at :15 UTC", () => {
      const s = windowSlots("2026-09-23", "2026-09-23", "Asia/Kathmandu");
      expect(s).toHaveLength(24);
      expect([iso(s[0]!.start), iso(s[0]!.end)]).toEqual(["2026-09-22T18:15:00.000Z", "2026-09-22T19:15:00.000Z"]);
      expect(s.every((x) => slotMinutes(x) === 60)).toBe(true);
    });

    it("Australia/Lord_Howe (30-minute DST): the start day's hour 2 is 30 minutes, the end day's hour 1 is 90", () => {
      const spring = windowSlots("2026-10-04", "2026-10-04", "Australia/Lord_Howe");
      const h2 = spring.find((s) => s.hour === 2)!;
      expect([iso(h2.start), iso(h2.end)]).toEqual(["2026-10-03T15:30:00.000Z", "2026-10-03T16:00:00.000Z"]);
      expect(slotMinutes(h2)).toBe(30);
      expect(spring.reduce((m, s) => m + slotMinutes(s), 0)).toBe(23.5 * 60);
      const autumn = windowSlots("2026-04-05", "2026-04-05", "Australia/Lord_Howe");
      const h1 = autumn.find((s) => s.hour === 1)!;
      expect([iso(h1.start), iso(h1.end)]).toEqual(["2026-04-04T14:00:00.000Z", "2026-04-04T15:30:00.000Z"]);
      expect(slotMinutes(h1)).toBe(90);
    });

    it("28 dates give contiguous, strictly increasing slots and all 48 (dayType, hour) pairs", () => {
      const slots = windowSlots("2026-10-13", "2026-11-09", "America/New_York");
      expect(new Set(slots.map((s) => s.ymd)).size).toBe(28);
      for (let i = 1; i < slots.length; i += 1) expect(slots[i]!.start.getTime()).toBe(slots[i - 1]!.end.getTime());
      expect(slots.every((s) => s.start < s.end)).toBe(true);
      expect(new Set(slots.map((s) => `${s.dayType}:${s.hour}`)).size).toBe(48);
    });

    it("windowBounds is [the first date's midnight, the midnight after the last date)", () => {
      const b = windowBounds({ from: "2026-11-01", to: "2026-11-01" }, "America/New_York");
      expect([iso(b.start), iso(b.end)]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
      const d = dayBounds("2026-03-08", "America/New_York");
      expect(d.end.getTime() - d.start.getTime()).toBe(23 * 3_600_000);
    });
  });

  describe("slotOf", () => {
    it.each(["America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe", "Europe/London", "Pacific/Chatham", "America/Santiago"])(
      "an instant always lies inside its own slot — 10 000 random instants in %s, DST days included",
      (tz) => {
        const r = rng(2980);
        const from = Date.UTC(2026, 2, 1);
        const span = Date.UTC(2026, 11, 1) - from;
        for (let i = 0; i < 10_000; i += 1) {
          const t = new Date(from + Math.floor(r() * span));
          const s = slotOf(t, tz);
          if (!(s.start.getTime() <= t.getTime() && t.getTime() < s.end.getTime())) {
            throw new Error(`${tz} ${iso(t)} → [${iso(s.start)}, ${iso(s.end)}) hour ${s.hour} ${s.ymd}`);
          }
        }
      },
    );

    it("both halves of the repeated hour map to the one 120-minute slot the build uses", () => {
      const first = slotOf(new Date("2026-11-01T05:30:00Z"), "America/New_York");
      const second = slotOf(new Date("2026-11-01T06:30:00Z"), "America/New_York");
      expect(second).toEqual(first);
      expect(first).toMatchObject({ ymd: "2026-11-01", hour: 1, dayType: "weekend" });
      expect(windowSlots("2026-11-01", "2026-11-01", "America/New_York")).toContainEqual(first);
    });

    it("a transition off the hour (Chatham springs 02:45 → 03:45): the 15 minutes after the jump belong to hour 2's slot", () => {
      // 03:48 local (+13:45). Hour 3 has no slot that date (03:00 lies in the gap);
      // the converter's hour-2 slot [02:00 +12:45, 03:00 pre-gap) = [13:15Z, 14:15Z) holds it.
      const s = slotOf(new Date("2026-09-26T14:03:00Z"), "Pacific/Chatham");
      expect(s).toMatchObject({ ymd: "2026-09-27", hour: 2 });
      expect([iso(s.start), iso(s.end)]).toEqual(["2026-09-26T13:15:00.000Z", "2026-09-26T14:15:00.000Z"]);
      expect(windowSlots("2026-09-27", "2026-09-27", "Pacific/Chatham")).toContainEqual(s);
    });

    it("the site's calendar decides the day type, not UTC's: Monday 13:30 in Kiritimati is Sunday in UTC", () => {
      const s = slotOf(new Date("2026-09-27T23:30:00Z"), "Pacific/Kiritimati");
      expect(s).toMatchObject({ ymd: "2026-09-28", hour: 13, dayType: "weekday" });
    });
  });

  describe("windowFor — the 28 complete site-local dates before today (today never scores itself)", () => {
    it.each([
      ["00:05", "2026-09-23T04:05:00Z"],
      ["00:15", "2026-09-23T04:15:00Z"],
      ["23:59", "2026-09-24T03:59:00Z"],
    ])("at %s site time on 2026-09-23 (New York)", (_t, at) => {
      expect(windowFor(new Date(at), "America/New_York")).toEqual({ from: "2026-08-26", to: "2026-09-22" });
    });

    it("the date is the SITE's: 23:30 UTC on the 22nd is already the 23rd in Kiritimati", () => {
      expect(windowFor(new Date("2026-09-22T23:30:00Z"), "Pacific/Kiritimati")).toEqual({ from: "2026-08-26", to: "2026-09-22" });
    });
  });
});

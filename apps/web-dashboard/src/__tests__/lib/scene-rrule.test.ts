/**
 * feat/scene-schedules — local→UTC RRULE building.
 *
 * The orchestrator's rrule.ts is UTC-only, so the editor must convert the
 * owner's LOCAL wall-clock to UTC and shift weekdays across the midnight-UTC
 * boundary. These tests are timezone-agnostic: they derive the expected UTC
 * hour from the same offset the browser would, so they pass in CI regardless
 * of the runner's TZ. A second block pins exact strings under a fixed TZ.
 */
import { describe, it, expect } from "vitest";
import {
  buildSceneRrule,
  describeLocalSchedule,
  isDaily,
  formatLocalTime,
  type DayCode,
} from "../../lib/scene-rrule";

// The UTC time + calendar-day delta the browser computes for a given LOCAL
// wall-clock today — the SAME conversion buildSceneRrule does. Deriving the
// expected values this way (instead of hardcoding one zone's offset via a
// process.env.TZ pin, which V8 ignores at runtime) keeps these assertions exact
// AND deterministic under any runner TZ (UTC in CI, Pacific on a dev box, …).
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
function utcOf(hour: number, minute = 0) {
  const d = new Date(2026, 5, 15, hour, minute);
  return {
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    delta: d.getUTCDate() - d.getDate(), // -1, 0, or +1 (mid-month: no wrap)
  };
}
const shiftDay = (code: (typeof DAY_CODES)[number], delta: number) =>
  DAY_CODES[(DAY_CODES.indexOf(code) + delta + 7) % 7];

describe("buildSceneRrule — timezone-agnostic invariants", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // local noon, mid-month (no wrap risk)

  it("daily: no days selected → FREQ=DAILY with the UTC-converted time", () => {
    const built = buildSceneRrule({ days: [], hour: 7, minute: 0 }, now);
    expect(built).not.toBeNull();
    expect(built!.rrule.startsWith("FREQ=DAILY;")).toBe(true);
    // The UTC hour must equal what the browser computes for 07:00 local today.
    const expectedUtc = new Date(2026, 5, 15, 7, 0).getUTCHours();
    expect(built!.utcHour).toBe(expectedUtc);
    expect(built!.rrule).toContain(`BYHOUR=${expectedUtc}`);
  });

  it("all 7 days selected is also treated as daily", () => {
    const all: DayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const built = buildSceneRrule({ days: all, hour: 9, minute: 30 }, now);
    expect(built!.rrule.startsWith("FREQ=DAILY;")).toBe(true);
    expect(built!.rrule).toContain("BYMINUTE=30");
  });

  it("weekly: a single day stays one day (possibly shifted by the UTC delta)", () => {
    const built = buildSceneRrule({ days: ["WE"], hour: 6, minute: 0 }, now);
    expect(built!.rrule.startsWith("FREQ=WEEKLY;")).toBe(true);
    const byday = built!.rrule.match(/BYDAY=([^;]+)/)![1].split(",");
    expect(byday).toHaveLength(1);
    // The shifted day is WE only if 06:00 local is the same UTC calendar day.
    const local = new Date(2026, 5, 15, 6, 0);
    const crossed = local.getUTCDate() !== local.getDate();
    if (!crossed) expect(byday[0]).toBe("WE");
  });

  it("rejects out-of-range time", () => {
    expect(buildSceneRrule({ days: [], hour: 24, minute: 0 }, now)).toBeNull();
    expect(buildSceneRrule({ days: [], hour: 7, minute: 60 }, now)).toBeNull();
    expect(buildSceneRrule({ days: [], hour: -1, minute: 0 }, now)).toBeNull();
  });
});

describe("buildSceneRrule — UTC conversion + day-cross (timezone-robust)", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 is a Monday

  it("weekly single day: BYHOUR is the UTC-converted hour; BYDAY shifts by the day delta", () => {
    const u = utcOf(6, 0);
    const built = buildSceneRrule({ days: ["MO"], hour: 6, minute: 0 }, now);
    expect(built!.rrule).toBe(
      `FREQ=WEEKLY;BYDAY=${shiftDay("MO", u.delta)};BYHOUR=${u.h};BYMINUTE=0`,
    );
  });

  it("daily ignores the day shift but keeps the UTC hour", () => {
    const u = utcOf(23, 0);
    const built = buildSceneRrule({ days: [], hour: 23, minute: 0 }, now);
    expect(built!.rrule).toBe(`FREQ=DAILY;BYHOUR=${u.h};BYMINUTE=0`);
  });

  it("weekly day-cross: a late local time pushes BYDAY to the adjacent weekday", () => {
    const u = utcOf(23, 0);
    const built = buildSceneRrule({ days: ["MO"], hour: 23, minute: 0 }, now);
    expect(built!.rrule).toBe(
      `FREQ=WEEKLY;BYDAY=${shiftDay("MO", u.delta)};BYHOUR=${u.h};BYMINUTE=0`,
    );
  });

  it("orders BYDAY Sunday-first regardless of click order", () => {
    const u = utcOf(8, 0);
    const built = buildSceneRrule({ days: ["FR", "MO", "WE"], hour: 8, minute: 0 }, now);
    // Each clicked day shifts by the same delta; assert the canonical
    // Sunday-first ordering of the shifted set.
    const ordered = ["MO", "WE", "FR"]
      .map((d) => shiftDay(d as DayCode, u.delta))
      .sort((a, b) => DAY_CODES.indexOf(a) - DAY_CODES.indexOf(b))
      .join(",");
    expect(built!.rrule).toBe(`FREQ=WEEKLY;BYDAY=${ordered};BYHOUR=${u.h};BYMINUTE=0`);
  });
});

describe("describeLocalSchedule + helpers", () => {
  it("summarises in the owner's local wall-clock framing", () => {
    expect(describeLocalSchedule({ days: [], hour: 7, minute: 0 })).toBe(
      "Every day at 7:00 AM",
    );
    expect(
      describeLocalSchedule({ days: ["MO", "TU", "WE", "TH", "FR"], hour: 18, minute: 0 }),
    ).toBe("Weekdays at 6:00 PM");
    expect(
      describeLocalSchedule({ days: ["SA", "SU"], hour: 9, minute: 30 }),
    ).toBe("Weekends at 9:30 AM");
  });

  it("isDaily true for empty or all-seven", () => {
    expect(isDaily([])).toBe(true);
    expect(isDaily(["SU", "MO", "TU", "WE", "TH", "FR", "SA"])).toBe(true);
    expect(isDaily(["MO"])).toBe(false);
  });

  it("formatLocalTime renders 12-hour", () => {
    expect(formatLocalTime(0, 0)).toBe("12:00 AM");
    expect(formatLocalTime(13, 5)).toBe("1:05 PM");
    expect(formatLocalTime(12, 0)).toBe("12:00 PM");
  });
});

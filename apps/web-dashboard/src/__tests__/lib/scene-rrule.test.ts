/**
 * feat/scene-schedules — local→UTC RRULE building.
 *
 * The orchestrator's rrule.ts is UTC-only, so the editor must convert the
 * owner's LOCAL wall-clock to UTC and shift weekdays across the midnight-UTC
 * boundary. These tests are timezone-agnostic: they derive the expected UTC
 * hour from the same offset the browser would, so they pass in CI regardless
 * of the runner's TZ. A second block pins exact strings under a fixed TZ.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildSceneRrule,
  describeLocalSchedule,
  isDaily,
  formatLocalTime,
  type DayCode,
} from "../../lib/scene-rrule";

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

describe("buildSceneRrule — fixed UTC offset (TZ=America/Los_Angeles, UTC-7 in June)", () => {
  const orig = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env.TZ = orig;
  });
  const now = new Date(2026, 5, 15, 12, 0, 0);

  it("Monday 06:00 PDT → 13:00 UTC, same weekday (no boundary cross)", () => {
    const built = buildSceneRrule({ days: ["MO"], hour: 6, minute: 0 }, now);
    expect(built!.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=13;BYMINUTE=0");
  });

  it("daily 23:00 PDT → 06:00 UTC next day (daily ignores day shift)", () => {
    const built = buildSceneRrule({ days: [], hour: 23, minute: 0 }, now);
    expect(built!.rrule).toBe("FREQ=DAILY;BYHOUR=6;BYMINUTE=0");
  });

  it("weekly Monday 23:00 PDT crosses to Tuesday 06:00 UTC → BYDAY shifts to TU", () => {
    const built = buildSceneRrule({ days: ["MO"], hour: 23, minute: 0 }, now);
    expect(built!.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;BYHOUR=6;BYMINUTE=0");
  });

  it("orders BYDAY Sunday-first regardless of click order", () => {
    const built = buildSceneRrule(
      { days: ["FR", "MO", "WE"], hour: 8, minute: 0 },
      now,
    );
    // 08:00 PDT = 15:00 UTC, same day → no shift.
    expect(built!.rrule).toBe(
      "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=15;BYMINUTE=0",
    );
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

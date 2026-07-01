/**
 * feat/scene-schedules + KAN-6 — local-wall-clock RRULE building.
 *
 * KAN-6 stores a per-row IANA timezone, and the orchestrator interprets
 * BYHOUR/BYMINUTE as WALL-CLOCK in that zone. So the editor no longer
 * converts local→UTC (the pre-KAN-6 behaviour that drifted across DST):
 * it emits the chosen local time directly and ships the browser's IANA
 * zone alongside. These tests pin the wall-clock contract and are
 * timezone-agnostic (the rule no longer depends on the runner's offset).
 */
import { describe, it, expect } from "vitest";
import {
  buildSceneRrule,
  describeLocalSchedule,
  isDaily,
  formatLocalTime,
  resolveTimezone,
  type DayCode,
} from "../../lib/scene-rrule";

describe("buildSceneRrule — wall-clock contract (no UTC conversion)", () => {
  it("daily: no days selected → FREQ=DAILY with the chosen LOCAL time verbatim", () => {
    const built = buildSceneRrule({ days: [], hour: 7, minute: 0 });
    expect(built).not.toBeNull();
    // The chosen local time is stored as-is — NOT shifted to UTC.
    expect(built!.rrule).toBe("FREQ=DAILY;BYHOUR=7;BYMINUTE=0");
  });

  it("all 7 days selected is also treated as daily", () => {
    const all: DayCode[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const built = buildSceneRrule({ days: all, hour: 9, minute: 30 });
    expect(built!.rrule).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=30");
  });

  it("weekly single day: BYDAY is the chosen day verbatim; BYHOUR is the local hour (no day-cross shift)", () => {
    const built = buildSceneRrule({ days: ["MO"], hour: 6, minute: 0 });
    expect(built!.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=6;BYMINUTE=0");
  });

  it("a late local time does NOT push BYDAY to the adjacent weekday anymore", () => {
    // Pre-KAN-6 this shifted MO→TU (or SU) depending on the runner's offset.
    // With a stored zone the wall-clock IS the local day, so it stays Monday.
    const built = buildSceneRrule({ days: ["MO"], hour: 23, minute: 0 });
    expect(built!.rrule).toBe("FREQ=WEEKLY;BYDAY=MO;BYHOUR=23;BYMINUTE=0");
  });

  it("orders BYDAY Sunday-first regardless of click order", () => {
    const built = buildSceneRrule({ days: ["FR", "MO", "WE"], hour: 8, minute: 0 });
    expect(built!.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=8;BYMINUTE=0");
  });

  it("carries the browser's IANA timezone (defaulting to the resolved zone)", () => {
    const built = buildSceneRrule({ days: [], hour: 7, minute: 0 });
    expect(built!.timezone).toBe(resolveTimezone());
    // A resolvable IANA id (or the UTC fallback), never empty.
    expect(built!.timezone.length).toBeGreaterThan(0);
  });

  it("honours an explicit timezone override (so the field is wired, not hardcoded)", () => {
    const built = buildSceneRrule(
      { days: [], hour: 7, minute: 0 },
      "America/Los_Angeles",
    );
    expect(built!.timezone).toBe("America/Los_Angeles");
  });

  it("rejects out-of-range time", () => {
    expect(buildSceneRrule({ days: [], hour: 24, minute: 0 })).toBeNull();
    expect(buildSceneRrule({ days: [], hour: 7, minute: 60 })).toBeNull();
    expect(buildSceneRrule({ days: [], hour: -1, minute: 0 })).toBeNull();
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

  it("resolveTimezone returns a non-empty IANA-ish identifier", () => {
    expect(resolveTimezone().length).toBeGreaterThan(0);
  });
});

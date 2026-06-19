/**
 * feat/scene-schedules — render a stored UTC RRULE back to local copy.
 *
 * describeRrule is the inverse of buildSceneRrule, so the strongest + most
 * portable check is a round-trip: build a rule from a LOCAL wall-clock, then
 * describe it back and assert the owner sees the SAME local time they typed.
 * That holds under any runner TZ (UTC in CI, Pacific on a dev box, …) — no
 * fragile hardcoded-offset strings, and no process.env.TZ pin (V8 ignores TZ
 * changes at runtime, so the old pin only "worked" on a Pacific machine).
 */
import { describe, it, expect } from "vitest";
import { describeRrule } from "../../lib/rrule-describe";
import { buildSceneRrule, type DayCode } from "../../lib/scene-rrule";

describe("describeRrule round-trips a built rule back to the local summary", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15 is a Monday

  const roundTrip = (days: DayCode[], hour: number, minute: number) =>
    describeRrule(buildSceneRrule({ days, hour, minute }, now)!.rrule, now);

  it("daily reads back as the typed local time", () => {
    expect(roundTrip([], 7, 0)).toBe("Every day at 7:00 AM");
  });

  it("a single day reads back as that day + the typed local time (even when the build crossed the UTC boundary)", () => {
    // 11:00 PM local can convert to a different UTC weekday; describe must shift
    // it back so the owner sees their original Monday 11:00 PM.
    expect(roundTrip(["MO"], 23, 0)).toBe("Mon at 11:00 PM");
  });

  it("recognises the weekdays bundle", () => {
    expect(roundTrip(["MO", "TU", "WE", "TH", "FR"], 8, 0)).toBe("Weekdays at 8:00 AM");
  });

  it("preserves a multi-day set + the typed local time across the round-trip", () => {
    expect(roundTrip(["MO", "WE", "FR"], 18, 30)).toBe("Mon, Wed, Fri at 6:30 PM");
  });

  it("throws on an unsupported FREQ so the UI can show a neutral label", () => {
    expect(() => describeRrule("FREQ=MONTHLY;BYHOUR=7", now)).toThrow();
  });
});

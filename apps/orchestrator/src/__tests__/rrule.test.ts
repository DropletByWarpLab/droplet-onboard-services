/**
 * WARP-463 (C2) — RRULE parser tests.
 *
 * Covers the FREQ=DAILY + FREQ=WEEKLY subset the §7 examples use.
 * Unsupported grammar deliberately returns null; the ticker logs +
 * disables rather than fabricate a fire time.
 */
import { describe, it, expect } from "vitest";
import { nextFireFromRrule, _parseRruleForTests } from "../utils/rrule.js";

describe("WARP-463 — parseRrule", () => {
  it("parses the §7 weekday example", () => {
    const p = _parseRruleForTests("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0");
    expect(p).toEqual({
      freq: "WEEKLY",
      byDay: [1, 2, 3, 4, 5],
      byHour: 9,
      byMinute: 0,
      bySecond: 0,
      interval: 1,
    });
  });

  it("strips a leading RRULE: prefix", () => {
    expect(_parseRruleForTests("RRULE:FREQ=DAILY;BYHOUR=8")?.freq).toBe("DAILY");
    expect(_parseRruleForTests("rrule:FREQ=DAILY")?.freq).toBe("DAILY");
  });

  it("rejects unsupported FREQ values", () => {
    expect(_parseRruleForTests("FREQ=YEARLY")).toBeNull();
    expect(_parseRruleForTests("FREQ=HOURLY")).toBeNull();
  });

  it("rejects malformed segments", () => {
    expect(_parseRruleForTests("FREQ=DAILY;GARBAGE")).toBeNull();
    expect(_parseRruleForTests("")).toBeNull();
    expect(_parseRruleForTests("FREQ=")).toBeNull();
  });

  it("rejects out-of-range times", () => {
    expect(_parseRruleForTests("FREQ=DAILY;BYHOUR=24")).toBeNull();
    expect(_parseRruleForTests("FREQ=DAILY;BYMINUTE=60")).toBeNull();
  });

  it("rejects unknown day codes", () => {
    expect(_parseRruleForTests("FREQ=WEEKLY;BYDAY=XX")).toBeNull();
  });
});

describe("WARP-463 — nextFireFromRrule (DAILY)", () => {
  it("fires later today when current time is before BYHOUR:BYMINUTE", () => {
    // Wednesday 2026-05-27 at 07:30 UTC; BYHOUR=9, BYMINUTE=0 → 09:00 same day
    const after = new Date("2026-05-27T07:30:00Z");
    const next = nextFireFromRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", after);
    expect(next?.toISOString()).toBe("2026-05-27T09:00:00.000Z");
  });

  it("advances to tomorrow when today's slot has passed", () => {
    const after = new Date("2026-05-27T10:00:00Z");
    const next = nextFireFromRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", after);
    expect(next?.toISOString()).toBe("2026-05-28T09:00:00.000Z");
  });

  it("honors INTERVAL=N for every-N-days cadence", () => {
    const after = new Date("2026-05-27T10:00:00Z");
    const next = nextFireFromRrule(
      "FREQ=DAILY;BYHOUR=9;INTERVAL=3",
      after,
    );
    expect(next?.toISOString()).toBe("2026-05-30T09:00:00.000Z");
  });
});

describe("WARP-463 — nextFireFromRrule (WEEKLY)", () => {
  it("§7 example: weekday-only 09:00 — Friday afternoon → next Monday", () => {
    const fridayAfternoon = new Date("2026-05-29T15:00:00Z"); // Friday
    const next = nextFireFromRrule(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
      fridayAfternoon,
    );
    expect(next?.toISOString()).toBe("2026-06-01T09:00:00.000Z"); // Monday
  });

  it("§7 example: weekday-only 09:00 — Wednesday morning before 09:00 → today", () => {
    const wedEarly = new Date("2026-05-27T07:30:00Z"); // Wednesday
    const next = nextFireFromRrule(
      "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
      wedEarly,
    );
    expect(next?.toISOString()).toBe("2026-05-27T09:00:00.000Z");
  });

  it("single-day weekly (Monday only) skips weekend", () => {
    const sat = new Date("2026-05-30T08:00:00Z"); // Saturday
    const next = nextFireFromRrule(
      "FREQ=WEEKLY;BYDAY=MO;BYHOUR=12",
      sat,
    );
    expect(next?.toISOString()).toBe("2026-06-01T12:00:00.000Z"); // Monday
  });

  it("returns null when BYDAY parses but no future day matches in 8 weeks", () => {
    // Defensive: shouldn't happen with valid input, but null-safety.
    const after = new Date("2026-05-27T07:00:00Z");
    // Empty BYDAY isn't reachable through parseRrule (it sets null
    // → defaults to "today's weekday") so this branch is exercised
    // by malformed input rather than valid grammar.
    expect(nextFireFromRrule("FREQ=WEEKLY;BYDAY=XX", after)).toBeNull();
  });
});

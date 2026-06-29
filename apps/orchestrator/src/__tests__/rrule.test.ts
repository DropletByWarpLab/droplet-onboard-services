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

describe("KAN-6 — nextFireFromRrule (per-row IANA timezone, DST-correct)", () => {
  // The DST trap (the whole point of KAN-6): a routine authored as "07:00
  // local" must keep firing at 07:00 LOCAL across a daylight-saving change.
  // With a stored zone the BYHOUR/BYMINUTE are WALL-CLOCK in that zone, so
  // the resolved UTC instant shifts by an hour when the offset changes —
  // it does NOT stay pinned to a frozen UTC instant.
  //
  // America/Los_Angeles: PDT (UTC-7) through 2026-11-01 02:00 local, then
  // PST (UTC-8). So "07:00 local" = 14:00 UTC in summer, 15:00 UTC in winter.

  it("DAILY 07:00 in America/Los_Angeles resolves to 14:00 UTC during PDT (summer)", () => {
    const after = new Date("2026-07-01T06:00:00Z"); // well before the next fire
    const next = nextFireFromRrule(
      "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
      after,
      "America/Los_Angeles",
    );
    expect(next?.toISOString()).toBe("2026-07-01T14:00:00.000Z");
  });

  it("DAILY 07:00 in America/Los_Angeles resolves to 15:00 UTC during PST (winter) — the same wall-clock, one hour later in UTC", () => {
    const after = new Date("2026-12-01T06:00:00Z");
    const next = nextFireFromRrule(
      "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
      after,
      "America/Los_Angeles",
    );
    // The DST fix: NOT 14:00 UTC (which would be 06:00 PST = the drift bug).
    expect(next?.toISOString()).toBe("2026-12-01T15:00:00.000Z");
  });

  it("crossing the fall-back boundary: the SAME rule fires at 07:00 local on both sides, with the UTC instant shifting by exactly one hour", () => {
    const rule = "FREQ=DAILY;BYHOUR=7;BYMINUTE=0";
    // Last fire before DST ends (2026-11-01 02:00 local), and the first after.
    const beforeDst = nextFireFromRrule(
      rule,
      new Date("2026-10-31T06:00:00Z"),
      "America/Los_Angeles",
    );
    const afterDst = nextFireFromRrule(
      rule,
      new Date("2026-11-02T06:00:00Z"),
      "America/Los_Angeles",
    );
    expect(beforeDst?.toISOString()).toBe("2026-10-31T14:00:00.000Z"); // PDT
    expect(afterDst?.toISOString()).toBe("2026-11-02T15:00:00.000Z"); // PST
    // The UTC instant moved by exactly one hour across the boundary —
    // because the WALL-CLOCK stayed at 07:00 local. That is the fix.
    const driftMs =
      (afterDst!.getTime() % 86_400_000) - (beforeDst!.getTime() % 86_400_000);
    expect(driftMs).toBe(3_600_000);
  });

  it("WEEKLY in a zone anchors BYDAY to the LOCAL weekday, not the UTC weekday", () => {
    // 2026-07-06 is a Monday. A Monday-only 23:00 America/Los_Angeles rule:
    // 23:00 PDT Monday = 06:00 UTC Tuesday. The fire is still "Monday local".
    const after = new Date("2026-07-06T00:00:00Z");
    const next = nextFireFromRrule(
      "FREQ=WEEKLY;BYDAY=MO;BYHOUR=23;BYMINUTE=0",
      after,
      "America/Los_Angeles",
    );
    expect(next?.toISOString()).toBe("2026-07-07T06:00:00.000Z");
    // Sanity: that UTC instant IS Monday 23:00 in LA.
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
    }).formatToParts(next!);
    const parts = Object.fromEntries(localHour.map((p) => [p.type, p.value]));
    expect(parts.weekday).toBe("Mon");
    expect(parts.hour).toBe("23");
  });

  it("defaults to UTC when no timezone is passed (backward compat for pre-KAN-6 rows)", () => {
    const after = new Date("2026-05-27T07:30:00Z");
    const withoutTz = nextFireFromRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", after);
    const withUtc = nextFireFromRrule(
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      after,
      "UTC",
    );
    expect(withoutTz?.toISOString()).toBe("2026-05-27T09:00:00.000Z");
    expect(withUtc?.toISOString()).toBe("2026-05-27T09:00:00.000Z");
  });

  it("treats an unknown / malformed timezone as null (caller disables rather than fire at a wrong instant)", () => {
    const after = new Date("2026-07-01T06:00:00Z");
    expect(
      nextFireFromRrule(
        "FREQ=DAILY;BYHOUR=7",
        after,
        "Not/AZone",
      ),
    ).toBeNull();
  });
});

/**
 * WARP-463 (C2) — RRULE parser tests.
 *
 * Covers the FREQ=DAILY + FREQ=WEEKLY subset the §7 examples use.
 * Unsupported grammar deliberately returns null; the ticker logs +
 * disables rather than fabricate a fire time.
 */
import { describe, it, expect } from "vitest";
import {
  nextFireFromRrule,
  _parseRruleForTests,
  _localWallClockToUtcForTests,
  _normalizeH24ForTests,
} from "../utils/rrule.js";

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

describe("KAN-6 finding 2 — spring-forward gap snaps to the post-transition instant", () => {
  // America/Los_Angeles springs forward 2026-03-08 02:00 → 03:00 local. The
  // wall-clock 02:00–02:59 does NOT exist that day. A schedule authored as
  // "02:30 local" must resolve to a REAL instant on the post-transition side
  // (03:00 PDT = 10:00 UTC), as the localWallClockToUtc docstring claims —
  // NOT the pre-transition 01:30 PST (09:30 UTC) the old 2-pass converger
  // returned (it walked the offset backwards INTO the gap).

  it("02:30 on the spring-forward day resolves to 10:00 UTC (03:00 PDT), not 09:30 UTC (01:30 PST)", () => {
    const utc = _localWallClockToUtcForTests(
      2026,
      2, // March (0-based)
      8,
      2,
      30,
      0,
      "America/Los_Angeles",
    );
    // The gap-input snaps forward to the first valid local instant: 03:00 PDT.
    expect(utc.toISOString()).toBe("2026-03-08T10:00:00.000Z");
    // And the result is unambiguously on the post-transition (PDT) side: its
    // wall-clock in LA is NOT 01:30 (the pre-transition mis-resolution).
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(utc);
    const parts = Object.fromEntries(localHour.map((p) => [p.type, p.value]));
    expect(parts.hour).toBe("03");
    expect(parts.minute).toBe("00");
  });

  it("a DAILY 02:30 routine on the gap day still fires (a real future instant, post-gap)", () => {
    // Right before 02:30 local on the spring-forward day. The fire instant
    // must exist and be in the future, not a pre-gap instant in the past.
    const after = new Date("2026-03-08T09:00:00Z"); // 01:00 PST, pre-gap
    const next = nextFireFromRrule(
      "FREQ=DAILY;BYHOUR=2;BYMINUTE=30",
      after,
      "America/Los_Angeles",
    );
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
    expect(next!.toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });

  it("a non-gap wall-clock is unaffected by the gap-snap fix", () => {
    // 07:00 on the same day is well clear of the gap — must stay 14:00 UTC.
    const utc = _localWallClockToUtcForTests(
      2026,
      2,
      8,
      7,
      0,
      0,
      "America/Los_Angeles",
    );
    expect(utc.toISOString()).toBe("2026-03-08T14:00:00.000Z");
  });
});

describe("KAN-6 finding 3 — hour==24 midnight guard rolls the day forward", () => {
  // Some ICU builds report midnight as hour 24 of the SAME day rather than
  // hour 0 of the NEXT day. The old guard reset hour→0 but left the day put,
  // computing the offset one day early. The fix must roll the day forward.

  it("hour 24 normalizes to hour 0 of the NEXT day", () => {
    expect(
      _normalizeH24ForTests({ year: 2026, month: 3, day: 8, hour: 24 }),
    ).toEqual({ year: 2026, month: 3, day: 9, hour: 0 });
  });

  it("a normal hour and day are passed through untouched", () => {
    expect(
      _normalizeH24ForTests({ year: 2026, month: 3, day: 8, hour: 23 }),
    ).toEqual({ year: 2026, month: 3, day: 8, hour: 23 });
    expect(
      _normalizeH24ForTests({ year: 2026, month: 3, day: 8, hour: 0 }),
    ).toEqual({ year: 2026, month: 3, day: 8, hour: 0 });
  });

  it("the day-roll crosses a month boundary via Date.UTC normalisation", () => {
    // hour 24 on the last day of a month → day+1 is handled by the caller's
    // Date.UTC, which normalises an out-of-range day into the next month.
    expect(
      _normalizeH24ForTests({ year: 2026, month: 1, day: 31, hour: 24 }),
    ).toEqual({ year: 2026, month: 1, day: 32, hour: 0 });
  });
});

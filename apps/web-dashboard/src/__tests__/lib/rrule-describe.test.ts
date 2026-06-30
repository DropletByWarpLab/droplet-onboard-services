/**
 * feat/scene-schedules + KAN-6 — render a stored RRULE back to local copy.
 *
 * KAN-6: the rrule's BYHOUR/BYMINUTE are the WALL-CLOCK time in the row's
 * stored IANA timezone (no UTC conversion). describeRrule reads that
 * wall-clock directly, so the round-trip with buildSceneRrule is exact and
 * timezone-independent — the owner always sees the local time they typed,
 * under any runner TZ.
 */
import { describe, it, expect } from "vitest";
import { describeRrule } from "../../lib/rrule-describe";
import { buildSceneRrule, type DayCode } from "../../lib/scene-rrule";

describe("describeRrule renders the stored wall-clock + zone", () => {
  it("daily reads back as the stored local time", () => {
    expect(describeRrule("FREQ=DAILY;BYHOUR=7;BYMINUTE=0")).toBe(
      "Every day at 7:00 AM",
    );
  });

  it("a single late-evening day stays that day (no UTC-boundary shift anymore)", () => {
    // Pre-KAN-6 an 11pm rule could have a UTC weekday and needed shifting
    // back. Now BYHOUR=23 IS the local hour, so Monday stays Monday.
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=23;BYMINUTE=0")).toBe(
      "Mon at 11:00 PM",
    );
  });

  it("recognises the weekdays bundle", () => {
    expect(
      describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0"),
    ).toBe("Weekdays at 8:00 AM");
  });

  it("recognises the weekend bundle", () => {
    expect(describeRrule("FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=9;BYMINUTE=30")).toBe(
      "Weekends at 9:30 AM",
    );
  });

  it("preserves a multi-day set + the stored local time", () => {
    expect(
      describeRrule("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=30"),
    ).toBe("Mon, Wed, Fri at 6:30 PM");
  });

  it("throws on an unsupported FREQ so the UI can show a neutral label", () => {
    expect(() => describeRrule("FREQ=MONTHLY;BYHOUR=7")).toThrow();
  });
});

describe("describeRrule round-trips a built rule back to the local summary", () => {
  const roundTrip = (days: DayCode[], hour: number, minute: number) =>
    describeRrule(buildSceneRrule({ days, hour, minute })!.rrule);

  it("daily", () => {
    expect(roundTrip([], 7, 0)).toBe("Every day at 7:00 AM");
  });

  it("a single day at a late local time", () => {
    expect(roundTrip(["MO"], 23, 0)).toBe("Mon at 11:00 PM");
  });

  it("the weekdays bundle", () => {
    expect(roundTrip(["MO", "TU", "WE", "TH", "FR"], 8, 0)).toBe(
      "Weekdays at 8:00 AM",
    );
  });

  it("a multi-day set", () => {
    expect(roundTrip(["MO", "WE", "FR"], 18, 30)).toBe(
      "Mon, Wed, Fri at 6:30 PM",
    );
  });
});

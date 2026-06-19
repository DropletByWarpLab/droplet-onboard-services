/**
 * feat/scene-schedules — render a stored UTC RRULE back to local copy, and
 * round-trip it against the build step so the list shows the owner the same
 * wall-clock time they typed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { describeRrule } from "../../lib/rrule-describe";
import { buildSceneRrule, type DayCode } from "../../lib/scene-rrule";

describe("describeRrule — fixed TZ America/Los_Angeles (UTC-7 in June)", () => {
  const orig = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    process.env.TZ = orig;
  });
  const now = new Date(2026, 5, 15, 12, 0, 0);

  it("daily 14:00 UTC reads back as 7:00 AM local", () => {
    expect(describeRrule("FREQ=DAILY;BYHOUR=14;BYMINUTE=0", now)).toBe(
      "Every day at 7:00 AM",
    );
  });

  it("weekly TU 06:00 UTC reads back shifted to Monday 11:00 PM local", () => {
    // 06:00 UTC Tuesday = 23:00 PDT Monday.
    expect(describeRrule("FREQ=WEEKLY;BYDAY=TU;BYHOUR=6;BYMINUTE=0", now)).toBe(
      "Mon at 11:00 PM",
    );
  });

  it("recognises the weekdays bundle", () => {
    // 15:00 UTC = 08:00 PDT, same day → MO-FR stays MO-FR.
    expect(
      describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=15;BYMINUTE=0", now),
    ).toBe("Weekdays at 8:00 AM");
  });

  it("throws on an unsupported FREQ so the UI can show a neutral label", () => {
    expect(() => describeRrule("FREQ=MONTHLY;BYHOUR=7", now)).toThrow();
  });

  it("round-trips a built rule back to the original local summary", () => {
    const days: DayCode[] = ["MO", "WE", "FR"];
    const built = buildSceneRrule({ days, hour: 18, minute: 30 }, now)!;
    // 18:30 PDT = 01:30 UTC next day → built shifts MO/WE/FR to TU/TH/SA;
    // describe must shift them back so the owner sees their original days.
    expect(describeRrule(built.rrule, now)).toBe("Mon, Wed, Fri at 6:30 PM");
  });
});

/**
 * WARP-3372 — the date-only contract of the PM API, pinned to two process time
 * zones.
 *
 * The functions read no local-time getter, so the answer must be the same under
 * America/Los_Angeles (west of UTC, where `new Date("2026-06-25")` is the 24th
 * on the wall) and Pacific/Auckland (east of UTC). Each case runs under both:
 * a regression that reaches for `getDate()` fails in one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dateToDateOnly, isDateOnly, parseDateInput, todayDateOnly } from "./pm-dates.js";

const ZONES = ["America/Los_Angeles", "Pacific/Auckland"] as const;
const ORIGINAL_TZ = process.env.TZ;

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each(ZONES)("date-only helpers under TZ=%s", (zone) => {
  beforeAll(() => {
    process.env.TZ = zone;
    // Fail loudly if the runtime ignored the change: a pass in the wrong zone
    // proves nothing. In June, LA is UTC-7 and Auckland is UTC+12.
    const offset = new Date(2026, 5, 25).getTimezoneOffset();
    expect(offset).toBe(zone === "America/Los_Angeles" ? 420 : -720);
  });

  it("the local wall day of the stored instant differs from the date in one of the zones — the bug this removes", () => {
    const stored = new Date("2026-06-25T00:00:00.000Z");
    // West of UTC the local day is the 24th: the old display read this getter.
    expect(stored.getDate()).toBe(zone === "America/Los_Angeles" ? 24 : 25);
    // The date is the same everywhere.
    expect(dateToDateOnly(stored)).toBe("2026-06-25");
  });

  it("parses YYYY-MM-DD to that day at 00:00:00.000Z, in any zone", () => {
    const d = parseDateInput("2026-06-25");
    expect(d?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    expect(parseDateInput("2026-01-01")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(parseDateInput("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("round-trips: what was entered is what comes back", () => {
    for (const day of ["2026-06-25", "2026-03-08", "2026-11-01", "2026-12-31", "2027-01-01", "2026-09-27"]) {
      expect(dateToDateOnly(parseDateInput(day)!)).toBe(day);
    }
  });

  it("a legacy client's `Z` instant keeps the UTC calendar date it names", () => {
    expect(parseDateInput("2026-06-25T00:00:00.000Z")?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    expect(parseDateInput("2026-06-25T00:00:00Z")?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    expect(parseDateInput("2026-06-25T17:30:00.123Z")?.toISOString()).toBe("2026-06-25T00:00:00.000Z");
    expect(parseDateInput("2026-06-25T23:59")).toBeNull(); // no zone: not an instant
  });

  it("todayDateOnly is the UTC date of `now`, whatever the process zone", () => {
    // 20:00 on the 24th in Los Angeles is already the 25th UTC.
    expect(todayDateOnly(new Date("2026-06-25T03:00:00.000Z"))).toBe("2026-06-25");
    expect(todayDateOnly(new Date("2026-06-24T23:59:59.999Z"))).toBe("2026-06-24");
  });

  it("is date-only: no stored value ever comes back as an instant", () => {
    expect(dateToDateOnly(new Date("2026-06-25T00:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("what is not a date", () => {
  it.each([
    "",
    "2026-6-25",
    "2026-06-25 ",
    "25/06/2026",
    "June 25",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2027-02-29",
    "2026-06-25T00:00:00+02:00",
    "2026-06-25T00:00:00",
    "2026-06-25T25:00:00Z",
    "not a date",
    "20260625",
  ])("rejects %j", (input) => {
    expect(parseDateInput(input)).toBeNull();
  });

  it("isDateOnly agrees: real calendar dates only", () => {
    expect(isDateOnly("2026-06-25")).toBe(true);
    expect(isDateOnly("2028-02-29")).toBe(true);
    expect(isDateOnly("2027-02-29")).toBe(false);
    expect(isDateOnly("2026-06-25T00:00:00.000Z")).toBe(false);
  });
});

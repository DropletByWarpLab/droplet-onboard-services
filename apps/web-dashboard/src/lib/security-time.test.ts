/**
 * WARP-2977 P2b — Security times are SITE times, never the browser's.
 *
 * Every instant below is formatted in an explicit zone and must not move when
 * the test process's own zone does (the jsdom lane runs in whatever TZ the
 * machine has). DST edges and a :45 offset keep an accidental getHours() /
 * local-time shortcut from passing.
 */
import { describe, it, expect } from "vitest";
import {
  deviceTimeZone,
  formatSiteTime,
  formatSiteWhen,
  formatWallTime,
  hhmmToMinutes,
  minutesToHhmm,
  siteDateOf,
} from "@/lib/security-time";

describe("minutes ↔ HH:MM", () => {
  it("round-trips every minute of the day", () => {
    for (let m = 0; m < 1440; m++) expect(hhmmToMinutes(minutesToHhmm(m))).toBe(m);
  });

  it("pads and parses the edges", () => {
    expect(minutesToHhmm(0)).toBe("00:00");
    expect(minutesToHhmm(540)).toBe("09:00");
    expect(minutesToHhmm(1439)).toBe("23:59");
    expect(hhmmToMinutes("18:30")).toBe(1110);
  });

  it.each(["24:00", "9:00", "09:60", "", "0900", "09:00:00", "ab:cd", " 09:00"])("rejects %j", (s) => {
    expect(hhmmToMinutes(s)).toBeNull();
  });

  it.each([-1, 1440, 1.5, Number.NaN])("minutesToHhmm refuses %s (a caller bug)", (m) => {
    expect(() => minutesToHhmm(m)).toThrow(RangeError);
  });

  it("formats a wall time for display", () => {
    expect(formatWallTime("00:00")).toBe("12:00 AM");
    expect(formatWallTime("09:05")).toBe("9:05 AM");
    expect(formatWallTime("12:00")).toBe("12:00 PM");
    expect(formatWallTime("18:00")).toBe("6:00 PM");
  });
});

describe("formatSiteTime — the site zone, not the browser's", () => {
  const at = "2026-09-24T17:00:00.000Z";

  it("the same instant reads differently per site", () => {
    expect(formatSiteTime(at, "Europe/London")).toBe("6:00 PM");
    expect(formatSiteTime(at, "America/New_York")).toBe("1:00 PM");
    expect(formatSiteTime(at, "Asia/Kathmandu")).toBe("10:45 PM");
  });

  it("uses a plain space before AM/PM (no U+202F)", () => {
    expect(formatSiteTime(at, "Europe/London")).not.toMatch(/[  ]/);
  });

  it("follows DST: New York spring-forward and fall-back", () => {
    // 2026-03-08 07:30Z is 03:30 EDT (02:30 does not exist that night).
    expect(formatSiteTime("2026-03-08T07:30:00Z", "America/New_York")).toBe("3:30 AM");
    // 2026-11-01 05:30Z and 06:30Z are both 01:30 — first EDT, then EST.
    expect(formatSiteTime("2026-11-01T05:30:00Z", "America/New_York")).toBe("1:30 AM");
    expect(formatSiteTime("2026-11-01T06:30:00Z", "America/New_York")).toBe("1:30 AM");
  });
});

describe("siteDateOf", () => {
  it("is the site-local calendar date, which may differ from UTC's", () => {
    expect(siteDateOf("2026-09-24T23:30:00Z", "Europe/Berlin")).toBe("2026-09-25");
    expect(siteDateOf("2026-09-24T02:00:00Z", "America/Los_Angeles")).toBe("2026-09-23");
    expect(siteDateOf(new Date("2026-09-24T12:00:00Z"), "UTC")).toBe("2026-09-24");
  });
});

describe("formatSiteWhen — the mode card's phrasing", () => {
  const tz = "Europe/London";
  // Thu 2026-09-24 17:32 BST.
  const now = new Date("2026-09-24T16:32:00Z");

  it("same site day → just the time", () => {
    expect(formatSiteWhen("2026-09-24T17:00:00Z", tz, now)).toBe("6:00 PM");
  });

  it("the next site day → '… tomorrow'", () => {
    expect(formatSiteWhen("2026-09-25T08:00:00Z", tz, now)).toBe("9:00 AM tomorrow");
  });

  it("within a week either way → the weekday", () => {
    expect(formatSiteWhen("2026-09-18T17:02:00Z", tz, now)).toBe("Fri 6:02 PM");
    expect(formatSiteWhen("2026-09-28T08:00:00Z", tz, now)).toBe("Mon 9:00 AM");
  });

  it("further out → month and day", () => {
    expect(formatSiteWhen("2026-10-06T08:00:00Z", tz, now)).toBe("Oct 6, 9:00 AM");
  });

  it("'tomorrow' is decided in the SITE zone: 23:30 UTC is already tomorrow in Berlin", () => {
    const berlinNow = new Date("2026-09-24T10:00:00Z");
    expect(formatSiteWhen("2026-09-24T23:30:00Z", "Europe/Berlin", berlinNow)).toBe("1:30 AM tomorrow");
    expect(formatSiteWhen("2026-09-24T23:30:00Z", "UTC", berlinNow)).toBe("11:30 PM");
  });
});

describe("deviceTimeZone", () => {
  it("returns an IANA zone string (only ever a suggestion)", () => {
    const tz = deviceTimeZone();
    expect(typeof tz === "string" && tz.length > 0).toBe(true);
  });
});

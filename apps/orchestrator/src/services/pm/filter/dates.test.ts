/**
 * WARP-3522 — how a date token in a filter becomes a range of instants.
 *
 * Two storage kinds, deliberately different:
 *   - `date`      (dueDate, startDate): a CALENDAR date stored at 00:00:00Z, so
 *                 a day is [D 00:00Z, D+1 00:00Z) whatever zone the viewer is in.
 *   - `timestamp` (createdAt, updatedAt): a real instant, so a day is the
 *                 viewer's LOCAL day — which is 23, 24 or 25 hours long.
 * The viewer's zone decides what `today` IS in both. Nothing here reads the
 * process zone: the suite runs under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles
 * in CI for exactly that reason.
 */
import { describe, it, expect } from "vitest";
import { dayEnd, dayStart, resolveDateToken, todayIn } from "./dates.js";
import { localPartsOf } from "../../../lib/zoned-time.js";

const iso = (d: Date) => d.toISOString();

describe("todayIn", () => {
  it("is the calendar date at that instant in the zone", () => {
    expect(todayIn(new Date("2026-10-03T12:00:00Z"), "UTC")).toBe("2026-10-03");
    // 03:00Z on the 4th is still the evening of the 3rd in Los Angeles (PDT)…
    expect(todayIn(new Date("2026-10-04T03:00:00Z"), "America/Los_Angeles")).toBe("2026-10-03");
    // …and already the 4th in Auckland (NZDT, UTC+13).
    expect(todayIn(new Date("2026-10-03T12:00:00Z"), "Pacific/Auckland")).toBe("2026-10-04");
    expect(todayIn(new Date("2026-10-03T12:00:00Z"), "Pacific/Kiritimati")).toBe("2026-10-04");
    expect(todayIn(new Date("2026-10-03T12:00:00Z"), "Pacific/Pago_Pago")).toBe("2026-10-03");
  });

  it("refuses a zone the runtime cannot resolve instead of guessing UTC", () => {
    expect(() => todayIn(new Date(), "Mars/Olympus")).toThrow(RangeError);
  });
});

describe("resolveDateToken", () => {
  it("passes an absolute date through", () => {
    expect(resolveDateToken("2026-10-03", "2030-01-01")).toBe("2026-10-03");
  });

  it("resolves named days and offsets from today", () => {
    expect(resolveDateToken("today", "2026-10-03")).toBe("2026-10-03");
    expect(resolveDateToken("yesterday", "2026-10-03")).toBe("2026-10-02");
    expect(resolveDateToken("tomorrow", "2026-10-03")).toBe("2026-10-04");
    expect(resolveDateToken("-7d", "2026-10-03")).toBe("2026-09-26");
    expect(resolveDateToken("+14d", "2026-10-03")).toBe("2026-10-17");
    expect(resolveDateToken("-2w", "2026-10-03")).toBe("2026-09-19");
  });

  it("does calendar arithmetic, not 24-hour arithmetic", () => {
    expect(resolveDateToken("-1d", "2024-03-01")).toBe("2024-02-29"); // leap day
    expect(resolveDateToken("-1d", "2025-03-01")).toBe("2025-02-28");
    expect(resolveDateToken("+1d", "2026-12-31")).toBe("2027-01-01");
    expect(resolveDateToken("-3650d", "2026-10-03")).toBe("2016-10-05");
  });
});

describe("dayStart / dayEnd — a date column (stored as a calendar date at 00:00Z)", () => {
  it("is the UTC day, whatever the viewer's zone", () => {
    for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Auckland", "Pacific/Kiritimati"]) {
      expect(iso(dayStart("2026-10-03", "date", tz))).toBe("2026-10-03T00:00:00.000Z");
      expect(iso(dayEnd("2026-10-03", "date", tz))).toBe("2026-10-04T00:00:00.000Z");
    }
  });

  it("holds across a year boundary and a leap day", () => {
    expect(iso(dayEnd("2026-12-31", "date", "UTC"))).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(dayEnd("2024-02-28", "date", "UTC"))).toBe("2024-02-29T00:00:00.000Z");
    expect(iso(dayEnd("2024-02-29", "date", "UTC"))).toBe("2024-03-01T00:00:00.000Z");
  });
});

describe("dayStart / dayEnd — a timestamp column (the viewer's local day)", () => {
  it("is midnight to midnight in the zone", () => {
    expect(iso(dayStart("2026-10-03", "timestamp", "UTC"))).toBe("2026-10-03T00:00:00.000Z");
    expect(iso(dayStart("2026-10-03", "timestamp", "America/Los_Angeles"))).toBe("2026-10-03T07:00:00.000Z");
    expect(iso(dayEnd("2026-10-03", "timestamp", "America/Los_Angeles"))).toBe("2026-10-04T07:00:00.000Z");
    expect(iso(dayStart("2026-10-03", "timestamp", "Pacific/Auckland"))).toBe("2026-10-02T11:00:00.000Z");
    expect(iso(dayStart("2026-10-03", "timestamp", "Asia/Kolkata"))).toBe("2026-10-02T18:30:00.000Z");
  });

  it("is 23 hours on a spring-forward day and 25 on a fall-back day", () => {
    const hours = (day: string, tz: string) =>
      (dayEnd(day, "timestamp", tz).getTime() - dayStart(day, "timestamp", tz).getTime()) / 3_600_000;
    expect(hours("2026-03-08", "America/Los_Angeles")).toBe(23);
    expect(hours("2026-11-01", "America/Los_Angeles")).toBe(25);
    expect(hours("2026-03-29", "Europe/London")).toBe(23);
    expect(hours("2026-10-25", "Europe/London")).toBe(25);
    // Southern hemisphere, and a 30-minute DST step.
    expect(hours("2026-04-05", "Pacific/Auckland")).toBe(25);
    expect(hours("2026-10-04", "Australia/Lord_Howe")).toBe(23.5);
    expect(hours("2026-06-15", "UTC")).toBe(24);
  });

  it("starts the day at the first instant that exists when midnight itself is skipped", () => {
    // Chile's clocks went 00:00 -> 01:00 on 2022-09-11: there was no midnight.
    const start = dayStart("2022-09-11", "timestamp", "America/Santiago");
    expect(iso(start)).toBe("2022-09-11T04:00:00.000Z");
    expect(localPartsOf(start, "America/Santiago").ymd).toBe("2022-09-11");
    expect(localPartsOf(new Date(start.getTime() - 1), "America/Santiago").ymd).toBe("2022-09-10");
  });

  it("never lands on the neighbouring local day", () => {
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Havana", "Atlantic/Azores"]) {
      const start = dayStart("2026-06-15", "timestamp", tz);
      expect(localPartsOf(start, tz).ymd).toBe("2026-06-15");
      expect(localPartsOf(new Date(start.getTime() - 1), tz).ymd).toBe("2026-06-14");
    }
  });
});

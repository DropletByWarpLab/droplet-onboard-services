import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { monthGridDays, monthGridRange, eventsByDay } from "./MonthView";

describe("monthGridDays", () => {
  it("returns 42 days starting on the Sunday on/before the 1st", () => {
    const days = monthGridDays(new Date(2026, 4, 15)); // May 2026
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0); // grid always starts on a Sunday

    const first = new Date(2026, 4, 1);
    expect(days[0].getTime()).toBeLessThanOrEqual(first.getTime());
    expect(first.getTime() - days[0].getTime()).toBeLessThan(7 * 86_400_000);
  });

  it("includes every day of the cursor's month", () => {
    const days = monthGridDays(new Date(2026, 4, 15));
    const keys = new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`));
    expect(keys.has("2026-4-1")).toBe(true); // May 1
    expect(keys.has("2026-4-31")).toBe(true); // May 31
  });

  it("is contiguous (each day is +1 of the previous)", () => {
    const days = monthGridDays(new Date(2026, 1, 10)); // Feb 2026
    for (let i = 1; i < days.length; i++) {
      const diff = (days[i].getTime() - days[i - 1].getTime()) / 86_400_000;
      expect(Math.round(diff)).toBe(1);
    }
  });
});

describe("monthGridRange", () => {
  it("covers the full visible grid and starts on a Sunday", () => {
    const { from, to } = monthGridRange(new Date(2026, 4, 15));
    expect(from.getDay()).toBe(0);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBeGreaterThan(40);
    expect(from.getHours()).toBe(0);
  });
});

describe("eventsByDay", () => {
  // Build event times from LOCAL Date objects so the day-bucketing (which is
  // local-time) is asserted independent of the test runner's timezone.
  const ev = (
    id: string,
    start: Date,
    end: Date,
    source: "local" | "external" = "local",
  ): CalendarEvent =>
    ({
      id,
      title: id,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      allDay: false,
      source,
    }) as CalendarEvent;

  it("places a multi-day event on every day it spans", () => {
    // May 30 10:00 → Jun 1 10:00 local — three distinct local days.
    const m = eventsByDay([ev("trip", new Date(2026, 4, 30, 10), new Date(2026, 5, 1, 10))]);
    expect(m.get("2026-05-30")).toHaveLength(1);
    expect(m.get("2026-05-31")).toHaveLength(1);
    expect(m.get("2026-06-01")).toHaveLength(1);
    expect(m.has("2026-06-02")).toBe(false);
  });

  it("treats an end exactly at local midnight as exclusive", () => {
    // May 31 00:00 → Jun 1 00:00 local is one all-day span, not two.
    const m = eventsByDay([ev("holiday", new Date(2026, 4, 31, 0, 0), new Date(2026, 5, 1, 0, 0))]);
    expect(m.get("2026-05-31")).toHaveLength(1);
    expect(m.has("2026-06-01")).toBe(false);
  });

  it("buckets a single-day event exactly once", () => {
    const m = eventsByDay([ev("lunch", new Date(2026, 4, 15, 12), new Date(2026, 4, 15, 13))]);
    expect([...m.keys()]).toEqual(["2026-05-15"]);
    expect(m.get("2026-05-15")).toHaveLength(1);
  });
});

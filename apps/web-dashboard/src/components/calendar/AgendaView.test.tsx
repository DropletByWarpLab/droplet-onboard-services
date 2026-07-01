import { describe, it, expect, afterEach, vi } from "vitest";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { groupByDay } from "./AgendaView";
import { dayKey } from "@/lib/calendar";

// Build event times from LOCAL Date objects so the day-bucketing (which is
// local-time) is asserted independent of the test runner's timezone — mirrors
// MonthView.test.tsx's convention.
const ev = (
  id: string,
  start: Date,
  end: Date,
  source: "local" | "external" = "local",
  allDay = false,
): CalendarEvent =>
  ({
    id,
    title: id,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    allDay,
    source,
  }) as CalendarEvent;

describe("groupByDay", () => {
  it("populates a group for each day that has events (events render in agenda)", () => {
    const groups = groupByDay([
      ev("a", new Date(2026, 4, 15, 9), new Date(2026, 4, 15, 10)),
      ev("b", new Date(2026, 4, 16, 9), new Date(2026, 4, 16, 10)),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("2026-05-15");
    expect(groups[1].key).toBe("2026-05-16");
    expect(groups.flatMap((g) => g.events.map((e) => e.id))).toEqual(["a", "b"]);
  });

  it("returns groups in chronological order regardless of input order", () => {
    const groups = groupByDay([
      ev("late", new Date(2026, 4, 20, 9), new Date(2026, 4, 20, 10)),
      ev("early", new Date(2026, 4, 10, 9), new Date(2026, 4, 10, 10)),
      ev("mid", new Date(2026, 4, 15, 9), new Date(2026, 4, 15, 10)),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["2026-05-10", "2026-05-15", "2026-05-20"]);
  });

  it("orders events within a day by start time (all-day first)", () => {
    const groups = groupByDay([
      ev("afternoon", new Date(2026, 4, 15, 14), new Date(2026, 4, 15, 15)),
      ev("morning", new Date(2026, 4, 15, 9), new Date(2026, 4, 15, 10)),
      ev("allday", new Date(2026, 4, 15, 0), new Date(2026, 4, 16, 0), "local", true),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].events.map((e) => e.id)).toEqual(["allday", "morning", "afternoon"]);
  });

  it("places a multi-day event on every day it spans", () => {
    // May 30 10:00 -> Jun 1 10:00 local — three distinct local days.
    const groups = groupByDay([ev("trip", new Date(2026, 4, 30, 10), new Date(2026, 5, 1, 10))]);
    expect(groups.map((g) => g.key)).toEqual(["2026-05-30", "2026-05-31", "2026-06-01"]);
    for (const g of groups) expect(g.events.map((e) => e.id)).toEqual(["trip"]);
  });

  it("labels today and tomorrow distinctly", () => {
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const groups = groupByDay([
      ev("t", new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9), new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10)),
      ev("tm", new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9), new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10)),
    ]);
    expect(groups[0].label).toMatch(/^Today · /);
    expect(groups[1].label).toMatch(/^Tomorrow · /);
  });

  // WARP-944 (pr-reviewer #6): the "Tomorrow" label must be the next CALENDAR
  // day, computed with local date arithmetic — NOT `today.getTime() + 86.4M ms`.
  // On a spring-forward (23-hour) day, adding a fixed 24h of wall-clock skips a
  // calendar date, so the genuine next day fails to get the "Tomorrow" label and
  // a day+2 event gets it instead. Pinning the clock to a DST transition makes
  // the regression deterministic on a DST-observing host; in a no-DST zone
  // (e.g. UTC CI) it still asserts the correct invariant on both paths.
  describe("DST-safe Today/Tomorrow labelling", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("labels the next calendar day 'Tomorrow' across a spring-forward boundary", () => {
      // 2026-03-07 23:30 local — the evening BEFORE US spring-forward (Mar 8,
      // 02:00 -> 03:00). The following calendar day (Mar 8) is only 23 hours
      // long, so the OLD `today.getTime() + 86.4M` overshoots local midnight by
      // an extra hour and lands on Mar 9 (day+2), skipping Mar 8 — the genuine
      // "Tomorrow" — entirely. Calendar-date arithmetic is always exact.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 7, 23, 30, 0));

      const now = new Date();
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const dayAfter = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);

      const groups = groupByDay([
        ev(
          "tomorrow-ev",
          new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 9),
          new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 10),
        ),
        ev(
          "dayafter-ev",
          new Date(dayAfter.getFullYear(), dayAfter.getMonth(), dayAfter.getDate(), 9),
          new Date(dayAfter.getFullYear(), dayAfter.getMonth(), dayAfter.getDate(), 10),
        ),
      ]);

      const byKey = Object.fromEntries(groups.map((g) => [g.key, g.label]));
      // The genuine next calendar day is "Tomorrow"; the day after is never.
      expect(byKey[dayKey(tomorrow)]).toMatch(/^Tomorrow · /);
      expect(byKey[dayKey(dayAfter)]).not.toMatch(/^Tomorrow · /);
    });
  });
});

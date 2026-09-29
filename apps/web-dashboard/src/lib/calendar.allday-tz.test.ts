// WARP-3265 — an all-day event from a subscribed feed, stored as UTC
// midnight, must land on exactly one local day west AND east of UTC.
import { describe, it, expect, afterAll } from "vitest";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { toLocalAllDay, dayKey } from "@/lib/calendar";
import { eventsByDay } from "@/components/calendar/MonthView";

const originalTz = process.env.TZ;
afterAll(() => {
  process.env.TZ = originalTz;
});

const holiday = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  userId: "u",
  title: "Offsite",
  description: null,
  location: null,
  meetingUrl: null,
  startsAt: "2026-09-15T00:00:00.000Z",
  endsAt: "2026-09-16T00:00:00.000Z",
  allDay: true,
  source: "external",
  sourceId: "s1",
  externalUid: "x@y",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...over,
});

describe.each(["America/Los_Angeles", "Europe/Paris"])("toLocalAllDay in %s", (tz) => {
  it("puts a one-day subscribed all-day event on exactly Sep 15", () => {
    process.env.TZ = tz;
    const ev = toLocalAllDay(holiday());
    expect(dayKey(new Date(ev.startsAt))).toBe("2026-09-15");
    expect([...eventsByDay([ev]).keys()]).toEqual(["2026-09-15"]);
  });

  it("prefers the box's startDate/endDate when sent", () => {
    process.env.TZ = tz;
    const ev = toLocalAllDay(holiday({ startDate: "2026-09-15", endDate: "2026-09-17" }));
    expect([...eventsByDay([ev]).keys()]).toEqual(["2026-09-15", "2026-09-16"]);
  });
});

describe("toLocalAllDay leaves other events alone", () => {
  it("reproduces the defect it fixes: the raw row spans two days in Pacific time", () => {
    process.env.TZ = "America/Los_Angeles";
    expect([...eventsByDay([holiday()]).keys()]).toEqual(["2026-09-14", "2026-09-15"]);
  });

  it("does not touch a local all-day event or a timed external one", () => {
    process.env.TZ = "America/Los_Angeles";
    const local = holiday({ source: "local", startsAt: "2026-09-15T07:00:00.000Z", endsAt: "2026-09-16T07:00:00.000Z" });
    expect(toLocalAllDay(local)).toBe(local);
    const timed = holiday({ allDay: false });
    expect(toLocalAllDay(timed)).toBe(timed);
  });
});

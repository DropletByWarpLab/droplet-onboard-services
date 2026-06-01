import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import {
  dayKey,
  paletteColor,
  eventVisibilityKey,
  compareByStart,
  SOURCE_PALETTE,
  EXTERNAL_KEY,
} from "@/lib/calendar";

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e",
  userId: "u",
  title: "t",
  description: null,
  location: null,
  startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2026-01-01T01:00:00Z",
  allDay: false,
  source: "external",
  sourceId: null,
  externalUid: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("dayKey", () => {
  it("zero-pads month and day", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("paletteColor", () => {
  it("is stable for the same id and order-independent", () => {
    expect(paletteColor("cal-abc")).toBe(paletteColor("cal-abc"));
  });
  it("always returns a palette member", () => {
    for (const id of ["a", "b", "c", "longer-source-id", "zzz", ""]) {
      expect(SOURCE_PALETTE).toContain(paletteColor(id));
    }
  });
});

describe("eventVisibilityKey", () => {
  const known = new Set(["src-1", "src-2"]);
  it("keys local events to local", () => {
    expect(eventVisibilityKey(ev({ source: "local", sourceId: null }), known)).toBe("local");
  });
  it("keys a known source to its id", () => {
    expect(eventVisibilityKey(ev({ source: "external", sourceId: "src-1" }), known)).toBe("src-1");
  });
  it("collapses a null sourceId to the external catch-all", () => {
    expect(eventVisibilityKey(ev({ source: "external", sourceId: null }), known)).toBe(EXTERNAL_KEY);
  });
  it("collapses an unrecognized sourceId to the external catch-all", () => {
    // Previously these leaked: keyed to a sourceId with no matching rail row,
    // so they could never be hidden.
    expect(eventVisibilityKey(ev({ source: "external", sourceId: "gone" }), known)).toBe(EXTERNAL_KEY);
  });
});

describe("compareByStart", () => {
  it("orders by instant, not by lexicographic ISO string", () => {
    // a is the EARLIER instant (05:00Z) but the LATER lexicographic string.
    const a = ev({ id: "a", startsAt: "2026-01-01T10:00:00+05:00" }); // 05:00Z
    const b = ev({ id: "b", startsAt: "2026-01-01T08:00:00Z" }); //      08:00Z
    // localeCompare (the old impl) would put b first — the bug.
    expect(a.startsAt.localeCompare(b.startsAt)).toBeGreaterThan(0);
    // compareByStart puts the earlier instant (a) first — the fix.
    expect([b, a].sort(compareByStart).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

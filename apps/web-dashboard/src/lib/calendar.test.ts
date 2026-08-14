import { describe, it, expect } from "vitest";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import {
  dayKey,
  parseDateParam,
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
  meetingUrl: null,
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

// WARP-1131 — `?date=YYYY-MM-DD` deep link from the Home calendar widget.
describe("parseDateParam", () => {
  it("parses a valid YYYY-MM-DD into a local-midnight Date", () => {
    const d = parseDateParam("2026-03-14");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(2);
    expect(d!.getDate()).toBe(14);
    expect(d!.getHours()).toBe(0);
  });

  it("round-trips with dayKey", () => {
    expect(dayKey(parseDateParam("2026-01-05")!)).toBe("2026-01-05");
    expect(dayKey(parseDateParam("2026-12-31")!)).toBe("2026-12-31");
  });

  it("returns null for absent / empty input", () => {
    expect(parseDateParam(null)).toBeNull();
    expect(parseDateParam(undefined)).toBeNull();
    expect(parseDateParam("")).toBeNull();
  });

  it("returns null for malformed shapes", () => {
    expect(parseDateParam("2026-3-14")).toBeNull();
    expect(parseDateParam("14-03-2026")).toBeNull();
    expect(parseDateParam("2026-03-14T09:00:00Z")).toBeNull();
    expect(parseDateParam("not-a-date")).toBeNull();
  });

  it("returns null for well-shaped but non-existent dates (no Date rollover)", () => {
    // new Date(2026, 1, 31) would silently roll into March — reject instead.
    expect(parseDateParam("2026-02-31")).toBeNull();
    expect(parseDateParam("2026-13-01")).toBeNull();
    expect(parseDateParam("2026-00-10")).toBeNull();
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

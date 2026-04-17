import { describe, it, expect } from "vitest";
import { isWindowActive } from "./schedule-window.js";

type Window = { daysOfWeek: number; startMin: number; endMin: number };

// Helpers
const DAY = { Sun: 1, Mon: 2, Tue: 4, Wed: 8, Thu: 16, Fri: 32, Sat: 64 };
const at = (isoLocal: string) => new Date(isoLocal);

describe("isWindowActive", () => {
  it("returns false when day-of-week not in mask", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 9 * 60, endMin: 17 * 60 };
    // Tuesday 10am
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false);
  });

  it("returns true during a single-day window", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9 * 60, endMin: 17 * 60 };
    // Tuesday 2026-04-14 10am local
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(true);
  });

  it("returns false at exact end boundary", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9 * 60, endMin: 17 * 60 };
    expect(isWindowActive(w, at("2026-04-14T17:00:00"))).toBe(false);
  });

  it("returns true at exact start boundary", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9 * 60, endMin: 17 * 60 };
    expect(isWindowActive(w, at("2026-04-14T09:00:00"))).toBe(true);
  });

  it("handles midnight-wrap (9pm-7am): true on the start day after 9pm", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    // Sunday 2026-04-12 22:00 local
    expect(isWindowActive(w, at("2026-04-12T22:00:00"))).toBe(true);
  });

  it("handles midnight-wrap: true on the NEXT day before 7am", () => {
    // Window starts Sunday 21:00, ends Monday 07:00
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    // Monday 2026-04-13 06:00 local
    expect(isWindowActive(w, at("2026-04-13T06:00:00"))).toBe(true);
  });

  it("handles midnight-wrap: false on the next day after wrap-end", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    expect(isWindowActive(w, at("2026-04-13T08:00:00"))).toBe(false);
  });

  it("returns false for an hour before start (not in wrap)", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    expect(isWindowActive(w, at("2026-04-12T20:00:00"))).toBe(false);
  });

  it("multi-day mask matches any listed day", () => {
    const w: Window = { daysOfWeek: DAY.Mon | DAY.Wed | DAY.Fri, startMin: 8 * 60, endMin: 15 * 60 };
    expect(isWindowActive(w, at("2026-04-15T10:00:00"))).toBe(true); // Wed
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false); // Tue
  });
});

describe("isWindowActive edge cases", () => {
  it("endMin=0 (midnight end) on a single day: active until 23:59, false at 00:00 next day", () => {
    // "Mon 22:00-00:00" means active Mon 22:00-23:59. 00:00 Tue is NOT active.
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 22 * 60, endMin: 0 };
    expect(isWindowActive(w, at("2026-04-13T22:30:00"))).toBe(true);   // Mon 22:30
    expect(isWindowActive(w, at("2026-04-13T23:59:00"))).toBe(true);   // Mon 23:59
    expect(isWindowActive(w, at("2026-04-14T00:00:00"))).toBe(false);  // Tue 00:00 — NOT active (wrap requires nowMin < endMin=0 which is impossible)
  });

  it("startMin=0 (midnight start) non-wrap: active from 00:00 inclusive", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 0, endMin: 6 * 60 };
    expect(isWindowActive(w, at("2026-04-13T00:00:00"))).toBe(true);   // Mon midnight exact
    expect(isWindowActive(w, at("2026-04-13T05:59:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-13T06:00:00"))).toBe(false);  // end boundary exclusive
  });

  it("wrap window at exact start minute is active", () => {
    // Sun 21:00-07:00 at exactly Sun 21:00 is active
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    expect(isWindowActive(w, at("2026-04-12T21:00:00"))).toBe(true);
  });
});

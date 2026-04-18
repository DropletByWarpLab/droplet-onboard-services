import { describe, it, expect } from "vitest";
import {
  isWindowActive,
  formatDaysOfWeek,
  formatWindow,
  nextTransitionFor,
} from "./scheduleEval";

type Window = { daysOfWeek: number; startMin: number; endMin: number };

const DAY = { Sun: 1, Mon: 2, Tue: 4, Wed: 8, Thu: 16, Fri: 32, Sat: 64 };
const at = (isoLocal: string) => new Date(isoLocal);

// Mirrors apps/orchestrator/src/lib/schedule-window.test.ts one-to-one.
// If this ever drifts, the client-side "Active now" dot will disagree
// with the server's cron-driven transitions — so keep them aligned.
describe("isWindowActive", () => {
  it("returns false when day-of-week not in mask", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 9 * 60, endMin: 17 * 60 };
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false);
  });

  it("returns true during a single-day window", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9 * 60, endMin: 17 * 60 };
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
    expect(isWindowActive(w, at("2026-04-12T22:00:00"))).toBe(true);
  });

  it("handles midnight-wrap: true on the NEXT day before 7am", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
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
    const w: Window = {
      daysOfWeek: DAY.Mon | DAY.Wed | DAY.Fri,
      startMin: 8 * 60,
      endMin: 15 * 60,
    };
    expect(isWindowActive(w, at("2026-04-15T10:00:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-14T10:00:00"))).toBe(false);
  });
});

describe("isWindowActive edge cases", () => {
  it("endMin=0 (midnight end) on a single day: active until 23:59, false at 00:00 next day", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 22 * 60, endMin: 0 };
    expect(isWindowActive(w, at("2026-04-13T22:30:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-13T23:59:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-14T00:00:00"))).toBe(false);
  });

  it("startMin=0 (midnight start) non-wrap: active from 00:00 inclusive", () => {
    const w: Window = { daysOfWeek: DAY.Mon, startMin: 0, endMin: 6 * 60 };
    expect(isWindowActive(w, at("2026-04-13T00:00:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-13T05:59:00"))).toBe(true);
    expect(isWindowActive(w, at("2026-04-13T06:00:00"))).toBe(false);
  });

  it("wrap window at exact start minute is active", () => {
    const w: Window = { daysOfWeek: DAY.Sun, startMin: 21 * 60, endMin: 7 * 60 };
    expect(isWindowActive(w, at("2026-04-12T21:00:00"))).toBe(true);
  });
});

describe("formatDaysOfWeek", () => {
  it("renders a contiguous Sun-Thu range", () => {
    // Sun(1) | Mon(2) | Tue(4) | Wed(8) | Thu(16) = 31
    expect(formatDaysOfWeek(31)).toBe("Sun-Thu");
  });

  it("renders all 7 days as 'Every day'", () => {
    expect(formatDaysOfWeek(127)).toBe("Every day");
  });

  it("renders non-contiguous days as comma list", () => {
    // Mon, Wed, Fri = 2 | 8 | 32 = 42
    expect(formatDaysOfWeek(42)).toBe("Mon,Wed,Fri");
  });

  it("renders a single day", () => {
    expect(formatDaysOfWeek(DAY.Tue)).toBe("Tue");
  });
});

describe("formatWindow", () => {
  it("formats Sun-Thu 21:00-07:00 bedtime window", () => {
    const w: Window = { daysOfWeek: 31, startMin: 21 * 60, endMin: 7 * 60 };
    expect(formatWindow(w)).toBe("Sun-Thu 21:00-07:00");
  });

  it("formats single Tue 09:00-17:00 window", () => {
    const w: Window = { daysOfWeek: DAY.Tue, startMin: 9 * 60, endMin: 17 * 60 };
    expect(formatWindow(w)).toBe("Tue 09:00-17:00");
  });
});

describe("nextTransitionFor", () => {
  // Bedtime: Sun-Thu 21:00-07:00 (midnight-wrap window).
  const bedtime = {
    windows: [
      {
        daysOfWeek: DAY.Sun | DAY.Mon | DAY.Tue | DAY.Wed | DAY.Thu,
        startMin: 21 * 60,
        endMin: 7 * 60,
      },
    ],
  };

  it("returns null when no schedules provided", () => {
    expect(nextTransitionFor([], at("2026-04-14T10:00:00"))).toBeNull();
  });

  it("at Tue 10:00 with Bedtime → next transition Tue 21:00, isBlocked=true", () => {
    const result = nextTransitionFor([bedtime], at("2026-04-14T10:00:00"));
    expect(result).not.toBeNull();
    expect(result!.isBlocked).toBe(true);
    // Tue 2026-04-14 21:00 local time.
    expect(result!.at.getTime()).toBe(at("2026-04-14T21:00:00").getTime());
  });

  it("at Tue 22:00 (inside Bedtime) → next transition Wed 07:00, isBlocked=false", () => {
    const result = nextTransitionFor([bedtime], at("2026-04-14T22:00:00"));
    expect(result).not.toBeNull();
    expect(result!.isBlocked).toBe(false);
    // Wed 2026-04-15 07:00 local time.
    expect(result!.at.getTime()).toBe(at("2026-04-15T07:00:00").getTime());
  });
});

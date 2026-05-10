/**
 * WARP-279 — relativeTime helper tests. Pure function, exhaustively
 * easy to test.
 */

import { describe, it, expect } from "vitest";
import { relativeTime } from "../time";

const NOW = new Date("2026-05-10T18:00:00Z");

describe("relativeTime", () => {
  it("returns em dash on null/undefined/invalid", () => {
    expect(relativeTime(null, NOW)).toBe("—");
    expect(relativeTime(undefined, NOW)).toBe("—");
    expect(relativeTime("not-a-date", NOW)).toBe("—");
  });

  it("renders sub-minute as 'just now'", () => {
    expect(relativeTime("2026-05-10T17:59:30Z", NOW)).toBe("just now");
  });

  it("renders minutes / hours / days", () => {
    expect(relativeTime("2026-05-10T17:55:00Z", NOW)).toBe("5m ago");
    expect(relativeTime("2026-05-10T15:00:00Z", NOW)).toBe("3h ago");
    expect(relativeTime("2026-05-08T18:00:00Z", NOW)).toBe("2d ago");
  });

  it("renders an absolute date past 7 days", () => {
    const got = relativeTime("2026-04-01T18:00:00Z", NOW);
    expect(got).toMatch(/Apr/);
    expect(got).toMatch(/2026/);
  });

  it("handles future timestamps as 'in N'", () => {
    expect(relativeTime("2026-05-10T18:01:00Z", NOW)).toBe("in 1m");
    expect(relativeTime("2026-05-10T19:00:00Z", NOW)).toBe("in 1h");
  });
});

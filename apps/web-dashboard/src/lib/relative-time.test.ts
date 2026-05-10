/**
 * WARP-225 — formatRelativeTime helper.
 *
 * Anchors `now` explicitly so the test is deterministic. Locale-date
 * fallback is asserted only on prefix match because the host's locale
 * affects the exact rendering.
 */

import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./relative-time";

const now = new Date("2026-05-09T12:00:00Z");

describe("formatRelativeTime", () => {
  it.each([
    [0, "just now"],
    [10_000, "just now"],
    [29_000, "just now"],
    [60_000, "1 minute ago"],
    [89_000, "1 minute ago"],
    [120_000, "2 minutes ago"],
    [3 * 60_000, "3 minutes ago"],
    [60 * 60_000, "1 hour ago"],
    [3 * 60 * 60_000, "3 hours ago"],
    [24 * 60 * 60_000, "yesterday"],
    [3 * 24 * 60 * 60_000, "3 days ago"],
  ])("renders %i ms ago as %s", (ms, expected) => {
    const ts = new Date(now.getTime() - ms);
    expect(formatRelativeTime(ts, now)).toBe(expected);
  });

  it("falls back to a locale date for anything > 7 days", () => {
    const old = new Date("2026-04-01T12:00:00Z");
    const out = formatRelativeTime(old, now);
    // Locale-dependent: just check it's not the relative form.
    expect(out).not.toMatch(/ago$/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("handles future timestamps with 'just now' (clock skew tolerance)", () => {
    const future = new Date(now.getTime() + 5_000);
    expect(formatRelativeTime(future, now)).toBe("just now");
  });

  it("returns 'unknown' for invalid input", () => {
    expect(formatRelativeTime("not-a-date", now)).toBe("unknown");
  });

  it("accepts ISO strings as well as Date objects", () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe("5 minutes ago");
  });

  it("accepts ms-epoch numbers", () => {
    const ms = now.getTime() - 5 * 60_000;
    expect(formatRelativeTime(ms, now)).toBe("5 minutes ago");
  });
});

/**
 * WARP-3537 — the window arithmetic behind "the table renders 1,000 rows smoothly".
 * Only the rows near the viewport are drawn; these are the numbers that decide
 * which. Pure, because a layout engine is exactly what jsdom does not have.
 */
import { describe, it, expect } from "vitest";
import { layoutRows, scrollTopFor, visibleRange } from "./virtual";

const same = (n: number, h: number) => Array.from({ length: n }, () => h);

describe("layoutRows", () => {
  it("is the running total of the heights, with the whole height at the end", () => {
    const { offsets, total } = layoutRows([44, 36, 44]);
    expect(offsets).toEqual([0, 44, 80, 124]);
    expect(total).toBe(124);
  });

  it("is empty for no rows", () => {
    expect(layoutRows([])).toEqual({ offsets: [0], total: 0 });
  });
});

describe("visibleRange", () => {
  const { offsets } = layoutRows(same(1000, 44));

  it("covers the viewport plus the overscan, from the top", () => {
    // 440px is exactly ten rows; two more are drawn below as overscan.
    expect(visibleRange(offsets, 0, 440, 2)).toEqual({ start: 0, end: 12 });
  });

  it("moves with the scroll position, and never draws fewer than the viewport needs", () => {
    const r = visibleRange(offsets, 4400, 440, 2);
    expect(r.start).toBe(98);
    expect(r.end).toBe(112);
  });

  it("stops at the last row", () => {
    // The furthest a scroller can go is its content minus one viewport.
    const r = visibleRange(offsets, 1000 * 44 - 440, 440, 3);
    expect(r.end).toBe(1000);
    expect(r.start).toBeLessThanOrEqual(1000 - 10);
  });

  it("draws a bounded number of rows however many there are — the point of all this", () => {
    const big = layoutRows(same(50_000, 44)).offsets;
    const r = visibleRange(big, 123_456, 600, 6);
    expect(r.end - r.start).toBeLessThan(40);
  });

  it("copes with rows of different heights (a group header is shorter than a row)", () => {
    const { offsets: mixed } = layoutRows([36, 44, 44, 36, 44, 44, 44]);
    // top of row 3 is 36+44+44 = 124; a viewport starting at 130 is inside row 3.
    const r = visibleRange(mixed, 130, 60, 0);
    expect(r.start).toBe(3);
    expect(r.end).toBe(5);
  });

  it("is empty for no rows", () => {
    expect(visibleRange([0], 0, 500, 4)).toEqual({ start: 0, end: 0 });
  });
});

describe("scrollTopFor (keep the row in view when the keyboard moves to it)", () => {
  const { offsets } = layoutRows(same(100, 44));
  const HEADER = 36;

  it("does not move when the row is already visible", () => {
    expect(scrollTopFor(offsets, 3, 0, 440, HEADER)).toBe(0);
  });

  it("scrolls down just enough to bring a row below the fold to the bottom edge", () => {
    // row 20 spans 880..924; a 440px viewport at scrollTop 0 shows up to 440.
    expect(scrollTopFor(offsets, 20, 0, 440, HEADER)).toBe(924 - 440);
  });

  it("scrolls up so the row clears the sticky header, not hides under it", () => {
    // row 5 starts at 220; with scrollTop 300 it is above the viewport.
    expect(scrollTopFor(offsets, 5, 300, 440, HEADER)).toBe(220 - HEADER);
  });

  it("never scrolls above the top", () => {
    expect(scrollTopFor(offsets, 0, 100, 440, HEADER)).toBe(0);
  });
});

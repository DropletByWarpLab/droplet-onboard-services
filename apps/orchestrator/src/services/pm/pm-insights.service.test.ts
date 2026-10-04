import { describe, it, expect } from "vitest";
import {
  bucketStart,
  resolveInsightsRange,
  INSIGHTS_ERRORS,
  INSIGHTS_MAX_DAYS,
} from "./pm-insights.service.js";

// 2026-10-04 is a Sunday; 2026-09-07 is the Monday four weeks before it.
const TODAY = "2026-10-04";

describe("bucketStart (WARP-3524)", () => {
  it("day is the day itself", () => {
    expect(bucketStart("2026-09-10", "day")).toBe("2026-09-10");
  });

  it("week starts on Monday, and a Monday is its own start", () => {
    expect(bucketStart("2026-09-10", "week")).toBe("2026-09-07"); // Thursday
    expect(bucketStart("2026-09-28", "week")).toBe("2026-09-28"); // Monday
    expect(bucketStart("2026-10-04", "week")).toBe("2026-09-28"); // Sunday belongs to the week BEFORE
  });

  it("week start crosses a month and a year", () => {
    expect(bucketStart("2026-01-01", "week")).toBe("2025-12-29"); // Thursday
  });

  it("month is the first of the month", () => {
    expect(bucketStart("2026-09-30", "month")).toBe("2026-09-01");
  });
});

describe("resolveInsightsRange (WARP-3524)", () => {
  it("defaults to twelve weeks ending today", () => {
    expect(resolveInsightsRange({ groupBy: "day" }, TODAY)).toEqual({
      from: "2026-07-13", // 84 days, today included
      to: TODAY,
    });
  });

  it("moves `from` back to the start of its bucket and leaves `to` alone", () => {
    expect(resolveInsightsRange({ from: "2026-09-10", to: "2026-09-20", groupBy: "week" }, TODAY)).toEqual({
      from: "2026-09-07",
      to: "2026-09-20",
    });
    expect(resolveInsightsRange({ from: "2026-09-10", to: "2026-09-20", groupBy: "month" }, TODAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-20",
    });
    expect(resolveInsightsRange({ from: "2026-09-10", to: "2026-09-20", groupBy: "day" }, TODAY)).toEqual({
      from: "2026-09-10",
      to: "2026-09-20",
    });
  });

  it("clamps a `to` in the future to today", () => {
    expect(resolveInsightsRange({ from: "2026-09-07", to: "2026-12-31", groupBy: "week" }, TODAY).to).toBe(TODAY);
  });

  it("measures back from an explicit `to` when `from` is omitted", () => {
    expect(resolveInsightsRange({ to: "2026-09-30", groupBy: "day" }, TODAY)).toEqual({
      from: "2026-07-09",
      to: "2026-09-30",
    });
  });

  it("refuses a `from` after `to`, including a range that starts in the future", () => {
    expect(() => resolveInsightsRange({ from: "2026-09-20", to: "2026-09-10", groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
    expect(() => resolveInsightsRange({ from: "2026-11-01", groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
  });

  it("allows exactly a year and refuses a day more", () => {
    const to = "2026-10-04";
    // 366 days inclusive: 2025-10-04 .. 2026-10-04.
    expect(resolveInsightsRange({ from: "2025-10-04", to, groupBy: "day" }, TODAY).from).toBe("2025-10-04");
    expect(INSIGHTS_MAX_DAYS).toBe(366);
    expect(() => resolveInsightsRange({ from: "2025-10-03", to, groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
  });

  it("refuses a date that is not on the calendar", () => {
    expect(() => resolveInsightsRange({ from: "2026-02-30", groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
  });
});

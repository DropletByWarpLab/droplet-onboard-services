import { describe, it, expect, vi } from "vitest";
import {
  bucketStart,
  resolveInsightsRange,
  resolveInsightsZone,
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

  it("refuses years Date.UTC would remap into 1900–1999", () => {
    expect(() => resolveInsightsRange({ from: "0001-01-01", groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
    expect(() => resolveInsightsRange({ from: "0099-12-31", groupBy: "day" }, TODAY)).toThrow(
      INSIGHTS_ERRORS.INVALID_RANGE,
    );
  });
});

describe("resolveInsightsZone (WARP-3524)", () => {
  // 05:00Z on 4 October is still the evening of the 3rd in Los Angeles (PDT, UTC-7).
  const NOW = new Date("2026-10-04T05:00:00.000Z");
  const prismaWhere = (probe: () => Promise<unknown>) => ({ $queryRaw: vi.fn(probe) }) as never;

  it("uses the zone it is given, and that zone's own calendar day, when Postgres knows it", async () => {
    const prisma = prismaWhere(async () => [{}]);
    expect(await resolveInsightsZone(prisma, NOW, "America/Los_Angeles")).toEqual({
      zone: "America/Los_Angeles",
      today: "2026-10-03",
    });
  });

  it("falls back to UTC, and UTC's day, when Postgres does not recognise the zone", async () => {
    // Node and Postgres ship their own time zone tables, and Workspace.tz is stored unchecked.
    const prisma = prismaWhere(async () => {
      throw Object.assign(new Error('Raw query failed. Code: `22023`. Message: `time zone "America/Coyhaique" not recognized`'), {
        code: "P2010",
        meta: { code: "22023" },
      });
    });
    expect(await resolveInsightsZone(prisma, NOW, "America/Los_Angeles")).toEqual({
      zone: "UTC",
      today: "2026-10-04",
    });
  });

  it("does not ask Postgres about UTC", async () => {
    const prisma = prismaWhere(async () => {
      throw new Error("must not be called");
    });
    expect(await resolveInsightsZone(prisma, NOW, "UTC")).toEqual({ zone: "UTC", today: "2026-10-04" });
  });

  it("does not pass offset strings through ICU/Postgres with different meanings", async () => {
    const prisma = prismaWhere(async () => [{}]);
    const result = await resolveInsightsZone(prisma, NOW, "+05:30");
    expect(result.zone).not.toBe("+05:30");
    expect(result.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("only falls back when Postgres rejects the time zone itself", async () => {
    const transient = prismaWhere(async () => {
      throw Object.assign(new Error("pool timeout"), { code: "P2010", meta: { code: "57014" } });
    });
    await expect(resolveInsightsZone(transient, NOW, "America/Los_Angeles")).rejects.toThrow("pool timeout");
  });
});

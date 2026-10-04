import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  MAX_CYCLE_DAYS,
  PM_PLANNING_ERRORS,
  PmPlanningError,
  daysInclusive,
  formatDateOnly,
  lockAttachableCycle,
  parseDateOnly,
} from "./pm-planning.js";

describe("parseDateOnly / formatDateOnly — calendar dates are never local-time instants", () => {
  it("parses YYYY-MM-DD to midnight UTC", () => {
    expect(parseDateOnly("2026-10-05")?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
  });

  it("is independent of the process timezone", () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
        process.env.TZ = tz;
        expect(parseDateOnly("2026-03-08")?.toISOString()).toBe("2026-03-08T00:00:00.000Z"); // a DST-change day
        expect(formatDateOnly(new Date("2026-03-08T00:00:00.000Z"))).toBe("2026-03-08");
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it.each([
    "2026-10-5",
    "26-10-05",
    "2026/10/05",
    "2026-10-05T00:00:00Z",
    " 2026-10-05",
    "",
    "tomorrow",
  ])("rejects the malformed value %j", (v) => {
    expect(parseDateOnly(v)).toBeNull();
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-29"])(
    "rejects the impossible calendar date %s",
    (v) => {
      expect(parseDateOnly(v)).toBeNull();
    },
  );

  it("accepts a leap day in a leap year", () => {
    expect(parseDateOnly("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("formats null and undefined as null", () => {
    expect(formatDateOnly(null)).toBeNull();
    expect(formatDateOnly(undefined)).toBeNull();
  });

  it("formats the UTC calendar day of any instant", () => {
    expect(formatDateOnly(new Date("2026-10-05T23:59:59.999Z"))).toBe("2026-10-05");
  });
});

describe("daysInclusive", () => {
  it("counts both ends", () => {
    expect(daysInclusive(parseDateOnly("2026-10-05")!, parseDateOnly("2026-10-05")!)).toBe(1);
    expect(daysInclusive(parseDateOnly("2026-10-05")!, parseDateOnly("2026-10-09")!)).toBe(5);
  });

  it("counts calendar days across a DST change", () => {
    expect(daysInclusive(parseDateOnly("2026-03-07")!, parseDateOnly("2026-03-09")!)).toBe(3);
  });

  it("MAX_CYCLE_DAYS is a year and a day, so a leap year fits", () => {
    expect(MAX_CYCLE_DAYS).toBe(366);
  });
});

describe("PmPlanningError", () => {
  it("is an Error whose message IS the code, so every `switch (err.message)` mapper keeps working", () => {
    const e = new PmPlanningError(PM_PLANNING_ERRORS.CYCLE_ALREADY_ACTIVE, { activeCycleId: "c1" });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("cycle_already_active");
    expect(e.code).toBe("cycle_already_active");
    expect(e.details).toEqual({ activeCycleId: "c1" });
  });
});

describe("lockAttachableCycle", () => {
  function fakeDb(opts: {
    touched: number;
    cycle?: { projectId: string; status: "draft" | "active" | "completed" } | null;
  }) {
    const updateMany = vi.fn(async () => ({ count: opts.touched }));
    const findUnique = vi.fn(async () => opts.cycle ?? null);
    return {
      db: { pmCycle: { updateMany, findUnique } } as unknown as Prisma.TransactionClient,
      updateMany,
      findUnique,
    };
  }

  it("locks the cycle row with a compare-and-set that names project and status", async () => {
    const { db, updateMany, findUnique } = fakeDb({ touched: 1 });
    await lockAttachableCycle(db, "c1", "p1");
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = (updateMany.mock.calls[0] as unknown[])[0] as { where: unknown };
    // The where clause IS the guard: the row is only touched (and so only
    // locked) if it is in this project and not completed — and it is
    // re-evaluated against the committed row after waiting for any concurrent
    // writer, which is what serialises an attach against completeCycle.
    expect(arg.where).toEqual({ id: "c1", projectId: "p1", status: { not: "completed" } });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("cycle_not_found when there is no such cycle", async () => {
    const { db } = fakeDb({ touched: 0, cycle: null });
    await expect(lockAttachableCycle(db, "nope", "p1")).rejects.toThrow("cycle_not_found");
  });

  it("invalid_cycle when the cycle lives in another project", async () => {
    const { db } = fakeDb({ touched: 0, cycle: { projectId: "other", status: "active" } });
    await expect(lockAttachableCycle(db, "c1", "p1")).rejects.toThrow("invalid_cycle");
  });

  it("cycle_completed when the cycle is finished", async () => {
    const { db } = fakeDb({ touched: 0, cycle: { projectId: "p1", status: "completed" } });
    await expect(lockAttachableCycle(db, "c1", "p1")).rejects.toThrow("cycle_completed");
  });
});

// WARP-3520 — the shared zod pieces for the fields the editors write: kind,
// estimate and calendar dates. Pure; no database.

import { describe, it, expect } from "vitest";
import { WORK_ITEM_TYPE, ESTIMATE, dateInput, parseDateInput } from "./field-schemas.js";

describe("WORK_ITEM_TYPE", () => {
  it("accepts the six kinds and nothing else", () => {
    for (const t of ["task", "bug", "feature", "improvement", "question", "incident"]) {
      expect(WORK_ITEM_TYPE.safeParse(t).success).toBe(true);
    }
    for (const bad of ["epic", "Bug", "", null, 1]) {
      expect(WORK_ITEM_TYPE.safeParse(bad).success).toBe(false);
    }
  });
});

describe("ESTIMATE", () => {
  it("accepts 0..1000 inclusive, fractions included", () => {
    for (const n of [0, 0.5, 1, 13, 1000]) expect(ESTIMATE.safeParse(n).success).toBe(true);
  });

  it("rejects negatives, over-range, NaN, Infinity and non-numbers", () => {
    for (const bad of [-1, -0.01, 1000.01, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(ESTIMATE.safeParse(bad).success).toBe(false);
    }
  });
});

describe("dateInput", () => {
  it("accepts a real calendar date", () => {
    for (const s of ["2026-10-04", "2024-02-29", "2026-12-31", "2026-01-01"]) {
      expect(dateInput.safeParse(s).success, s).toBe(true);
    }
  });

  it("rejects a date that does not exist (a Date round trip would roll it forward)", () => {
    for (const s of ["2026-02-30", "2025-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-10-00"]) {
      expect(dateInput.safeParse(s).success, s).toBe(false);
    }
  });

  it("still accepts the ISO-8601 datetime every pre-editor client sent", () => {
    expect(dateInput.safeParse("2026-10-04T00:00:00.000Z").success).toBe(true);
    expect(dateInput.safeParse("2026-10-04T13:45:10Z").success).toBe(true);
  });

  it("rejects everything else", () => {
    for (const s of ["", "tomorrow", "10/04/2026", "2026-10-4", "2026-10-04T25:00:00Z", "2026-10-04 00:00:00"]) {
      expect(dateInput.safeParse(s).success, s).toBe(false);
    }
    expect(dateInput.safeParse(20261004).success).toBe(false);
  });
});

describe("parseDateInput", () => {
  it("stores a calendar date at 00:00:00Z — the day entered is the day stored in any timezone", () => {
    expect(parseDateInput("2026-10-04").toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(parseDateInput("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("passes a datetime through unchanged", () => {
    expect(parseDateInput("2026-10-04T13:45:10.000Z").toISOString()).toBe("2026-10-04T13:45:10.000Z");
  });
});

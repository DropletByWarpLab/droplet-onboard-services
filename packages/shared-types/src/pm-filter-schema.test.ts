/**
 * WARP-3522 — the zod face of the filter grammar. The rules live in
 * `validatePmFilter`; this only proves the adapter reports them the way a route
 * (and later a tool schema) expects: a clean copy on success, a zod issue
 * carrying the offending path on failure.
 */
import { describe, it, expect } from "vitest";
import { PmColumnsSchema, PmFilterSchema, PmGroupBySchema, PmSortSchema } from "./pm-filter-schema";

describe("PmFilterSchema", () => {
  it("parses to the clean copy", () => {
    const res = PmFilterSchema.safeParse({ and: [{ field: "text", op: "contains", value: "  hi " }] });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data).toEqual({ and: [{ field: "text", op: "contains", value: "hi" }] });
  });

  it("reports the failure as a zod issue at the offending path", () => {
    const res = PmFilterSchema.safeParse({ and: [{ field: "priority", op: "is", value: "critical" }] });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues).toHaveLength(1);
      expect(res.error.issues[0].path).toEqual(["and", 0, "value"]);
      expect(res.error.issues[0].message).toBe("filter_value_invalid");
    }
  });

  it("composes: optional / nullable / nested in an object", () => {
    const body = PmFilterSchema.optional();
    expect(body.safeParse(undefined).success).toBe(true);
    expect(body.safeParse({ and: [] }).success).toBe(true);
    expect(body.safeParse("x").success).toBe(false);
  });
});

describe("PmSortSchema / PmGroupBySchema / PmColumnsSchema", () => {
  it("accept what the validators accept and refuse what they refuse", () => {
    expect(PmSortSchema.safeParse([{ field: "dueDate", dir: "asc" }]).success).toBe(true);
    expect(PmSortSchema.safeParse([{ field: "nope", dir: "asc" }]).success).toBe(false);
    expect(PmGroupBySchema.safeParse("state").success).toBe(true);
    expect(PmGroupBySchema.safeParse("nope").success).toBe(false);
    expect(PmColumnsSchema.safeParse(["key", "state"]).success).toBe(true);
    expect(PmColumnsSchema.safeParse([]).success).toBe(false);
  });
});

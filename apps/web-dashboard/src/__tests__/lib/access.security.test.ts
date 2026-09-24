/**
 * WARP-2978 (ADR-059 P3 §8) — what each Security level grants, in the words
 * the Access & Roles builder shows. Choosing who is told about alerts is
 * manage (route 22); acknowledging an incident is act (routes 19–20).
 */
import { describe, expect, it } from "vitest";
import { featureDef } from "@/lib/access";

describe("the Security levels' copy", () => {
  const levels = Object.fromEntries((featureDef("security")?.levels ?? []).map((l) => [l.value, l.grants]));

  it("manage names who's told about alerts", () => {
    expect(levels.manage).toBe("Areas, opening hours, who's told about alerts and what counts as expected");
  });

  it("act still names acknowledging", () => {
    expect(levels.act).toMatch(/acknowledge/);
  });
});

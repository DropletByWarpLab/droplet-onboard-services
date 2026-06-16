/**
 * WARP-576 — HEALTH_COPY lookup is total.
 *
 * Regression guard for the home page (page.tsx:431/437/780): an out-of-set
 * `systemHealth.status` coming over the wire must resolve to a defined copy
 * object, never `undefined` — otherwise reading `.dot`/`.label` throws and
 * white-screens the dashboard. This test fails if the lookup ever regresses
 * to an unguarded index access.
 */
import { describe, it, expect } from "vitest";
import { HEALTH_COPY, resolveHealthCopy } from "@/app/health-copy";

describe("HEALTH_COPY lookup (WARP-576)", () => {
  it("returns a defined copy for every known status", () => {
    for (const status of ["ok", "degraded", "down"] as const) {
      const copy = resolveHealthCopy(status);
      expect(copy).toBeDefined();
      expect(typeof copy.label).toBe("string");
      expect(copy.label.length).toBeGreaterThan(0);
      expect(typeof copy.dot).toBe("string");
      expect(copy.dot.length).toBeGreaterThan(0);
    }
  });

  it("returns the explicit fallback for an unknown status string", () => {
    // A status the backend might emit that is outside the current union.
    const copy = resolveHealthCopy("catastrophic");
    expect(copy).toBeDefined();
    expect(copy).toBe(HEALTH_COPY.unknown);
    // Reading .dot / .label must not throw and must be non-empty.
    expect(copy.label.length).toBeGreaterThan(0);
    expect(copy.dot.length).toBeGreaterThan(0);
  });

  it("never returns undefined, even for empty / garbage input", () => {
    for (const bad of ["", "OK", "Down", "null", "undefined"]) {
      expect(resolveHealthCopy(bad)).toBeDefined();
    }
  });

  it("declares an explicit `unknown` fallback key", () => {
    expect(HEALTH_COPY.unknown).toBeDefined();
    expect(HEALTH_COPY.unknown.label.length).toBeGreaterThan(0);
  });
});

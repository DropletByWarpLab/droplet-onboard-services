/**
 * WARP-631 — unit tests for the pure progressive-backoff schedule.
 *
 * `claimBackoffSeconds(failureCount)` maps the running per-IP wrong-code count
 * onto the lockout duration. Free tier = 3 forgiven attempts; the 4th wrong
 * code is the first lock. The schedule escalates and caps:
 *
 *   fails 1–3 → 0   (no lock — inline CLAIM_CODE_INVALID)
 *   fail 4    → 15
 *   fail 5    → 30
 *   fail 6    → 60
 *   fail 7    → 120
 *   fail 8    → 300
 *   fail 9+   → 900  (cap; never decreases)
 *
 * Pure function, no I/O — the deterministic schedule is the unit under test
 * (AC#7). The route wires it to Redis; that behaviour is covered in
 * setup-claim.test.ts.
 */
import { describe, it, expect } from "vitest";
import { claimBackoffSeconds } from "./setup.js";

describe("claimBackoffSeconds (WARP-631 progressive backoff)", () => {
  it("forgives the first three wrong codes (free tier) with no lock", () => {
    expect(claimBackoffSeconds(0)).toBe(0);
    expect(claimBackoffSeconds(1)).toBe(0);
    expect(claimBackoffSeconds(2)).toBe(0);
    expect(claimBackoffSeconds(3)).toBe(0);
  });

  it("locks for 15s on the 4th wrong code (AC#1)", () => {
    expect(claimBackoffSeconds(4)).toBe(15);
  });

  it("escalates 15 → 30 → 60 → 120 → 300 on successive lockouts (AC#2)", () => {
    expect(claimBackoffSeconds(4)).toBe(15);
    expect(claimBackoffSeconds(5)).toBe(30);
    expect(claimBackoffSeconds(6)).toBe(60);
    expect(claimBackoffSeconds(7)).toBe(120);
    expect(claimBackoffSeconds(8)).toBe(300);
  });

  it("caps at 900s and never decreases past the cap (AC#2)", () => {
    expect(claimBackoffSeconds(9)).toBe(900);
    expect(claimBackoffSeconds(10)).toBe(900);
    expect(claimBackoffSeconds(50)).toBe(900);
    expect(claimBackoffSeconds(1000)).toBe(900);
  });

  it("is monotonic non-decreasing across the whole domain (AC#2)", () => {
    let prev = -1;
    for (let n = 0; n <= 30; n += 1) {
      const cur = claimBackoffSeconds(n);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("treats a negative/garbage count as no lock (defensive)", () => {
    expect(claimBackoffSeconds(-1)).toBe(0);
    expect(claimBackoffSeconds(-100)).toBe(0);
  });
});

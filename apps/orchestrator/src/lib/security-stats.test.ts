/**
 * WARP-2980 (ADR-059 P5 §6.4, D29) — the one Poisson upper tail on the box.
 *
 * Reference values were computed independently with mpmath at 40–50 digits
 * (Σ_{i≥k} e^{−λ} λ^i / i!), so every pin below is the true tail, not this
 * function's own output. The P4 co-occurrence test pins the same function
 * (p4-spec §6.1 `poissonTail`): 12, 0.168 → 9.04e−19 and 9, 6.3 → 0.185.
 */
import { describe, expect, it } from "vitest";
import { lnFactorial, poissonUpperTail } from "./security-stats.js";

const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b);

/** An independent upper-tail sum: every term straight from logs (Σ ln j), no recurrence, 800 terms. */
function naiveUpperTail(k: number, lambda: number): number {
  let lnFact = 0;
  for (let j = 2; j < k; j += 1) lnFact += Math.log(j);
  let sum = 0;
  for (let i = k; i < k + 800; i += 1) {
    if (i >= 2) lnFact += Math.log(i);
    sum += Math.exp(-lambda + i * Math.log(lambda) - lnFact);
  }
  return sum;
}

describe("poissonUpperTail — P(X ≥ k | λ), exact and stable", () => {
  it("k ≤ 0 → 1; λ ≤ 0 → 0 for k ≥ 1", () => {
    expect(poissonUpperTail(0, 3)).toBe(1);
    expect(poissonUpperTail(-2, 3)).toBe(1);
    expect(poissonUpperTail(0, 0)).toBe(1);
    expect(poissonUpperTail(1, 0)).toBe(0);
    expect(poissonUpperTail(5, -1)).toBe(0);
  });

  it("agrees with an independent term-by-term sum for λ ≤ 20, k ≤ 40 (relative error < 1e-9)", () => {
    let compared = 0;
    for (const lambda of [0.01, 0.0167, 0.168, 0.3125, 0.5, 1, 2.5, 6.3, 8.017, 10, 15, 20]) {
      for (let k = 1; k <= 40; k += 1) {
        const want = naiveUpperTail(k, lambda);
        if (!(want > 1e-290)) continue;
        expect(rel(poissonUpperTail(k, lambda), want), `k=${k} λ=${lambda}`).toBeLessThan(1e-9);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(400);
  });

  it.each([
    // spec §6.4's worked table (mpmath)
    [2, 0.0167, 1.3790219e-4],
    [3, 0.0167, 7.6658603e-7],
    [3, 0.3125, 4.0310676e-3],
    [4, 0.3125, 3.0987811e-4],
    [18, 8.017, 1.6307123e-3],
    [19, 8.017, 6.6658582e-4],
    // a busy street camera: the naive 1 − CDF is NaN / 0 here
    [880, 800, 2.7871578e-3],
    [900, 800, 2.7591344e-4],
    // above the ln k! table (k > 1024): Stirling
    [2000, 1500, 6.60148811562e-35],
  ])("P(X ≥ %i | λ = %f) = %e", (k, lambda, want) => {
    const got = poissonUpperTail(k, lambda);
    expect(Number.isFinite(got)).toBe(true);
    expect(rel(got, want)).toBeLessThan(1e-6);
  });

  it("P4's pinned values run against it unchanged (p4-spec §6.1)", () => {
    expect(rel(poissonUpperTail(12, 0.168), 9.04e-19)).toBeLessThan(1e-3);
    expect(rel(poissonUpperTail(9, 6.3), 0.185)).toBeLessThan(2e-3);
  });

  it.each([
    [5, 10, 0.970747311923],
    [10, 10, 0.542070285528],
    [800, 800, 0.504701612422],
    [1500, 1500, 0.50343356116],
    [1, 0.5, 0.393469340287],
  ])("the k ≤ λ branch: P(X ≥ %i | λ = %f) = %f", (k, lambda, want) => {
    expect(rel(poissonUpperTail(k, lambda), want)).toBeLessThan(1e-9);
  });

  it("underflows to 0, never NaN or negative, far past λ", () => {
    // True value 2.46e−4568.
    expect(poissonUpperTail(1000, 0.01)).toBe(0);
    expect(poissonUpperTail(100_000, 3)).toBe(0);
  });

  it("is monotone decreasing in k", () => {
    for (const lambda of [0.0167, 0.4, 3, 8.017, 50, 800]) {
      let prev = 1;
      const top = Math.ceil(lambda * 2 + 30);
      for (let k = 0; k <= top; k += 1) {
        const p = poissonUpperTail(k, lambda);
        expect(p, `k=${k} λ=${lambda}`).toBeLessThanOrEqual(prev);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        prev = p;
      }
    }
  });
});

describe("lnFactorial — a table to 1024, Stirling above", () => {
  it("is exact on small k", () => {
    expect(lnFactorial(0)).toBe(0);
    expect(lnFactorial(1)).toBe(0);
    expect(lnFactorial(5)).toBeCloseTo(Math.log(120), 12);
  });

  it("the table and Stirling meet without a seam at 1024 / 1025", () => {
    let sum = 0;
    for (let j = 2; j <= 1030; j += 1) sum += Math.log(j);
    expect(rel(lnFactorial(1030), sum)).toBeLessThan(1e-12);
    expect(Math.abs(lnFactorial(1025) - lnFactorial(1024) - Math.log(1025))).toBeLessThan(1e-9);
  });
});

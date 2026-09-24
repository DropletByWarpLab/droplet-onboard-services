/**
 * WARP-2980 (ADR-059 P5 §6.4, D29) — the ONE Poisson upper tail on the box.
 *
 * P5's `unusual_volume` (k detections in an hour against a learned rate) and
 * P4's link co-occurrence test (p4-spec §6.1 `poissonTail`) need the same
 * quantity, P(X ≥ k | λ). Whichever PR lands first creates this file and the
 * other imports it: two copies would drift, and P4's draft (1 − CDF, with a
 * 60-term fallback) truncates the tail for a busy camera (λ = 800 needs
 * hundreds of terms). Both specs' pinned values run against this function
 * (security-stats.test.ts).
 *
 * Exact and stable:
 *   · k ≤ 0 → 1; λ ≤ 0 → 0 (not reachable from the rules: λ > 0 by construction).
 *   · k > λ: the upper tail is summed DIRECTLY. t_k = exp(−λ + k·ln λ − ln k!),
 *     t_{i+1} = t_i · λ/(i+1). With i ≥ k > λ the ratio is below 1 and
 *     falling, so what is left after a term is at most t·r/(1−r); stop when
 *     that is under 1e−15 of the sum, or after 10 000 terms. Never 1 − CDF
 *     here: that is the cancellation that returns 0 or a negative number for
 *     a large λ.
 *   · k ≤ λ: 1 − Σ_{i<k} t_i, clamped to [0, 1]. The answer is ≥ ~0.4 there,
 *     so nothing that matters to a `< 0.001` test cancels. Every t_i is taken
 *     from logs, never by recurrence from e^{−λ}, which underflows to 0 for
 *     λ > ~745.
 */

/** ln k! is tabulated to here; Stirling above. */
const TABLE_MAX = 1024;
const MAX_TERMS = 10_000;
const REL_STOP = 1e-15;

let lnFactTable: Float64Array | null = null;

function table(): Float64Array {
  if (lnFactTable) return lnFactTable;
  const t = new Float64Array(TABLE_MAX + 1);
  for (let k = 2; k <= TABLE_MAX; k += 1) t[k] = t[k - 1]! + Math.log(k);
  lnFactTable = t;
  return t;
}

/**
 * ln k! for a non-negative integer k: exact (a cached cumulative sum) to
 * 1024, then Stirling with the 1/(12k) − 1/(360k³) terms (error < 1e−10).
 */
export function lnFactorial(k: number): number {
  if (k < 2) return 0;
  if (k <= TABLE_MAX) return table()[k]!;
  return k * Math.log(k) - k + 0.5 * Math.log(2 * Math.PI * k) + 1 / (12 * k) - 1 / (360 * k * k * k);
}

/** P(X ≥ k) for X ~ Poisson(λ). */
export function poissonUpperTail(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (!(lambda > 0)) return 0;
  const lnLambda = Math.log(lambda);
  const term = (i: number): number => Math.exp(-lambda + i * lnLambda - lnFactorial(i));

  if (k > lambda) {
    let t = term(k);
    // Every later term is smaller still: the whole tail underflows.
    if (t === 0) return 0;
    let sum = t;
    for (let i = k, n = 0; n < MAX_TERMS; i += 1, n += 1) {
      const r = lambda / (i + 1);
      if ((t * r) / (1 - r) < REL_STOP * sum) break;
      t *= r;
      sum += t;
    }
    return Math.min(1, sum);
  }

  let below = 0;
  for (let i = 0; i < k; i += 1) below += term(i);
  return Math.min(1, Math.max(0, 1 - below));
}

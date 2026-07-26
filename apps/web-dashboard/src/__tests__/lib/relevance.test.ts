import { describe, it, expect } from "vitest";
import { relevancePct, inferScoreKind } from "@/lib/relevance";

describe("relevancePct (WARP-859 / WARP-1603)", () => {
  it("squashes an unbounded reranker logit into 0–100 (no more 1020%)", () => {
    // BGE-reranker-base logit ~10.2 used to render as 1020%.
    expect(relevancePct(10.2)).toBe(100);
    expect(relevancePct(3)).toBeGreaterThan(90);
    expect(relevancePct(3)).toBeLessThanOrEqual(100);
  });

  it("passes a bounded 0–1 relevance straight through", () => {
    // WARP-1603 changed the untagged-score rule from "≤ 1 ⇒ cosine" to
    // "INSIDE [0, 1] ⇒ bounded relevance". Everything in [0, 1] still
    // renders verbatim; what changed is only the treatment below 0.
    expect(relevancePct(0.82)).toBe(82);
    expect(relevancePct(1)).toBe(100);
    expect(relevancePct(0)).toBe(0);
  });

  /**
   * WARP-1603 — this block previously asserted `relevancePct(-0.3) === 0`,
   * which PINNED the bug: BGE-reranker-base emits negative logits for all
   * but a strong match, WARP-859's `score > 1` guard sent them down the
   * "bounded similarity" branch, and every chat citation chip clamped to
   * 0%. A negative logit is a weak-but-real match and must read as one.
   */
  it("renders a negative reranker logit as a small-but-nonzero percent", () => {
    expect(relevancePct(-0.3)).toBe(43); // sigmoid(-0.3) ≈ 0.4256
    expect(relevancePct(-1)).toBe(27); // sigmoid(-1)   ≈ 0.2689
    expect(relevancePct(-2)).toBe(12); // sigmoid(-2)   ≈ 0.1192
    // Strictly monotonic: a worse logit never outranks a better one.
    expect(relevancePct(-2)).toBeLessThan(relevancePct(-1));
    expect(relevancePct(-1)).toBeLessThan(relevancePct(-0.3));
  });

  it("still floors a hopeless logit at 0 (genuine, not a clamp artifact)", () => {
    // sigmoid(-50) ≈ 2e-22 — rounds to 0% because the match really is
    // nil, not because the branch mistook a logit for a similarity.
    expect(relevancePct(-50)).toBe(0);
  });

  it("honours an explicit scoreKind instead of inferring", () => {
    // 0.5 is ambiguous by value alone: a 50% relevance, or a logit worth
    // sigmoid(0.5) ≈ 62%. The tag decides — that is the whole point of
    // producers stamping `scoreKind` (WARP-1603).
    expect(relevancePct(0.5, "similarity")).toBe(50);
    expect(relevancePct(0.5, "logit")).toBe(62);
    // An explicit "similarity" tag also suppresses the sigmoid on an
    // out-of-range value rather than silently re-interpreting it.
    expect(relevancePct(-0.3, "similarity")).toBe(0);
    expect(relevancePct(5, "similarity")).toBe(100);
  });

  it("infers 'similarity' inside [0,1] and 'logit' outside it", () => {
    expect(inferScoreKind(0)).toBe("similarity");
    expect(inferScoreKind(0.42)).toBe("similarity");
    expect(inferScoreKind(1)).toBe("similarity");
    expect(inferScoreKind(1.0001)).toBe("logit");
    expect(inferScoreKind(-0.0001)).toBe("logit");
    expect(inferScoreKind(10.2)).toBe("logit");
  });

  it("never exceeds 100 or drops below 0", () => {
    for (const s of [-1000, -1, 0, 0.5, 1, 5, 50, 1000]) {
      const p = relevancePct(s);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it("returns 0 for non-finite input (guards NaN/Infinity)", () => {
    expect(relevancePct(NaN)).toBe(0);
    expect(relevancePct(Infinity)).toBe(0);
    expect(relevancePct(-Infinity)).toBe(0);
    expect(relevancePct(NaN, "logit")).toBe(0);
  });
});

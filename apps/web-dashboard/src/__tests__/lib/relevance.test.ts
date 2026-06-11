import { describe, it, expect } from "vitest";
import { relevancePct } from "@/lib/relevance";

describe("relevancePct (WARP-859)", () => {
  it("squashes an unbounded reranker logit into 0–100 (no more 1020%)", () => {
    // BGE-reranker-base logit ~10.2 used to render as 1020%.
    expect(relevancePct(10.2)).toBe(100);
    expect(relevancePct(3)).toBeGreaterThan(90);
    expect(relevancePct(3)).toBeLessThanOrEqual(100);
  });

  it("passes a bounded cosine similarity straight through", () => {
    expect(relevancePct(0.82)).toBe(82);
    expect(relevancePct(1)).toBe(100);
    expect(relevancePct(0)).toBe(0);
  });

  it("clamps negative scores to 0", () => {
    expect(relevancePct(-0.3)).toBe(0);
    expect(relevancePct(-50)).toBe(0);
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
  });
});

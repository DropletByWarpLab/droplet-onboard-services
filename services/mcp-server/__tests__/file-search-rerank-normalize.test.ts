/**
 * WARP-1603 — reranker scores leave this service NORMALIZED and TAGGED.
 *
 * ai-gateway's `reranker.py` returns `outputs.logits` with no sigmoid, and
 * BGE-reranker-base emits negative logits for all but a strong match. That
 * raw number used to travel all the way to the dashboard's citation chip,
 * where a renderer heuristic ("> 1 means logit") mistook it for a bounded
 * similarity and clamped every chip to 0%.
 *
 * The scale is a property of the model, so it is resolved here — the only
 * place that knows which model produced the number. These tests pin:
 *   - the sigmoid is applied on BOTH the fresh and the cached path,
 *   - the Redis cache keeps RAW logits (entries written by a pre-WARP-1603
 *     build stay readable, and re-reads never double-squash),
 *   - rank order is unchanged (sigmoid is monotonic),
 *   - `scoreKind` is stamped on every path, including the rerank-failure
 *     pass-through.
 */
import { describe, it, expect, vi } from "vitest";
import {
  rerankPassages,
  normalizeRerankScore,
  type SearchHit,
} from "../src/file-search.service.js";

function hit(path: string, score: number): SearchHit {
  return {
    source: "nextcloud",
    path,
    chunkIdx: 0,
    pageNumber: null,
    score,
    snippet: `snippet for ${path}`,
    brainItemId: null,
    metadata: null,
  };
}

/** RRF-shaped input: what `searchHybrid` hands the rerank stage. */
const HITS: SearchHit[] = [hit("/a.md", 0.03), hit("/b.md", 0.016)];

function redisStub(cached: string | null = null) {
  return {
    get: vi.fn(async (_key: string) => cached),
    // The parameters are declared even though the body ignores them: without
    // them vitest infers `Mock<[], …>`, so `setex.mock.calls[0]` is the empty
    // tuple and the assertion below had to cast it to a shape it could never
    // have. Declaring them makes `calls[0]` genuinely `[string, number,
    // string]` and the cast unnecessary.
    setex: vi.fn(async (_key: string, _ttlSeconds: number, _payload: string) => "OK"),
  };
}

function rerankerStub(scores: number[]) {
  return { rerank: vi.fn(async () => ({ scores })) };
}

describe("normalizeRerankScore", () => {
  it("maps a raw logit into (0, 1)", () => {
    expect(normalizeRerankScore(0)).toBeCloseTo(0.5, 10);
    expect(normalizeRerankScore(-1)).toBeCloseTo(0.2689414, 6);
    expect(normalizeRerankScore(10.2)).toBeGreaterThan(0.99);
    expect(normalizeRerankScore(10.2)).toBeLessThan(1);
  });

  it("keeps a negative logit strictly above zero (the 0% bug)", () => {
    expect(normalizeRerankScore(-2)).toBeGreaterThan(0);
    expect(normalizeRerankScore(-2)).toBeLessThan(normalizeRerankScore(-1));
  });

  it("returns 0 rather than NaN for a non-finite logit", () => {
    expect(normalizeRerankScore(NaN)).toBe(0);
    expect(normalizeRerankScore(Infinity)).toBe(0);
  });
});

describe("rerankPassages score normalization (WARP-1603)", () => {
  it("emits sigmoid-normalized scores tagged as 'similarity'", async () => {
    const out = await rerankPassages({
      query: "q",
      hits: HITS,
      redis: redisStub(),
      reranker: rerankerStub([-1, 3.5]),
    });

    // Sorted best-first: 3.5 outranks -1.
    expect(out.map((h) => h.path)).toEqual(["/b.md", "/a.md"]);
    expect(out[0].score).toBeCloseTo(normalizeRerankScore(3.5), 10);
    expect(out[1].score).toBeCloseTo(normalizeRerankScore(-1), 10);
    // The whole point: the weak hit is a small POSITIVE relevance, not 0.
    expect(out[1].score).toBeGreaterThan(0.2);
    for (const h of out) {
      expect(h.scoreKind).toBe("similarity");
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it("preserves rank order for all-negative logits", async () => {
    const out = await rerankPassages({
      query: "q",
      hits: HITS,
      redis: redisStub(),
      reranker: rerankerStub([-4, -0.5]),
    });
    expect(out.map((h) => h.path)).toEqual(["/b.md", "/a.md"]);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it("caches the RAW logits, not the normalized scores", async () => {
    const redis = redisStub();
    await rerankPassages({
      query: "q",
      hits: HITS,
      redis,
      reranker: rerankerStub([-1, 3.5]),
    });
    const [, , payload] = redis.setex.mock.calls[0];
    // Raw on the wire ⇒ a pre-WARP-1603 cache entry is still readable, and
    // a cache round-trip can never sigmoid twice.
    expect(JSON.parse(payload)).toEqual([-1, 3.5]);
  });

  it("normalizes on the cache-hit path too", async () => {
    const redis = redisStub(JSON.stringify([-1, 3.5]));
    const reranker = rerankerStub([]);
    const out = await rerankPassages({
      query: "q",
      hits: HITS,
      redis,
      reranker,
    });
    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(out.map((h) => h.path)).toEqual(["/b.md", "/a.md"]);
    expect(out[0].score).toBeCloseTo(normalizeRerankScore(3.5), 10);
    expect(out[1].score).toBeCloseTo(normalizeRerankScore(-1), 10);
    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
  });

  it("tags the rerank-failure pass-through without touching the RRF scores", async () => {
    const out = await rerankPassages({
      query: "q",
      hits: HITS,
      redis: redisStub(),
      reranker: {
        rerank: vi.fn(async () => {
          throw new Error("ai-gateway down");
        }),
      },
    });
    // Unchanged RRF ordering and values — only the tag is added.
    expect(out.map((h) => h.score)).toEqual([0.03, 0.016]);
    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
  });
});

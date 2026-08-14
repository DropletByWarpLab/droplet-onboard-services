/**
 * WARP-1637 — the orchestrator's copy of file-search.service tags its scores.
 *
 * ── The defect ──────────────────────────────────────────────────────────
 * `file-search.service.ts` exists TWICE — here and in
 * `services/mcp-server/src/`. WARP-1603 normalized reranker logits and
 * stamped `scoreKind`, but only on the mcp-server copy. This one, which
 * backs the `/knowledge` search route, kept emitting RAW logits untagged.
 *
 * The renderer's `inferScoreKind` (`lib/relevance.ts`) reads anything inside
 * [0, 1] as an already-bounded similarity, so on /knowledge:
 *   - a logit of  0.0 rendered as   0%  — the exact reported complaint
 *   - a logit of  0.5 rendered as  50%  instead of the correct ~62%
 * Negative logits happened to work, because they fall OUTSIDE [0, 1] and are
 * inferred as logits — which is why the sibling test only covering -1 did
 * not catch this. The positive range is where it broke.
 *
 * These tests pin the producer side: whatever comes out of this service
 * carries the scale it is in, so nothing downstream has to guess.
 */
import { describe, it, expect, vi } from "vitest";
import {
  normalizeRerankScore,
  rerankPassages,
} from "../services/file-search.service.js";
import type { SearchHit } from "../services/file-search.service.js";

const hit = (path: string, score: number): SearchHit => ({
  source: "nextcloud",
  path,
  chunkIdx: 0,
  pageNumber: null,
  score,
  snippet: `snippet for ${path}`,
  brainItemId: null,
  metadata: null,
});

/** Redis that holds nothing and accepts every write. */
const coldRedis = () => ({
  get: vi.fn(async () => null),
  setex: vi.fn(async () => "OK"),
});

describe("normalizeRerankScore (WARP-1637)", () => {
  it("maps a zero logit to the middle of the range, not to zero", () => {
    // The headline defect: 0.0 is a MIDDLING logit, and rendering it as 0%
    // told the user the hit was completely irrelevant.
    expect(normalizeRerankScore(0)).toBeCloseTo(0.5, 10);
  });

  it("is monotonic, so the ranking is untouched", () => {
    const raw = [-4, -1, 0, 0.5, 3];
    const normalized = raw.map(normalizeRerankScore);
    const sortedRaw = [...raw].sort((a, b) => b - a);
    const sortedNorm = [...normalized].sort((a, b) => b - a);
    expect(sortedNorm).toEqual(sortedRaw.map(normalizeRerankScore));
  });

  it("bounds every finite logit inside [0, 1]", () => {
    for (const l of [-50, -1, 0, 1, 50]) {
      const p = normalizeRerankScore(l);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("returns 0 for a non-finite input rather than NaN", () => {
    // A missing score must not become a confident number. `?? -Infinity` at
    // the call sites lands here.
    expect(normalizeRerankScore(NaN)).toBe(0);
    expect(normalizeRerankScore(-Infinity)).toBe(0);
    expect(normalizeRerankScore(Infinity)).toBe(0);
  });
});

describe("rerankPassages score tagging (WARP-1637)", () => {
  it("normalizes live reranker logits and tags them", async () => {
    const reranked = await rerankPassages({
      query: "budget",
      hits: [hit("/a.pdf", 0.02), hit("/b.pdf", 0.01)],
      redis: coldRedis(),
      reranker: { rerank: vi.fn(async () => ({ scores: [0, 2] })) },
    });

    // Sorted by normalized score, so /b.pdf (logit 2) leads.
    expect(reranked.map((h) => h.path)).toEqual(["/b.pdf", "/a.pdf"]);
    expect(reranked.every((h) => h.scoreKind === "similarity")).toBe(true);
    // The 0.0 logit that used to render as 0%.
    expect(reranked[1].score).toBeCloseTo(0.5, 10);
    expect(reranked[0].score).toBeCloseTo(1 / (1 + Math.exp(-2)), 10);
  });

  it("normalizes on the way OUT of the cache, which still holds raw logits", async () => {
    // Entries written by a pre-fix build must stay readable — the cache
    // format is unchanged and normalization happens exactly once, on read.
    const redis = {
      get: vi.fn(async () => JSON.stringify([0, 2])),
      setex: vi.fn(async () => "OK"),
    };
    const reranker = { rerank: vi.fn() };

    const reranked = await rerankPassages({
      query: "budget",
      hits: [hit("/a.pdf", 0.02), hit("/b.pdf", 0.01)],
      redis,
      reranker,
    });

    expect(reranker.rerank).not.toHaveBeenCalled();
    expect(reranked.map((h) => h.path)).toEqual(["/b.pdf", "/a.pdf"]);
    expect(reranked.every((h) => h.scoreKind === "similarity")).toBe(true);
    expect(reranked[1].score).toBeCloseTo(0.5, 10);
  });

  it("writes RAW logits back to the cache, not normalized ones", async () => {
    // Double-normalizing a cached value would squash it a second time. The
    // cache contract stays "raw logits in, raw logits out".
    const redis = coldRedis();
    await rerankPassages({
      query: "budget",
      hits: [hit("/a.pdf", 0.02)],
      redis,
      reranker: { rerank: vi.fn(async () => ({ scores: [2] })) },
    });

    expect(redis.setex).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      JSON.stringify([2]),
    );
  });

  it("tags the pass-through when the reranker throws", async () => {
    // The incoming RRF scores stand and are already bounded, so they are
    // tagged rather than left for the renderer to infer.
    const hits = [hit("/a.pdf", 0.016), hit("/b.pdf", 0.015)];
    const out = await rerankPassages({
      query: "budget",
      hits,
      redis: coldRedis(),
      reranker: {
        rerank: vi.fn(async () => {
          throw new Error("reranker down");
        }),
      },
    });

    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
    // Pass-through means the NUMBERS are untouched — tagging only.
    expect(out.map((h) => h.score)).toEqual([0.016, 0.015]);
  });

  it("tags the pass-through when the reranker returns a wrong-length response", async () => {
    const out = await rerankPassages({
      query: "budget",
      hits: [hit("/a.pdf", 0.016), hit("/b.pdf", 0.015)],
      redis: coldRedis(),
      reranker: { rerank: vi.fn(async () => ({ scores: [1] })) },
    });

    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
    expect(out.map((h) => h.score)).toEqual([0.016, 0.015]);
  });

  it("leaves an empty hit list alone", async () => {
    const out = await rerankPassages({
      query: "budget",
      hits: [],
      redis: coldRedis(),
      reranker: { rerank: vi.fn() },
    });
    expect(out).toEqual([]);
  });
});

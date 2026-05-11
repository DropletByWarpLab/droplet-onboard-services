/**
 * WARP-286 — unit tests for hybrid retrieval primitives.
 *
 * Covers:
 *   - reciprocalRankFusion: pure function; canonical RRF math.
 *   - searchByLexical: SQL shape + result mapping; $queryRawUnsafe mocked.
 *   - searchHybrid: parallel retrievers + RRF wiring (no reranker yet).
 */
import { describe, it, expect, vi } from "vitest";
import {
  reciprocalRankFusion,
  searchByLexical,
  searchHybrid,
  type SearchHit,
} from "./file-search.service.js";

function hit(
  source: "nextcloud" | "brain",
  path: string,
  chunkIdx: number,
  score: number,
): SearchHit {
  return {
    source,
    path,
    chunkIdx,
    pageNumber: null,
    brainItemId: null,
    score,
    snippet: "",
    metadata: null,
  };
}

describe("reciprocalRankFusion", () => {
  it("returns empty when both inputs are empty", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it("returns vector hits unchanged when lexical is empty", () => {
    const v = [
      hit("nextcloud", "/a.pdf", 0, 0.9),
      hit("nextcloud", "/b.pdf", 0, 0.8),
    ];
    const fused = reciprocalRankFusion(v, []);
    expect(fused.map((h) => h.path)).toEqual(["/a.pdf", "/b.pdf"]);
    // RRF scores: 1/(60+0), 1/(60+1)
    expect(fused[0]!.score).toBeCloseTo(1 / 60);
    expect(fused[1]!.score).toBeCloseTo(1 / 61);
  });

  it("boosts a chunk appearing in both lists above singletons", () => {
    const v = [
      hit("nextcloud", "/a.pdf", 0, 0.9),
      hit("nextcloud", "/b.pdf", 0, 0.8),
    ];
    const l = [
      hit("nextcloud", "/c.pdf", 0, 0.95),
      hit("nextcloud", "/a.pdf", 0, 0.85),
    ];
    const fused = reciprocalRankFusion(v, l);
    // /a.pdf appears in both → score = 1/60 + 1/61 ≈ 0.0333
    // /c.pdf only in lexical at rank 0 → 1/60 ≈ 0.01667
    // /b.pdf only in vector at rank 1 → 1/61 ≈ 0.01639
    expect(fused[0]!.path).toBe("/a.pdf");
    expect(fused[0]!.score).toBeCloseTo(1 / 60 + 1 / 61);
  });

  it("dedupes by (source, path, chunkIdx)", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9)];
    const l = [
      hit("nextcloud", "/a.pdf", 0, 0.8),
      hit("nextcloud", "/a.pdf", 1, 0.7),
    ];
    const fused = reciprocalRankFusion(v, l);
    expect(fused.length).toBe(2);
    expect(
      fused.map((h) => `${h.path}:${h.chunkIdx}`).sort(),
    ).toEqual(["/a.pdf:0", "/a.pdf:1"]);
  });

  it("honours custom k", () => {
    const v = [hit("nextcloud", "/a.pdf", 0, 0.9)];
    const fused = reciprocalRankFusion(v, [], 10);
    expect(fused[0]!.score).toBeCloseTo(1 / 10);
  });
});

describe("searchByLexical", () => {
  function mockPrisma(rows: unknown[]) {
    return { $queryRawUnsafe: vi.fn(async () => rows) } as never;
  }

  it("returns mapped hits with the user filter baked in", async () => {
    const prisma = mockPrisma([
      {
        source: "nextcloud",
        path: "/a.pdf",
        chunkIdx: 0,
        pageNumber: 3,
        brainItemId: null,
        metadata: null,
        snippet: "hello",
        score: 0.42,
      },
    ]);
    const hits = await searchByLexical(prisma, {
      userId: "alice",
      query: "hello",
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: "/a.pdf", score: 0.42 });
    const calls = (
      prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } }
    ).$queryRawUnsafe.mock.calls;
    const sql = calls[0]![0] as string;
    expect(sql).toContain('"userId" = $1');
    expect(sql).toContain("websearch_to_tsquery");
    expect(calls[0]!.slice(1)).toEqual(["alice", "hello", 10]);
  });

  it("appends source + since filters when provided", async () => {
    const prisma = mockPrisma([]);
    const since = new Date("2026-05-10T00:00:00Z");
    await searchByLexical(prisma, {
      userId: "alice",
      query: "hello",
      limit: 5,
      source: "brain",
      since,
    });
    const call = (
      prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } }
    ).$queryRawUnsafe.mock.calls[0]!;
    const sql = call[0] as string;
    expect(sql).toContain('source = $3::"FileContentSource"');
    expect(sql).toContain('"indexedAt" >= $4');
    expect(call.slice(1)).toEqual(["alice", "hello", "brain", since, 5]);
  });

  it("returns empty array when DB returns nothing", async () => {
    const prisma = mockPrisma([]);
    const hits = await searchByLexical(prisma, {
      userId: "alice",
      query: "hello",
      limit: 10,
    });
    expect(hits).toEqual([]);
  });
});

describe("searchHybrid (BM25 + RRF, pre-reranker)", () => {
  it("calls both retrievers in parallel and fuses results", async () => {
    const vectorRows = [
      {
        source: "nextcloud",
        path: "/a.pdf",
        chunkIdx: 0,
        pageNumber: 1,
        brainItemId: null,
        metadata: null,
        snippet: "v1",
        score: 0.95,
      },
      {
        source: "nextcloud",
        path: "/b.pdf",
        chunkIdx: 0,
        pageNumber: 1,
        brainItemId: null,
        metadata: null,
        snippet: "v2",
        score: 0.85,
      },
    ];
    const lexicalRows = [
      {
        source: "nextcloud",
        path: "/a.pdf",
        chunkIdx: 0,
        pageNumber: 1,
        brainItemId: null,
        metadata: null,
        snippet: "l1",
        score: 0.7,
      },
      {
        source: "nextcloud",
        path: "/c.pdf",
        chunkIdx: 0,
        pageNumber: 1,
        brainItemId: null,
        metadata: null,
        snippet: "l2",
        score: 0.5,
      },
    ];
    const prisma = {
      $queryRawUnsafe: vi
        .fn()
        .mockImplementationOnce(async () => vectorRows)
        .mockImplementationOnce(async () => lexicalRows),
    } as never;
    const hits = await searchHybrid(prisma, {
      userId: "alice",
      vector: new Array(384).fill(0.01),
      query: "hello",
      limit: 3,
    });
    expect(hits.map((h) => h.path)).toEqual(["/a.pdf", "/b.pdf", "/c.pdf"]);
    expect(
      (
        prisma as unknown as {
          $queryRawUnsafe: { mock: { calls: unknown[][] } };
        }
      ).$queryRawUnsafe,
    ).toHaveBeenCalledTimes(2);
  });

  it("respects limit smaller than fused result count", async () => {
    const prisma = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce([
          {
            source: "nextcloud",
            path: "/a.pdf",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
            metadata: null,
            snippet: "",
            score: 0.9,
          },
          {
            source: "nextcloud",
            path: "/b.pdf",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
            metadata: null,
            snippet: "",
            score: 0.8,
          },
        ])
        .mockResolvedValueOnce([]),
    } as never;
    const hits = await searchHybrid(prisma, {
      userId: "alice",
      vector: new Array(384).fill(0.01),
      query: "hello",
      limit: 1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("/a.pdf");
  });
});

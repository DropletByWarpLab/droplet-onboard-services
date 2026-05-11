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
  rerankPassages,
  searchByLexical,
  searchHybrid,
  shapeHitsForResponse,
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

function makeMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
      return "OK" as const;
    }),
  };
}

function makeMockReranker(scores: number[]) {
  return {
    rerank: vi.fn(async () => ({ scores })),
  };
}

describe("rerankPassages", () => {
  const baseHits = [
    hit("nextcloud", "/a.pdf", 0, 0.5),
    hit("nextcloud", "/b.pdf", 0, 0.4),
    hit("nextcloud", "/c.pdf", 0, 0.3),
  ];

  it("returns empty when input is empty", async () => {
    const redis = makeMockRedis();
    const r = makeMockReranker([]);
    const out = await rerankPassages({
      query: "x",
      hits: [],
      redis,
      reranker: r,
    });
    expect(out).toEqual([]);
    expect(r.rerank).not.toHaveBeenCalled();
  });

  it("calls the reranker on cache miss, writes the result", async () => {
    const redis = makeMockRedis();
    const r = makeMockReranker([0.1, 0.9, 0.2]);
    const out = await rerankPassages({
      query: "x",
      hits: baseHits,
      redis,
      reranker: r,
    });
    expect(out.map((h) => h.path)).toEqual(["/b.pdf", "/c.pdf", "/a.pdf"]);
    expect(out[0]!.score).toBe(0.9);
    expect(r.rerank).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it("uses cached scores on cache hit", async () => {
    const redis = makeMockRedis();
    const r1 = makeMockReranker([0.1, 0.9, 0.2]);
    await rerankPassages({ query: "x", hits: baseHits, redis, reranker: r1 });
    const r2 = makeMockReranker([99, 99, 99]); // never called
    const out = await rerankPassages({
      query: "x",
      hits: baseHits,
      redis,
      reranker: r2,
    });
    expect(r2.rerank).not.toHaveBeenCalled();
    expect(out[0]!.path).toBe("/b.pdf"); // same ordering as the cached run
  });

  it("survives reranker errors by returning unsorted input", async () => {
    const redis = makeMockRedis();
    const r = {
      rerank: vi.fn(async () => {
        throw new Error("backend down");
      }),
    };
    const out = await rerankPassages({
      query: "x",
      hits: baseHits,
      redis,
      reranker: r,
    });
    expect(out).toEqual(baseHits); // pass-through unchanged
  });

  it("survives Redis read errors and still rer-anks via the backend", async () => {
    const redis = {
      get: vi.fn(async () => {
        throw new Error("redis read down");
      }),
      setex: vi.fn(async () => "OK" as const),
    };
    const r = makeMockReranker([0.2, 0.9, 0.5]);
    const out = await rerankPassages({
      query: "x",
      hits: baseHits,
      redis,
      reranker: r,
    });
    expect(out[0]!.path).toBe("/b.pdf");
    expect(r.rerank).toHaveBeenCalledTimes(1);
  });

  it("survives Redis write errors and still returns ranked output", async () => {
    const redis = {
      get: vi.fn(async () => null),
      setex: vi.fn(async () => {
        throw new Error("redis write down");
      }),
    };
    const r = makeMockReranker([0.2, 0.9, 0.5]);
    const out = await rerankPassages({
      query: "x",
      hits: baseHits,
      redis,
      reranker: r,
    });
    expect(out[0]!.path).toBe("/b.pdf");
  });
});

describe("searchHybrid with reranker", () => {
  it("reranks fused candidates and returns top-K", async () => {
    const prisma = {
      $queryRawUnsafe: vi
        .fn()
        // vector arm
        .mockResolvedValueOnce([
          {
            source: "nextcloud",
            path: "/a.pdf",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
            metadata: null,
            snippet: "alpha",
            score: 0.9,
          },
          {
            source: "nextcloud",
            path: "/b.pdf",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
            metadata: null,
            snippet: "beta",
            score: 0.8,
          },
        ])
        // lexical arm
        .mockResolvedValueOnce([
          {
            source: "nextcloud",
            path: "/c.pdf",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
            metadata: null,
            snippet: "gamma",
            score: 0.7,
          },
        ]),
    } as never;
    const redis = makeMockRedis();
    // RRF: /a in vector arm at rank 0 (score 1/60), /b at rank 1 (1/61),
    // /c in lexical arm at rank 0 (1/60). Tied 1/60 between /a and /c;
    // map iteration order keeps /a first since it was inserted first.
    // RRF candidate order: /a, /c, /b. Reranker returns [0.3, 0.9, 0.5]
    // for that ordering, so the rerank sort produces: /c (0.9), /b (0.5),
    // /a (0.3).
    const reranker = makeMockReranker([0.3, 0.9, 0.5]);
    const hits = await searchHybrid(prisma, {
      userId: "alice",
      vector: new Array(384).fill(0.01),
      query: "hello",
      limit: 10,
      rerank: { redis, reranker, candidates: 50 },
    });
    expect(hits.map((h) => h.path)).toEqual(["/c.pdf", "/b.pdf", "/a.pdf"]);
    expect(hits[0]!.score).toBe(0.9);
    expect(reranker.rerank).toHaveBeenCalledTimes(1);
  });

  it("falls back to RRF top-K when reranker errors", async () => {
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
        ])
        .mockResolvedValueOnce([]),
    } as never;
    const redis = makeMockRedis();
    const reranker = {
      rerank: vi.fn(async () => {
        throw new Error("ai-gateway unreachable");
      }),
    };
    const hits = await searchHybrid(prisma, {
      userId: "alice",
      vector: new Array(384).fill(0.01),
      query: "hello",
      limit: 10,
      rerank: { redis, reranker },
    });
    // RRF candidate set survives because rerankPassages pass-throughs on error.
    expect(hits.map((h) => h.path)).toEqual(["/a.pdf"]);
  });
});

describe("file-search anchor surfacing", () => {
  it("surfaces a valid metadata.anchor as a top-level anchor field", async () => {
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: 4, brainItemId: null,
      metadata: { anchor: { kind: "pdf-page", page: 4 } },
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toEqual({ kind: "pdf-page", page: 4 });
  });

  it("returns anchor:null when metadata.anchor is malformed, logs a warning, does not drop the hit", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: null, brainItemId: null,
      metadata: { anchor: { kind: "pdf-page", page: 0 } },  // page must be >= 1
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toBeNull();
    expect(hits.length).toBe(1);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("returns anchor:null cleanly when metadata.anchor is missing (legacy row)", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fakeRow = {
      ncFileId: "f1", chunkIdx: 0, score: 0.9, chunkText: "x",
      source: "brain", path: "/x.pdf", pageNumber: null, brainItemId: null,
      metadata: { chain: ["wrap.zip"] },  // WARP-214 metadata, but no anchor
    };
    const hits = shapeHitsForResponse([fakeRow] as any);
    expect(hits[0].anchor).toBeNull();
    expect(hits.length).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

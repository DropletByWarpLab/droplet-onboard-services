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

/**
 * WARP-2193 — a prisma fake that can serve the vector arm.
 *
 * `searchByVector` now runs its SELECT inside an interactive transaction, so
 * its `SET LOCAL hnsw.ef_search` is scoped rather than silently discarded.
 * Two consequences for the fakes in this file:
 *
 *  1. Anything that reaches the vector arm needs `$transaction`. This fake
 *     hands back ITSELF as the transaction client, so every existing
 *     assertion against `$queryRawUnsafe.mock.calls` keeps working. The
 *     "did the SET LOCAL and the SELECT really share one transaction"
 *     question is pinned properly in src/__tests__/file-search.service.test.ts,
 *     which is where it belongs; this file is about fusion and reranking.
 *
 *  2. The two hybrid arms no longer reach `$queryRawUnsafe` in a fixed
 *     order: the vector arm awaits its SET LOCAL first, which yields, and
 *     the lexical arm's query lands before it. Fakes that answered "first
 *     call = vector, second call = lexical" were pinning a scheduling
 *     accident. They now dispatch on SQL SHAPE, which is what they meant and
 *     is order-independent.
 */
function fakePrisma(
  respond: (sql: string, ...args: unknown[]) => unknown[] | Promise<unknown[]>,
) {
  const client: Record<string, unknown> = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) =>
      respond(sql, ...args),
    ),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
  };
  return client as never;
}

/** The vector arm's SQL is the only shape carrying a `::vector` literal. */
function isVectorArm(sql: string): boolean {
  return sql.includes("::vector");
}

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

  // WARP-1140 — the Files search route passes the shared-household corpus as
  // an extra owner; single-owner calls keep the historic $1/$2/… positions.
  it("expands the user filter to an IN list for additionalUserIds", async () => {
    const prisma = mockPrisma([]);
    await searchByLexical(prisma, {
      userId: "alice",
      additionalUserIds: ["__household__"],
      query: "hello",
      limit: 5,
      source: "nextcloud",
    });
    const call = (
      prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } }
    ).$queryRawUnsafe.mock.calls[0]!;
    const sql = call[0] as string;
    expect(sql).toContain('"userId" IN ($1, $2)');
    expect(sql).toContain("websearch_to_tsquery('english', $3)");
    expect(sql).toContain('source = $4::"FileContentSource"');
    expect(call.slice(1)).toEqual([
      "alice",
      "__household__",
      "hello",
      "nextcloud",
      5,
    ]);
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
    const prisma = fakePrisma((sql) => (isVectorArm(sql) ? vectorRows : lexicalRows));
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
    const prisma = fakePrisma((sql) =>
      isVectorArm(sql)
        ? [
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
          ]
        : [],
    );
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
    // WARP-1637: the raw logit is normalized on the way OUT. The ranking is
    // unchanged (sigmoid is monotonic) — only the scale is, and the hit now
    // says which scale it is in so the renderer stops inferring.
    expect(out[0]!.score).toBeCloseTo(1 / (1 + Math.exp(-0.9)), 10);
    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
    expect(r.rerank).toHaveBeenCalledTimes(1);
    // The CACHE still stores raw logits — normalization happens once, on read.
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      JSON.stringify([0.1, 0.9, 0.2]),
    );
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
    // WARP-1637: pass-through leaves the NUMBERS untouched but tags the scale
    // — the incoming RRF weights are already bounded, so saying so beats
    // leaving the renderer to infer it.
    expect(out.map((h) => h.score)).toEqual(baseHits.map((h) => h.score));
    expect(out.map((h) => h.path)).toEqual(baseHits.map((h) => h.path));
    expect(out.every((h) => h.scoreKind === "similarity")).toBe(true);
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
    const prisma = fakePrisma((sql) =>
      isVectorArm(sql)
        ? [
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
          ]
        : [
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
          ],
    );
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
    // WARP-1637: normalized + tagged, same as rerankPassages above.
    expect(hits[0]!.score).toBeCloseTo(1 / (1 + Math.exp(-0.9)), 10);
    expect(hits.every((h) => h.scoreKind === "similarity")).toBe(true);
    expect(reranker.rerank).toHaveBeenCalledTimes(1);
  });

  it("falls back to RRF top-K when reranker errors", async () => {
    const prisma = fakePrisma((sql) =>
      isVectorArm(sql)
        ? [
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
          ]
        : [],
    );
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

describe("searchHybrid with queryEnhancement (WARP-437)", () => {
  function mkRow(path: string, chunkIdx: number, score = 0.9) {
    return {
      source: "nextcloud" as const,
      path,
      chunkIdx,
      pageNumber: null,
      brainItemId: null,
      metadata: null,
      snippet: "snippet",
      score,
    };
  }

  it("averages HyDE passage embedding with raw query vector before vector arm", async () => {
    const captured: { sql: string; args: unknown[] }[] = [];
    const prisma = fakePrisma((sql, ...args) => {
      captured.push({ sql, args });
      return [];
    });

    await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0, 0, 0],
      query: "x",
      queryEnhancement: { hydeVector: [0, 1, 0, 0, 0] },
    });

    // Element-wise mean of [1,0,0,0,0] and [0,1,0,0,0] = [0.5,0.5,0,0,0].
    const vectorSql = captured.find((c) => c.sql.includes("::vector"));
    expect(vectorSql).toBeDefined();
    expect(vectorSql!.sql).toContain("[0.5,0.5,0,0,0]");
  });

  it("silently drops HyDE term when its length differs from raw vector", async () => {
    const captured: { sql: string; args: unknown[] }[] = [];
    const prisma = fakePrisma((sql, ...args) => {
      captured.push({ sql, args });
      return [];
    });
    await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0, 0, 0],
      query: "x",
      queryEnhancement: { hydeVector: [1, 2, 3] }, // wrong dimension
    });
    const vectorSql = captured.find((c) => c.sql.includes("::vector"));
    expect(vectorSql!.sql).toContain("[1,0,0,0,0]");
  });

  it("fans out vector arms across raw + extra queries and RRF-fuses them first", async () => {
    // 3 vector arms (raw + 2 extras) + 1 lexical arm → 4 $queryRawUnsafe calls.
    // Match by SQL shape (vector arms include '::vector', lexical does not).
    const prisma = fakePrisma((sql) => {
      if (!isVectorArm(sql)) return []; // lexical arm
      if (sql.includes("[1,0,0]")) return [mkRow("doc-a", 0)];
      if (sql.includes("[0,1,0]")) return [mkRow("doc-b", 1)];
      if (sql.includes("[0,0,1]")) return [mkRow("doc-c", 2)];
      return [];
    });

    const out = await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      query: "x",
      queryEnhancement: {
        extraQueryVectors: [
          [0, 1, 0],
          [0, 0, 1],
        ],
      },
    });
    const paths = out.map((h) => h.path);
    expect(paths).toEqual(expect.arrayContaining(["doc-a", "doc-b", "doc-c"]));
    expect(
      (prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } })
        .$queryRawUnsafe.mock.calls,
    ).toHaveLength(4);
  });

  it("applies filenameContains to both arms' SQL with parameterised LIKE", async () => {
    const captured: { sql: string; args: unknown[] }[] = [];
    const prisma = fakePrisma((sql, ...args) => {
      captured.push({ sql, args });
      return [];
    });
    await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      query: "settings",
      queryEnhancement: { metadataFilter: { filenameContains: "camera-1" } },
    });
    const arms = captured.filter((c) => /path LIKE \$\d+/.test(c.sql));
    expect(arms.length).toBe(2);
    // Both arms must bind the wrapped LIKE pattern as a positional param.
    for (const arm of arms) {
      expect(arm.args).toContain("%camera-1%");
    }
  });

  it("no-enhancement path is equivalent to single vector + single lexical arm", async () => {
    const prisma = fakePrisma((sql) =>
      isVectorArm(sql) ? [mkRow("a", 0)] : [mkRow("b", 0)],
    );
    const out = await searchHybrid(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      query: "x",
    });
    // 1 vector + 1 lexical = exactly 2 SQL calls.
    expect(
      (prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } })
        .$queryRawUnsafe.mock.calls,
    ).toHaveLength(2);
    expect(out.map((h) => h.path).sort()).toEqual(["a", "b"]);
  });
});

// ── WARP-242: decrypt-on-read + crypto-shred ──
//
// End-to-end at the unit level: chunks encrypted under a real per-document
// DEK (minted through document-key.service against an in-memory
// DocumentEncryptionKey table) must decrypt on read; once the DEK is
// crypto-shredded the SAME ciphertext must become unreadable and the hit
// must be DROPPED — never surfaced as base64 garbage.
import { searchByVector, decryptChunkRows, CHUNK_SNIPPET_CHARS } from "./file-search.service.js";
import { encryptColumn, __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import { getOrCreateDek, shredDocumentKey } from "./document-key.service.js";

describe("WARP-242 decrypt-on-read + crypto-shred", () => {
  __setColumnCryptoKeyForTest(Buffer.alloc(32, 42).toString("base64"));

  type DekRow = { keyId: string; version: number; wrappedDek: string };

  /** Mock prisma: $queryRawUnsafe serves whatever is in the mutable
   *  `chunkRows` array (push rows after minting DEKs — no mock
   *  reassignment, which CI's tsc rejects); the documentEncryptionKey
   *  table is a live in-memory store so the real mint/unwrap/shred code
   *  paths run. */
  function mockPrisma() {
    const deks: DekRow[] = [];
    const chunkRows: unknown[] = [];
    // WARP-2193: searchByVector runs its SELECT inside an interactive
    // transaction (so its `SET LOCAL hnsw.ef_search` is not a no-op), so the
    // fake has to hand back a transaction client. It hands back ITSELF —
    // this suite is about decrypt-on-read, not about transaction scoping,
    // which src/__tests__/file-search.service.test.ts pins properly.
    const client: Record<string, unknown> = {
      __chunkRows: chunkRows,
      $queryRawUnsafe: vi.fn(async () => chunkRows),
      $executeRawUnsafe: vi.fn(async () => 0),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(client),
      ),
      documentEncryptionKey: {
        findFirst: async ({ where: { keyId } }: any) =>
          deks.filter((r) => r.keyId === keyId).sort((a, b) => b.version - a.version)[0] ??
          null,
        create: async ({ data }: any) => {
          deks.push(data);
          return data;
        },
        findMany: async ({ where: { keyId } }: any) =>
          deks.filter((r) => (keyId.in as string[]).includes(r.keyId)),
        deleteMany: async ({ where: { keyId } }: any) => {
          const ids: string[] = typeof keyId === "string" ? [keyId] : keyId.in;
          for (let i = deks.length - 1; i >= 0; i--) {
            if (ids.includes(deks[i]!.keyId)) deks.splice(i, 1);
          }
        },
      },
    };
    return client as unknown as import("@prisma/client").PrismaClient & {
      __chunkRows: unknown[];
    };
  }

  function encRow(itemId: string, blob: string) {
    return {
      source: "brain",
      path: `/brain/${itemId}`,
      chunkIdx: 0,
      pageNumber: null,
      brainItemId: itemId,
      metadata: null,
      snippet: blob,
      score: 0.9,
    };
  }

  it("decrypts encrypted brain hits and re-truncates to the snippet width", async () => {
    const prisma = mockPrisma();
    const dek = await getOrCreateDek(prisma, "brain:item1");
    const longText = "secret attachment body ".repeat(30); // > snippet width
    const blob = encryptColumn(dek, longText, "brain:item1");
    prisma.__chunkRows.push(encRow("item1", blob));

    const hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet.startsWith("secret attachment body")).toBe(true);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(CHUNK_SNIPPET_CHARS);
    expect(hits[0]!.snippet).not.toContain("dcv1:");
  });

  it("CRYPTO-SHRED: after the DEK is deleted, the ciphertext hit is dropped (unreadable)", async () => {
    const prisma = mockPrisma();
    const dek = await getOrCreateDek(prisma, "brain:item1");
    const blob = encryptColumn(dek, "right-to-delete payload", "brain:item1");
    prisma.__chunkRows.push(encRow("item1", blob));

    // Readable before the shred…
    let hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBe("right-to-delete payload");

    // …unreadable after: same ciphertext rows, DEK gone.
    await shredDocumentKey(prisma, "brain:item1");
    hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(0);
  });

  it("plaintext rows pass through without touching the DEK table", async () => {
    const bare: Record<string, unknown> = {
      $queryRawUnsafe: vi.fn(async () => [
        { ...encRow("x", "plain snippet"), brainItemId: null, source: "nextcloud" },
      ]),
      $executeRawUnsafe: vi.fn(async () => 0),
      // WARP-2193: the vector SELECT runs inside an interactive transaction.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(bare),
      ),
      // No documentEncryptionKey table at all — must not be needed.
    };
    const prisma = bare as never;
    const hits = await searchByVector(prisma, {
      userId: "u1",
      vector: [1, 0, 0],
      limit: 10,
      minSimilarity: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toBe("plain snippet");
  });

  it("decryptChunkRows decrypts full text and drops rows whose DEK is missing", async () => {
    const prisma = mockPrisma();
    const dek = await getOrCreateDek(prisma, "brain:keep");
    const keepBlob = encryptColumn(dek, "full readable body", "brain:keep");
    const strayBlob = encryptColumn(dek, "shredded body", "brain:gone"); // no DEK row for brain:gone

    const rows = await decryptChunkRows(prisma, [
      { text: keepBlob, brainItemId: "keep", path: "/a" },
      { text: strayBlob, brainItemId: "gone", path: "/b" },
      { text: "already plaintext", brainItemId: null, path: "/c" },
    ]);
    expect(rows.map((r) => r.text)).toEqual(["full readable body", "already plaintext"]);
  });
});

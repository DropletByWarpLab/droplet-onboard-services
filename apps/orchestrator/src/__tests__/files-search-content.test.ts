/**
 * WARP-880 / WS-2 — keyword + hybrid mode on `GET /api/files/search/content`.
 *
 * The lexical/hybrid full-text engine already shipped under WARP-286
 * (`FileContentChunk.text_tsv` + `searchByLexical`/`searchHybrid` in
 * `file-search.service.ts`). WS-2 is pure wiring: surface those modes on
 * the Files-page content-search route. This route embeds through
 * `ai-gateway.grpc-client.js` (NOT `embedding.client.js`), so that is the
 * module we mock here.
 *
 * Mode matrix:
 *   - `keyword`  → `searchByLexical`, NEVER touches the gRPC embed. Works
 *                  when the AI gateway is down (the headline win).
 *   - `hybrid`   → embed once, then `searchHybrid` (no rerank pipe).
 *   - `semantic` (or omitted) → the existing inline DISTINCT ON pgvector
 *                  SQL, unchanged (regression lock).
 *   - anything else → 400.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    FRIGATE_URL: "http://frigate:5000",
  },
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the module THIS route dynamically imports for embedding: the
// ai-gateway gRPC client. `grpcEmbedText` + `isGrpcAvailable` are the two
// exports the route touches.
// ─────────────────────────────────────────────────────────────────────────
const { grpcEmbedSpy, isGrpcAvailableSpy } = vi.hoisted(() => ({
  grpcEmbedSpy: vi.fn(),
  isGrpcAvailableSpy: vi.fn(),
}));

vi.mock("../services/ai-gateway.grpc-client.js", () => ({
  grpcEmbedText: (...args: unknown[]) => grpcEmbedSpy(...args),
  isGrpcAvailable: (...args: unknown[]) => isGrpcAvailableSpy(...args),
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the lexical/hybrid engine (already shipped, WARP-286).
// ─────────────────────────────────────────────────────────────────────────
const { searchByLexicalSpy, searchHybridSpy } = vi.hoisted(() => ({
  searchByLexicalSpy: vi.fn(),
  searchHybridSpy: vi.fn(),
}));

vi.mock("../services/file-search.service.js", () => ({
  searchByLexical: (...args: unknown[]) => searchByLexicalSpy(...args),
  searchHybrid: (...args: unknown[]) => searchHybridSpy(...args),
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the cache so we can assert key isolation across modes. The real
// cache.service no-ops when REDIS_URL is unset, so a spy is the only way
// to observe the composed cache key.
// ─────────────────────────────────────────────────────────────────────────
const { cacheGetSpy, cacheSetSpy } = vi.hoisted(() => ({
  cacheGetSpy: vi.fn(),
  cacheSetSpy: vi.fn(),
}));

vi.mock("../services/cache.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/cache.service.js")>();
  return {
    ...actual,
    cacheGet: (...args: unknown[]) => cacheGetSpy(...args),
    cacheSet: (...args: unknown[]) => cacheSetSpy(...args),
  };
});

// ─────────────────────────────────────────────────────────────────────────
// Replace the @prisma/client mock so the semantic branch's raw pgvector
// SQL (`$queryRawUnsafe`) is observable + controllable.
// ─────────────────────────────────────────────────────────────────────────
const { queryRawUnsafeMock } = vi.hoisted(() => ({
  queryRawUnsafeMock: vi.fn(),
}));

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $queryRawUnsafe: queryRawUnsafeMock,
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    clientVersion: string;
    constructor(message: string, opts: { code: string; clientVersion: string }) {
      super(message);
      this.code = opts.code;
      this.clientVersion = opts.clientVersion;
    }
  }
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

describe("GET /api/files/search/content — mode matrix (WARP-880)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    grpcEmbedSpy.mockReset();
    isGrpcAvailableSpy.mockReset();
    searchByLexicalSpy.mockReset();
    searchHybridSpy.mockReset();
    queryRawUnsafeMock.mockReset();
    cacheGetSpy.mockReset();
    cacheSetSpy.mockReset();
    // Default: cache miss + accepted write, gateway up.
    cacheGetSpy.mockResolvedValue(null);
    cacheSetSpy.mockResolvedValue(undefined);
    isGrpcAvailableSpy.mockReturnValue(true);
  });

  // ── 1. keyword calls searchByLexical, never the gRPC embed ──────────────
  it("keyword mode calls searchByLexical and never the gRPC embed", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/a.txt", score: 0.9, snippet: "alpha snippet", source: "nextcloud", chunkIdx: 0 },
    ]);

    const res = await request(app).get("/api/files/search/content?q=alpha&mode=keyword");

    expect(res.status).toBe(200);
    expect(searchByLexicalSpy).toHaveBeenCalledTimes(1);
    expect(grpcEmbedSpy).not.toHaveBeenCalled();
    expect(isGrpcAvailableSpy).not.toHaveBeenCalled();
    expect(res.body.results[0]).toEqual({ path: "/Docs/a.txt", score: 0.9, text: "alpha snippet" });
    // source pinned to nextcloud; userId forwarded
    const params = searchByLexicalSpy.mock.calls[0][1];
    expect(params.source).toBe("nextcloud");
    expect(params.query).toBe("alpha");
  });

  // ── 2. keyword works when gateway down; semantic 503s in same condition ─
  it("keyword returns 200 when the gateway is down, while semantic returns 503", async () => {
    isGrpcAvailableSpy.mockReturnValue(false);
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/b.txt", score: 0.5, snippet: "beta", source: "nextcloud", chunkIdx: 0 },
    ]);

    const keywordRes = await request(app).get("/api/files/search/content?q=beta&mode=keyword");
    expect(keywordRes.status).toBe(200);
    expect(keywordRes.body.results).toHaveLength(1);

    const semanticRes = await request(app).get("/api/files/search/content?q=beta&mode=semantic");
    expect(semanticRes.status).toBe(503);
  });

  // ── 3. hybrid embeds once, then searchHybrid with source:nextcloud ──────
  it("hybrid embeds once then calls searchHybrid with source nextcloud", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    searchHybridSpy.mockResolvedValueOnce([
      { path: "/Docs/c.txt", score: 0.8, snippet: "gamma", source: "nextcloud", chunkIdx: 0 },
    ]);

    const res = await request(app).get("/api/files/search/content?q=gamma&mode=hybrid");

    expect(res.status).toBe(200);
    expect(grpcEmbedSpy).toHaveBeenCalledTimes(1);
    expect(searchHybridSpy).toHaveBeenCalledTimes(1);
    const params = searchHybridSpy.mock.calls[0][1];
    expect(params.source).toBe("nextcloud");
    expect(params.vector).toEqual([0.1, 0.2, 0.3]);
    expect(params.query).toBe("gamma");
    // no rerank pipe
    expect(params.rerank).toBeUndefined();
    expect(res.body.results[0]).toEqual({ path: "/Docs/c.txt", score: 0.8, text: "gamma" });
  });

  // ── 4. semantic / omitted runs the inline pgvector SQL (regression lock) ─
  it("semantic mode runs the inline pgvector $queryRawUnsafe and never the service helpers", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([[0.4, 0.5, 0.6]]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      { path: "/Docs/d.txt", score: 0.99, text: "delta" },
    ]);

    const res = await request(app).get("/api/files/search/content?q=delta&mode=semantic");

    expect(res.status).toBe(200);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain("DISTINCT ON");
    expect(searchByLexicalSpy).not.toHaveBeenCalled();
    expect(searchHybridSpy).not.toHaveBeenCalled();
    expect(res.body.results[0]).toEqual({ path: "/Docs/d.txt", score: 0.99, text: "delta" });
  });

  it("omitted mode defaults to semantic (inline pgvector SQL)", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([[0.7, 0.8, 0.9]]);
    queryRawUnsafeMock.mockResolvedValueOnce([{ path: "/Docs/e.txt", score: 0.7, text: "epsilon" }]);

    const res = await request(app).get("/api/files/search/content?q=epsilon");

    expect(res.status).toBe(200);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(searchByLexicalSpy).not.toHaveBeenCalled();
  });

  // ── 5. unknown mode → 400 ───────────────────────────────────────────────
  it("rejects an unknown mode with HTTP 400", async () => {
    const res = await request(app).get("/api/files/search/content?q=zed&mode=foo");
    expect(res.status).toBe(400);
    expect(grpcEmbedSpy).not.toHaveBeenCalled();
    expect(searchByLexicalSpy).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  // ── 6. per-file dedupe: 3 chunks across 2 paths → 2 results ─────────────
  it("keyword dedupes per file: 3 chunks across 2 paths yields 2 results, best chunk per path", async () => {
    // Service returns score DESC; first-seen per path is the best chunk.
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/x.txt", score: 0.95, snippet: "best of x", source: "nextcloud", chunkIdx: 2 },
      { path: "/Docs/y.txt", score: 0.80, snippet: "best of y", source: "nextcloud", chunkIdx: 0 },
      { path: "/Docs/x.txt", score: 0.40, snippet: "worse of x", source: "nextcloud", chunkIdx: 7 },
    ]);

    const res = await request(app).get("/api/files/search/content?q=dup&mode=keyword&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results).toEqual([
      { path: "/Docs/x.txt", score: 0.95, text: "best of x" },
      { path: "/Docs/y.txt", score: 0.8, text: "best of y" },
    ]);
    // limit is over-fetched (limit * CHUNKS_PER_FILE_FACTOR) so dedupe has headroom.
    const params = searchByLexicalSpy.mock.calls[0][1];
    expect(params.limit).toBe(10 * 5);
  });

  // ── 7. cache-key isolation: keyword vs semantic never collide ───────────
  it("keyword and semantic use distinct cache keys for the same query", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/k.txt", score: 0.9, snippet: "k", source: "nextcloud", chunkIdx: 0 },
    ]);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([{ path: "/Docs/s.txt", score: 0.9, text: "s" }]);

    await request(app).get("/api/files/search/content?q=same&mode=keyword&limit=20");
    await request(app).get("/api/files/search/content?q=same&mode=semantic&limit=20");

    const keywordGetKey = cacheGetSpy.mock.calls[0][0] as string;
    const semanticGetKey = cacheGetSpy.mock.calls[1][0] as string;
    expect(keywordGetKey).not.toBe(semanticGetKey);
    expect(keywordGetKey).toContain("keyword");
    expect(semanticGetKey).toContain("semantic");
    // cacheSet keys must also differ
    const keywordSetKey = cacheSetSpy.mock.calls[0][0] as string;
    const semanticSetKey = cacheSetSpy.mock.calls[1][0] as string;
    expect(keywordSetKey).not.toBe(semanticSetKey);
  });

  // ── 8. userId forwarded (IDOR isolation) ────────────────────────────────
  it("forwards the authed userId to searchByLexical (per-user isolation)", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([]);
    await request(app).get("/api/files/search/content?q=iso&mode=keyword");
    const params = searchByLexicalSpy.mock.calls[0][1];
    // AUTH_ENABLED=false → stub user "dev"
    expect(params.userId).toBe("dev");
  });
});

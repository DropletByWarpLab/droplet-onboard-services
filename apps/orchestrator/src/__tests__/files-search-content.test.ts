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
import { createTransactionSeam } from "./helpers/prisma-tx-harness.js";
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
    // departments.ts (registered by createApp) derefs this at module scope to
    // build RESERVED_NAMES; the real config zod-defaults it, so the mock must
    // carry it too or module load throws on undefined.toLowerCase(). (WARP-1292)
    DROPLET_SHARED_FOLDER_NAME: "Household",
    FRIGATE_URL: "http://frigate:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the module THIS route dynamically imports for embedding: the
// ai-gateway gRPC client. `grpcEmbedText` + `isGrpcAvailable` are the two
// exports the route touches.
// ─────────────────────────────────────────────────────────────────────────
const { grpcEmbedSpy, isGrpcAvailableSpy, initGrpcClientSpy } = vi.hoisted(() => ({
  grpcEmbedSpy: vi.fn(),
  isGrpcAvailableSpy: vi.fn(),
  initGrpcClientSpy: vi.fn(),
}));

vi.mock("../services/ai-gateway.grpc-client.js", () => ({
  grpcEmbedText: (...args: unknown[]) => grpcEmbedSpy(...args),
  isGrpcAvailable: (...args: unknown[]) => isGrpcAvailableSpy(...args),
  initGrpcClient: (...args: unknown[]) => initGrpcClientSpy(...args),
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
// WARP-940 — keyword mode unions a Nextcloud NAME match (substring) with the
// lexical content hits. Spread the original module so every other route
// registered in createApp keeps its real client; override only ncSearchFiles
// so we can observe the name-search arm without a live Nextcloud.
// ─────────────────────────────────────────────────────────────────────────
const { ncSearchFilesSpy } = vi.hoisted(() => ({
  ncSearchFilesSpy: vi.fn(),
}));

vi.mock("../services/nextcloud.client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/nextcloud.client.js")>();
  return {
    ...actual,
    ncSearchFiles: (...args: unknown[]) => ncSearchFilesSpy(...args),
  };
});

// ─────────────────────────────────────────────────────────────────────────
// WARP-940 — the name arm resolves a per-user Nextcloud token via
// `resolveNcToken`. Stub it so we can drive the "missing NC session" path
// (returns null → getToken throws MissingNcTokenError → 401) independently
// of a live cookie/Redis. Default mirrors the AUTH_ENABLED=false dev token.
// ─────────────────────────────────────────────────────────────────────────
const { resolveNcTokenSpy } = vi.hoisted(() => ({
  resolveNcTokenSpy: vi.fn(),
}));

vi.mock("../services/nextcloud-session.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/nextcloud-session.service.js")
    >();
  return {
    ...actual,
    resolveNcToken: (...args: unknown[]) => resolveNcTokenSpy(...args),
  };
});

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

const { departmentFindManyMock, departmentMembershipFindManyMock } = vi.hoisted(() => ({
  departmentFindManyMock: vi.fn(),
  departmentMembershipFindManyMock: vi.fn(),
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
    // WARP-1264: deptSearchCorpora. AUTH_ENABLED=false stubs req.user as
    // role="owner" (see authMiddleware), so every test in this file drives
    // the owner/admin branch — `department.findMany({state:"active"})` —
    // never `departmentMembership.findMany`.
    department: { findMany: departmentFindManyMock },
    departmentMembership: { findMany: departmentMembershipFindManyMock },
    // Full-app suite: the module gate on the `/api/files` mount reads
    // ModuleSetting overrides. `[]` => registry defaults (files is
    // default-enabled) => gate passes.
    moduleSetting: {
      findMany: vi.fn().mockResolvedValue([]),
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
  // WARP-1583: the T3 effective-access resolver composes its reads inside ONE
  // RepeatableRead transaction, and app.ts mounts requireFeatureAccess on this
  // module's prefix — so a stub without `$transaction` makes the gate fail
  // closed and every route here 404s. Shared seam (WARP-1570) rather than
  // `(fn) => fn(self)`, which would drop the isolation option and hide a
  // regression that removed it.
  (mockPrisma as { $transaction?: unknown }).$transaction = createTransactionSeam({
    client: () => mockPrisma,
  }).$transaction;

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
    ncSearchFilesSpy.mockReset();
    // Default: cache miss + accepted write, gateway up.
    cacheGetSpy.mockResolvedValue(null);
    cacheSetSpy.mockResolvedValue(undefined);
    isGrpcAvailableSpy.mockReturnValue(true);
    // WARP-1914: the route lazily initializes the client. Mirror the real
    // contract — initGrpcClient() resolves to the availability state — so
    // "gateway down" specs keep driving both seams with one spy.
    initGrpcClientSpy.mockReset();
    initGrpcClientSpy.mockImplementation(async () => isGrpcAvailableSpy());
    // Default: no name matches — keep existing content-only specs unchanged.
    ncSearchFilesSpy.mockResolvedValue([]);
    // Default: caller (dev/owner) is visible into NO active departments →
    // personal corpus only (the pre-WARP-1264 behaviour every older spec
    // was written against).
    departmentFindManyMock.mockReset();
    departmentMembershipFindManyMock.mockReset();
    departmentFindManyMock.mockResolvedValue([]);
    departmentMembershipFindManyMock.mockResolvedValue([]);
    resolveNcTokenSpy.mockReset();
    // Default: a valid NC session token is present (mirrors dev-mode).
    resolveNcTokenSpy.mockResolvedValue("dev-mode-token");
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

    const getKeys = cacheGetSpy.mock.calls.map((c) => c[0] as string);
    const keywordGetKey = getKeys.find((k) => k.includes(":keyword:"));
    const semanticGetKey = getKeys.find((k) => k.includes(":semantic:"));
    expect(keywordGetKey).toBeDefined();
    expect(semanticGetKey).toBeDefined();
    expect(keywordGetKey).not.toBe(semanticGetKey);
    // cacheSet keys must also differ
    const setKeys = cacheSetSpy.mock.calls.map((c) => c[0] as string);
    const keywordSetKey = setKeys.find((k) => k.includes(":keyword:"));
    const semanticSetKey = setKeys.find((k) => k.includes(":semantic:"));
    expect(keywordSetKey).toBeDefined();
    expect(semanticSetKey).toBeDefined();
    expect(keywordSetKey).not.toBe(semanticSetKey);
  });

  // ── WARP-1264: versioned cache key busts on an aclVersion bump ──────────
  it("bumping aclVersion on a visible department changes the semantic cache key even though the corpus set is unchanged", async () => {
    departmentFindManyMock.mockResolvedValueOnce([
      { id: "dept-1", kind: "DEPARTMENT", aclVersion: 1 },
    ]);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await request(app).get("/api/files/search/content?q=vbump&mode=semantic");

    departmentFindManyMock.mockResolvedValueOnce([
      { id: "dept-1", kind: "DEPARTMENT", aclVersion: 2 },
    ]);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await request(app).get("/api/files/search/content?q=vbump&mode=semantic");

    const getKeys = cacheGetSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((k) => k.includes(":semantic:") && k.includes(":vbump:"));
    expect(getKeys).toHaveLength(2);
    expect(getKeys[0]).not.toBe(getKeys[1]);
    expect(getKeys[0]).toContain(":v1:");
    expect(getKeys[1]).toContain(":v2:");
  });

  // ── 8. userId forwarded (IDOR isolation) ────────────────────────────────
  it("forwards the authed userId to searchByLexical (per-user isolation)", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([]);
    await request(app).get("/api/files/search/content?q=iso&mode=keyword");
    const params = searchByLexicalSpy.mock.calls[0][1];
    // AUTH_ENABLED=false → stub user "dev"
    expect(params.userId).toBe("dev");
  });

  // ── WARP-940: keyword mode must also match by file NAME ──────────────────
  //
  // The reported bug: searching "const" returns nothing under Keyword even
  // though a "Construction Consulting Proposal" PDF is in view. Keyword was
  // wired ONLY to the lexical content engine (searchByLexical over
  // FileContentChunk.text_tsv), which (a) never looks at the file name and
  // (b) is whole-lexeme FTS so "const" ≠ "construction" even in content. The
  // Nextcloud name arm (ncSearchFiles) already does a `%substring%` match, so
  // keyword unions it in to honour the AC: "files whose name and/or content
  // contain the term".

  it("keyword surfaces a file matched by NAME even when content has no lexical hit", async () => {
    // No content hits — mirrors a PDF whose body never tokenises to "const".
    searchByLexicalSpy.mockResolvedValueOnce([]);
    // Nextcloud name search finds the file by substring on its display name.
    ncSearchFilesSpy.mockResolvedValueOnce([
      {
        name: "Construction Consulting Proposal.pdf",
        path: "/Docs/Construction Consulting Proposal.pdf",
        isDirectory: false,
        size: 12345,
        mimeType: "application/pdf",
        modifiedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=const&mode=keyword",
    );

    expect(res.status).toBe(200);
    expect(ncSearchFilesSpy).toHaveBeenCalledTimes(1);
    const paths = res.body.results.map((r: { path: string }) => r.path);
    expect(paths).toContain("/Docs/Construction Consulting Proposal.pdf");
  });

  it("keyword unions name + content hits and dedupes a file matched by both", async () => {
    // Same file matched by content AND name → must appear exactly once.
    searchByLexicalSpy.mockResolvedValueOnce([
      {
        path: "/Docs/Construction Consulting Proposal.pdf",
        score: 0.9,
        snippet: "…construction phase scheduling…",
        source: "nextcloud",
        chunkIdx: 0,
      },
    ]);
    ncSearchFilesSpy.mockResolvedValueOnce([
      {
        name: "Construction Consulting Proposal.pdf",
        path: "/Docs/Construction Consulting Proposal.pdf",
        isDirectory: false,
        size: 1,
        mimeType: "application/pdf",
        modifiedAt: "2026-06-01T00:00:00.000Z",
      },
      {
        name: "constants.txt",
        path: "/Docs/constants.txt",
        isDirectory: false,
        size: 2,
        mimeType: "text/plain",
        modifiedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=const&mode=keyword&limit=20",
    );

    expect(res.status).toBe(200);
    const paths = res.body.results.map((r: { path: string }) => r.path);
    // The PDF (matched by both arms) appears once; the name-only file is added.
    expect(paths.filter((p: string) => p === "/Docs/Construction Consulting Proposal.pdf")).toHaveLength(1);
    expect(paths).toContain("/Docs/constants.txt");
  });

  it("keyword name arm targets file names (directories excluded) for the authed user", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([]);
    ncSearchFilesSpy.mockResolvedValueOnce([]);
    await request(app).get("/api/files/search/content?q=const&mode=keyword");
    expect(ncSearchFilesSpy).toHaveBeenCalledTimes(1);
    // ncSearchFiles(token, user, opts) — user + query forwarded.
    const call = ncSearchFilesSpy.mock.calls[0];
    expect(call[1]).toBe("dev"); // AUTH_ENABLED=false → stub user
    expect(call[2]).toMatchObject({ query: "const" });
    // WARP-940: over-fetch the name arm too. parseMultiStatus sorts dirs
    // first and nameHitsToResults drops them, so without headroom a
    // directory-heavy match yields 0 file results. Mirror the content arm's
    // CHUNKS_PER_FILE_FACTOR (default limit 20 → 100).
    expect(call[2].limit).toBe(20 * 5);
  });

  // ── WARP-940 hardening (pr-reviewer findings) ───────────────────────────

  it("does NOT poison the cache when the name arm degrades (Nextcloud down)", async () => {
    // Content arm has fewer than `limit` hits, so the name arm runs and fails.
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/notes.txt", score: 0.7, snippet: "alpha", source: "nextcloud", chunkIdx: 0 },
    ]);
    ncSearchFilesSpy.mockRejectedValueOnce(new Error("nextcloud unreachable"));

    const res = await request(app).get(
      "/api/files/search/content?q=alpha&mode=keyword&limit=20",
    );

    // Request still succeeds (content-only degrade) …
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: { path: string }) => r.path)).toContain(
      "/Docs/notes.txt",
    );
    // … but the degraded, content-only union must NOT be written to the 60s
    // cache, or it would serve stale results after Nextcloud recovers.
    const resultSetKeys = cacheSetSpy.mock.calls.map((c) => c[0] as string);
    expect(resultSetKeys).toHaveLength(0);
  });

  it("re-throws a missing Nextcloud session as 401 (auth failure ≠ degrade)", async () => {
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/notes.txt", score: 0.7, snippet: "alpha", source: "nextcloud", chunkIdx: 0 },
    ]);
    // No NC token AT ALL for this session → getToken throws
    // MissingNcTokenError. This is an auth failure, not an outage: it must
    // propagate (401), not silently degrade. (mockResolvedValue, not Once:
    // the WARP-1140 household probe also resolves the token — swallowing its
    // own failure — before the name arm re-resolves it and 401s.)
    resolveNcTokenSpy.mockResolvedValue(null);

    const res = await request(app).get(
      "/api/files/search/content?q=alpha&mode=keyword&limit=20",
    );

    expect(res.status).toBe(401);
    // A 401 must never be cached.
    expect(cacheSetSpy).not.toHaveBeenCalled();
    // The name arm never fired — the token resolution failed first.
    expect(ncSearchFilesSpy).not.toHaveBeenCalled();
  });

  it("skips the name arm entirely when content hits already fill the limit", async () => {
    // limit=2 and the content arm returns 2 distinct files → name arm would
    // only produce results that get discarded, so don't pay the WebDAV cost.
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/a.txt", score: 0.9, snippet: "a", source: "nextcloud", chunkIdx: 0 },
      { path: "/Docs/b.txt", score: 0.8, snippet: "b", source: "nextcloud", chunkIdx: 0 },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=const&mode=keyword&limit=2",
    );

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(ncSearchFilesSpy).not.toHaveBeenCalled();
  });

  it("keyword still returns content hits when the name arm (Nextcloud) is down", async () => {
    // Lexical content arm works gateway/Nextcloud-down; a failing name search
    // must NOT take down the whole keyword response.
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/notes.txt", score: 0.7, snippet: "alpha", source: "nextcloud", chunkIdx: 0 },
    ]);
    ncSearchFilesSpy.mockRejectedValueOnce(new Error("nextcloud unreachable"));

    const res = await request(app).get(
      "/api/files/search/content?q=alpha&mode=keyword",
    );

    expect(res.status).toBe(200);
    const paths = res.body.results.map((r: { path: string }) => r.path);
    expect(paths).toContain("/Docs/notes.txt");
  });

  it("semantic mode does NOT run the name arm (keyword-only behaviour)", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([{ path: "/Docs/s.txt", score: 0.9, text: "s" }]);
    await request(app).get("/api/files/search/content?q=same&mode=semantic");
    expect(ncSearchFilesSpy).not.toHaveBeenCalled();
  });

  // ── WARP-1139/WARP-1140: semantic corpus + household inclusion ──────────

  it("semantic pins the corpus to source=nextcloud (brain chunks excluded)", async () => {
    // The unfiltered SQL also matched brain-memory chunks (chat attachments),
    // whose paths aren't navigable from the Files page AND which all share
    // ncFileId=0, so DISTINCT ON ("ncFileId") collapsed them into one bogus
    // result. The corpus must match keyword/hybrid (source: nextcloud).
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    const res = await request(app).get(
      "/api/files/search/content?q=corpus&mode=semantic",
    );

    expect(res.status).toBe(200);
    const sql = queryRawUnsafeMock.mock.calls[0][0] as string;
    expect(sql).toContain(`"source" = 'nextcloud'`);
  });

  // WARP-1264: HOUSEHOLD is dual-sentinelled during rollout — both the
  // legacy `__household__` sentinel AND its `__dept_<uuid>__` form ride
  // along together so content indexed under either watcher build stays
  // searchable without a reindex.
  it("includes both household sentinel forms in semantic search when the caller is visible into the HOUSEHOLD department", async () => {
    departmentFindManyMock.mockResolvedValueOnce([
      { id: "hh-uuid", kind: "HOUSEHOLD", aclVersion: 3 },
    ]);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      { path: "/Household/Trips/burrito.txt", score: 0.9, text: "burrito notes" },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=burrito&mode=semantic",
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0].path).toBe("/Household/Trips/burrito.txt");
    // Bind args: $1 vector literal, then the corpus owner list, then limit.
    const args = queryRawUnsafeMock.mock.calls[0].slice(1);
    expect(args).toContain("dev");
    expect(args).toContain("__household__");
    expect(args).toContain("__dept_hh-uuid__");
  });

  it("includes both household sentinel forms in keyword search when the caller is visible into the HOUSEHOLD department", async () => {
    departmentFindManyMock.mockResolvedValueOnce([
      { id: "hh-uuid", kind: "HOUSEHOLD", aclVersion: 1 },
    ]);
    searchByLexicalSpy.mockResolvedValueOnce([]);

    await request(app).get("/api/files/search/content?q=burrito&mode=keyword");

    const params = searchByLexicalSpy.mock.calls[0][1];
    expect(params.userId).toBe("dev");
    expect(params.additionalUserIds).toEqual(["__household__", "__dept_hh-uuid__"]);
  });

  it("includes both household sentinel forms in hybrid search when the caller is visible into the HOUSEHOLD department", async () => {
    departmentFindManyMock.mockResolvedValueOnce([
      { id: "hh-uuid", kind: "HOUSEHOLD", aclVersion: 1 },
    ]);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    searchHybridSpy.mockResolvedValueOnce([]);

    await request(app).get("/api/files/search/content?q=burrito&mode=hybrid");

    const params = searchHybridSpy.mock.calls[0][1];
    expect(params.userId).toBe("dev");
    expect(params.additionalUserIds).toEqual(["__household__", "__dept_hh-uuid__"]);
  });

  // WARP-1264: owner/admin see ALL active departments — a non-household one
  // surfaces only its `__dept_<uuid>__` form (no household sentinel).
  it("includes a __dept_<uuid>__ sentinel for a non-household active department (owner sees all)", async () => {
    departmentFindManyMock.mockResolvedValueOnce([
      { id: "fin-uuid", kind: "DEPARTMENT", aclVersion: 2 },
    ]);
    searchByLexicalSpy.mockResolvedValueOnce([]);

    await request(app).get("/api/files/search/content?q=budget&mode=keyword");

    const params = searchByLexicalSpy.mock.calls[0][1];
    expect(params.additionalUserIds).toEqual(["__dept_fin-uuid__"]);
  });

  it("degrades to the personal corpus when the department lookup fails (never a new failure mode)", async () => {
    departmentFindManyMock.mockRejectedValue(new Error("db down"));
    searchByLexicalSpy.mockResolvedValueOnce([
      { path: "/Docs/a.txt", score: 0.9, snippet: "a", source: "nextcloud", chunkIdx: 0 },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=alpha&mode=keyword",
    );

    expect(res.status).toBe(200);
    const params = searchByLexicalSpy.mock.calls[0][1];
    expect(params.additionalUserIds).toEqual([]);
  });

  // ── WARP-1914: semantic must initialize the gRPC client on demand ────────
  //
  // The root cause of "every semantic query 503s": `initGrpcClient()` was
  // never called anywhere at runtime, so `isGrpcAvailable()` reported false
  // forever and the route answered 503 even with a healthy ai-gateway. The
  // route must lazily initialize (idempotent) instead of only reading the
  // never-set availability flag.

  it("semantic mode initializes the gRPC client on demand — a cold orchestrator still serves semantic search (WARP-1914)", async () => {
    // Cold client: never initialized → isGrpcAvailable() is false…
    isGrpcAvailableSpy.mockReturnValue(false);
    // …but an on-demand init succeeds (gateway IS reachable).
    initGrpcClientSpy.mockResolvedValue(true);
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockResolvedValueOnce([
      { path: "/Docs/Dental Hygenists/plan.txt", score: 0.93, text: "dental hygiene plan" },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=dental&mode=semantic",
    );

    expect(initGrpcClientSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.results[0].path).toBe("/Docs/Dental Hygenists/plan.txt");
  });

  it("hybrid mode initializes the gRPC client on demand too (WARP-1914)", async () => {
    isGrpcAvailableSpy.mockReturnValue(false);
    initGrpcClientSpy.mockResolvedValue(true);
    grpcEmbedSpy.mockResolvedValueOnce([[0.4, 0.5, 0.6]]);
    searchHybridSpy.mockResolvedValueOnce([
      { path: "/Docs/h.txt", score: 0.7, snippet: "h", source: "nextcloud", chunkIdx: 0 },
    ]);

    const res = await request(app).get(
      "/api/files/search/content?q=hybrid&mode=hybrid",
    );

    expect(initGrpcClientSpy).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  // ── WARP-1914: semantic failures carry a stable wire code ────────────────
  //
  // The dashboard's translator (`translateError`) NEVER surfaces
  // `err.message`, so without a machine-readable `code` every semantic
  // failure flattened into the generic "We couldn't load those files right
  // now" banner. Each semantic-unavailable answer must carry
  // `code: "semantic_unavailable"` for the client to dispatch on.

  it("answers 503 + code semantic_unavailable when the gateway init fails (WARP-1914)", async () => {
    isGrpcAvailableSpy.mockReturnValue(false);
    initGrpcClientSpy.mockResolvedValue(false);

    const res = await request(app).get(
      "/api/files/search/content?q=dental&mode=semantic",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("semantic_unavailable");
  });

  it("answers 503 + code semantic_unavailable when the embed call rejects (WARP-1914)", async () => {
    grpcEmbedSpy.mockRejectedValueOnce(new Error("UNAVAILABLE: connect failed"));

    const res = await request(app).get(
      "/api/files/search/content?q=dental&mode=semantic",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("semantic_unavailable");
  });

  it("answers 502 + code semantic_unavailable when the embedder returns no vectors (WARP-1914)", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([]);

    const res = await request(app).get(
      "/api/files/search/content?q=dental&mode=semantic",
    );

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("semantic_unavailable");
  });

  it("answers 503 + code semantic_unavailable when pgvector is missing (WARP-1914)", async () => {
    grpcEmbedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
    queryRawUnsafeMock.mockRejectedValueOnce(
      new Error('type "vector" does not exist'),
    );

    const res = await request(app).get(
      "/api/files/search/content?q=dental&mode=semantic",
    );

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("semantic_unavailable");
  });
});

// ── WARP-1139/WARP-1140: GET /api/files/search/status honesty fields ──────
describe("GET /api/files/search/status — explicit indexer state (WARP-1139)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    app = createApp(prisma);
  });

  beforeEach(() => {
    isGrpcAvailableSpy.mockReset();
    queryRawUnsafeMock.mockReset();
    cacheGetSpy.mockReset();
    cacheSetSpy.mockReset();
    departmentFindManyMock.mockReset();
    departmentMembershipFindManyMock.mockReset();
    resolveNcTokenSpy.mockReset();
    cacheGetSpy.mockResolvedValue(null);
    cacheSetSpy.mockResolvedValue(undefined);
    isGrpcAvailableSpy.mockReturnValue(true);
    // WARP-1914: the status probe lazily initializes the client too.
    initGrpcClientSpy.mockReset();
    initGrpcClientSpy.mockImplementation(async () => isGrpcAvailableSpy());
    departmentFindManyMock.mockResolvedValue([]);
    departmentMembershipFindManyMock.mockResolvedValue([]);
    resolveNcTokenSpy.mockResolvedValue("dev-mode-token");
  });

  it("reports pendingCount/failedCount from FileIndexStatus", async () => {
    // 1st query: chunk count probe; 2nd: FileIndexStatus GROUP BY.
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(12), last: new Date("2026-07-09T00:00:00Z") }])
      .mockResolvedValueOnce([
        { status: "indexing", count: BigInt(3) },
        { status: "failed", count: BigInt(1) },
        { status: "ready", count: BigInt(40) },
      ]);

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "ready",
      gatewayHealthy: true,
      pgvectorReady: true,
      indexedCount: 12,
      pendingCount: 3,
      failedCount: 1,
    });
    const statusSql = queryRawUnsafeMock.mock.calls[1][0] as string;
    expect(statusSql).toContain('"FileIndexStatus"');
  });

  it("degrades to zero counts when the FileIndexStatus table is missing (pre-migration deploy)", async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(5), last: null }])
      .mockRejectedValueOnce(new Error('relation "FileIndexStatus" does not exist'));

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: "ready",
      indexedCount: 5,
      pendingCount: 0,
      failedCount: 0,
    });
  });

  it("state=indexing when zero chunks — the honest 'still indexing' signal", async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(0), last: null }])
      .mockResolvedValueOnce([{ status: "indexing", count: BigInt(7) }]);

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ state: "indexing", pendingCount: 7 });
  });

  it("counts both household sentinel forms too when the caller is visible into the HOUSEHOLD department", async () => {
    departmentFindManyMock.mockResolvedValue([
      { id: "hh-uuid", kind: "HOUSEHOLD", aclVersion: 1 },
    ]);
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(2), last: null }])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    // Both probes bind the personal + dual-form household owners.
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      "dev",
      "__household__",
      "__dept_hh-uuid__",
    ]);
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([
      "dev",
      "__household__",
      "__dept_hh-uuid__",
    ]);
  });

  it("counts a __dept_<uuid>__ sentinel for a non-household active department too (owner sees all)", async () => {
    departmentFindManyMock.mockResolvedValue([
      { id: "fin-uuid", kind: "DEPARTMENT", aclVersion: 1 },
    ]);
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(1), last: null }])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      "dev",
      "__dept_fin-uuid__",
    ]);
  });

  // ── WARP-1914: the status probe initializes the client on demand too ─────
  // Without this, `gatewayHealthy` was false on every box that never ran
  // `initGrpcClient()` (i.e. all of them), so the semantic readiness pill
  // showed "AI gateway not reachable" even with a healthy gateway.
  it("reports gatewayHealthy=true from an on-demand init when the client was never initialized (WARP-1914)", async () => {
    isGrpcAvailableSpy.mockReturnValue(false); // cold client
    initGrpcClientSpy.mockResolvedValue(true); // init succeeds
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ count: BigInt(3), last: null }])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/api/files/search/status");

    expect(res.status).toBe(200);
    expect(initGrpcClientSpy).toHaveBeenCalled();
    expect(res.body.gatewayHealthy).toBe(true);
    expect(res.body.state).toBe("ready");
  });
});

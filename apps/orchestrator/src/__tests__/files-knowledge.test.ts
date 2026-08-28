/**
 * Tests for the WARP-204 `/api/files/knowledge/*` routes.
 *
 *  - `GET /api/files/knowledge/recent`  → cursor-paginated recent chunks
 *  - `GET /api/files/knowledge/search`  → semantic search via shared
 *    `file-search.service.ts` (WARP-202). Falls back to 503 when the
 *    module isn't available yet.
 *
 * These routes are intentionally namespaced under `/files/knowledge/`
 * to avoid colliding with the long-standing Nextcloud filename routes
 * (`/files/recents`, `/files/search`) in `routes/files.ts`. The dashboard
 * `/knowledge` view targets the new namespace; off-host MCP clients
 * continue to use the existing `/files/search/content` semantic surface.
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
    // The module gate reads FILE_INDEXER_URL to decide the `knowledge` module's
    // availability; this suite hits the (now correctly-gated)
    // `/api/files/knowledge/*` mount, so knowledge must read as available or
    // the gate 404s it. The real config defaults this URL.
    FILE_INDEXER_URL: "http://file-indexer:8090",
    // camera-settings.service.ts derefs this at module scope;
    // the real config defaults it, so the mock must carry it too.
    FRIGATE_URL: "http://frigate:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the WARP-202 modules the search route dynamically imports. We keep
// the dynamic import surface alive (so loadEmbeddingClient/loadSearchService
// don't fall through to the 503 path) and inject controllable test
// doubles. Tests can override these via the hoisted spies.
// ─────────────────────────────────────────────────────────────────────────
const { embedSpy, searchByVectorSpy, searchHybridSpy, listRecentSpy } =
  vi.hoisted(() => ({
    embedSpy: vi.fn(),
    searchByVectorSpy: vi.fn(),
    // WARP-286: the /knowledge search route now delegates to searchHybrid.
    // The legacy searchByVectorSpy is kept (as a backwards-compatible alias
    // wired below) so the existing test cases continue to drive results
    // without rewriting their setup. New cases can spy on searchHybridSpy
    // directly when they need to assert on rerank-pipe args.
    searchHybridSpy: vi.fn(),
    listRecentSpy: vi.fn(),
  }));

vi.mock("../services/embedding.client.js", () => ({
  EmbeddingClient: class {
    constructor(_opts: { url: string }) {}
    embed(texts: string[]) {
      return embedSpy(texts);
    }
  },
}));

vi.mock("../services/file-search.service.js", () => ({
  searchByVector: (...args: unknown[]) => searchByVectorSpy(...args),
  // The route calls `searchHybrid`. If a test set up legacy
  // `searchByVectorSpy.mockResolvedValueOnce(...)` we forward to it as
  // long as the new spy has no mocked return value of its own.
  searchHybrid: (...args: unknown[]) => {
    if (searchHybridSpy.mock.results.length > 0 || searchHybridSpy.getMockImplementation()) {
      return searchHybridSpy(...args);
    }
    return searchByVectorSpy(...args);
  },
  listRecent: (...args: unknown[]) => listRecentSpy(...args),
  // WARP-242: the recent route decrypts brain-chunk ciphertext before
  // snippetting. These tests seed plaintext rows, so an identity
  // passthrough preserves the pre-WARP-242 behaviour under test.
  decryptChunkRows: async (_prisma: unknown, rows: unknown[]) => rows,
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the FileContentChunk Prisma surface used by the recent route.
// We replace the whole `@prisma/client` mock from setup.ts so we can
// inject a `fileContentChunk.findMany` per test.
// ─────────────────────────────────────────────────────────────────────────
const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    // BUG-11: requirePasswordChangeGate reads prisma.user.findUnique on
    // every request; null = no directory row = fail-open.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    fileContentChunk: {
      findMany: findManyMock,
    },
    // This suite drives the full app, whose module gate reads ModuleSetting
    // overrides for the `/api/files/knowledge` mount. `[]` = no overrides =>
    // registry defaults (knowledge is default-enabled) => gate passes.
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

// ─────────────────────────────────────────────────────────────────────────
// Auth helper. AUTH_ENABLED is `false` in tests so `req.user` is the
// stub `{ username: "dev" }`. The recent/search routes pull `userId` from
// `req.user.username`, so the per-user filter in the Prisma query is
// always exercised against `"dev"`.
// ─────────────────────────────────────────────────────────────────────────

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

describe("files-knowledge routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    findManyMock.mockReset();
  });

  // ──────────────────────────────────────────
  // GET /api/files/knowledge/recent
  // ──────────────────────────────────────────
  describe("GET /api/files/knowledge/recent", () => {
    it("returns recent chunks for the authed user (default limit 50, ordered)", async () => {
      findManyMock.mockResolvedValue([
        {
          id: 3n,
          userId: "dev",
          ncFileId: 100,
          path: "/Documents/notes.txt",
          chunkIdx: 0,
          text: "Hello world snippet",
          indexedAt: new Date("2026-04-30T12:00:00Z"),
        },
        {
          id: 1n,
          userId: "dev",
          ncFileId: 99,
          path: "/Documents/old.txt",
          chunkIdx: 0,
          text: "Older snippet",
          indexedAt: new Date("2026-04-29T11:00:00Z"),
        },
      ]);

      const res = await request(app).get("/api/files/knowledge/recent");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items).toHaveLength(2);

      const [first] = res.body.items;
      expect(first.path).toBe("/Documents/notes.txt");
      expect(first.snippet).toContain("Hello world");
      expect(typeof first.indexedAt).toBe("string");

      // BigInt id must be serialised as string (JSON can't encode BigInt).
      expect(typeof first.id).toBe("string");

      // userId must always be filtered to the authed user. WARP-1014:
      // the filter is dual-shape (`in` list) — with the dev stub both
      // shapes are "dev", so the deduped list has one entry.
      const args = findManyMock.mock.calls[0][0];
      expect(args.where.userId).toEqual({ in: ["dev"] });
      expect(args.take).toBe(50);
      expect(args.orderBy).toEqual({ indexedAt: "desc" });
    });

    it("clamps limit to 50", async () => {
      findManyMock.mockResolvedValue([]);
      const res = await request(app).get("/api/files/knowledge/recent?limit=999");
      expect(res.status).toBe(200);
      const args = findManyMock.mock.calls[0][0];
      expect(args.take).toBe(50);
    });

    it("supports cursor pagination via ?before=<iso>", async () => {
      findManyMock.mockResolvedValue([]);
      const res = await request(app).get(
        "/api/files/knowledge/recent?before=2026-04-15T00:00:00.000Z"
      );
      expect(res.status).toBe(200);
      const args = findManyMock.mock.calls[0][0];
      expect(args.where.indexedAt).toBeDefined();
      expect(args.where.indexedAt.lt).toBeInstanceOf(Date);
      expect(args.where.indexedAt.lt.toISOString()).toBe("2026-04-15T00:00:00.000Z");
    });

    it("ignores an unrecognised source filter and falls back gracefully when the schema column is missing", async () => {
      // Simulates the path before WARP-203's `source` column lands. The route
      // attempts the filtered query, gets back a Prisma "Unknown arg" error,
      // and falls back to the user-only query.
      const unknownArgError = Object.assign(new Error("Unknown arg `source`"), {
        code: "P2009",
      });
      findManyMock
        .mockRejectedValueOnce(unknownArgError)
        .mockResolvedValueOnce([]);

      const res = await request(app).get(
        "/api/files/knowledge/recent?source=brain"
      );
      expect(res.status).toBe(200);
      // First attempt with `source`, retry without
      expect(findManyMock).toHaveBeenCalledTimes(2);
      const retryArgs = findManyMock.mock.calls[1][0];
      expect(retryArgs.where.source).toBeUndefined();
    });

    it("returns an empty list when the user has no chunks", async () => {
      findManyMock.mockResolvedValue([]);
      const res = await request(app).get("/api/files/knowledge/recent");
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });
  });

  // ──────────────────────────────────────────
  // GET /api/files/knowledge/search
  // ──────────────────────────────────────────
  describe("GET /api/files/knowledge/search", () => {
    it("returns 400 when q is missing", async () => {
      const res = await request(app).get("/api/files/knowledge/search");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/query/i);
    });

    it("returns 400 when q is shorter than 2 characters", async () => {
      const res = await request(app).get("/api/files/knowledge/search?q=a");
      expect(res.status).toBe(400);
    });

    it("returns 502 when the embedding RPC fails (UNAVAILABLE / network error)", async () => {
      // WARP-202 has landed → embedding.client + file-search.service both
      // import cleanly. The route catches embed() failures and surfaces
      // them as a deterministic 502 instead of a generic 500 — the brief
      // 503 'search-not-yet-available' fallback was retired with the
      // WARP-203/main merge.
      embedSpy.mockRejectedValueOnce(
        Object.assign(new Error("14 UNAVAILABLE: ai-gateway is down"), { code: 14 })
      );
      const res = await request(app).get(
        "/api/files/knowledge/search?q=hello"
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/embedding/i);
    });

    // ──────────────────────────────────────────
    // WARP-214: metadata serialization
    // ──────────────────────────────────────────
    describe("WARP-214: metadata serialization", () => {
      it("includes metadata.chain on /recent responses when present on chunks", async () => {
        const fakeRow = {
          id: 99n,
          userId: "dev",
          ncFileId: 0,
          path: "/Brain/q1-stuff.zip/march.eml/proposal.pdf",
          chunkIdx: 0,
          text: "the budget for q4 is one hundred thousand",
          indexedAt: new Date("2026-05-01"),
          source: "brain",
          brainItemId: "bmi-99",
          pageNumber: null,
          warnings: [],
          metadata: {
            chain: [
              { filename: "q1-stuff.zip", mime: "application/zip" },
              { filename: "march.eml", mime: "message/rfc822" },
              { filename: "proposal.pdf", mime: "application/pdf" },
            ],
            subtitle_source: null,
          },
        };
        findManyMock.mockResolvedValueOnce([fakeRow]);

        const res = await request(app).get("/api/files/knowledge/recent");
        expect(res.status).toBe(200);
        expect(res.body.items[0].metadata).toBeDefined();
        expect(res.body.items[0].metadata.chain).toHaveLength(3);
        expect(res.body.items[0].metadata.chain[0].filename).toBe("q1-stuff.zip");
      });

      it("returns null metadata on legacy chunks (pre-WARP-214 rows)", async () => {
        // Row without a `metadata` key at all — simulates a row created
        // before the migration applied. The route must surface `null`
        // rather than `undefined` so JSON shape stays stable.
        findManyMock.mockResolvedValueOnce([
          {
            id: 1n,
            userId: "dev",
            ncFileId: 100,
            path: "/Documents/notes.txt",
            chunkIdx: 0,
            text: "Hello world",
            indexedAt: new Date("2026-04-30"),
          },
        ]);

        const res = await request(app).get("/api/files/knowledge/recent");
        expect(res.status).toBe(200);
        expect(res.body.items[0].metadata).toBeNull();
      });

      it("includes metadata.subtitle_source on /search hits when present", async () => {
        embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
        searchByVectorSpy.mockResolvedValueOnce([
          {
            path: "/Brain/meeting.mp4",
            score: 0.95,
            text: "transcript text",
            snippet: "transcript text",
            source: "brain",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: "bmi-1",
            metadata: { subtitle_source: "asr_transcript" },
          },
        ]);

        const res = await request(app).get(
          "/api/files/knowledge/search?q=meeting"
        );
        expect(res.status).toBe(200);
        expect(res.body.hits[0].metadata).toBeDefined();
        expect(res.body.hits[0].metadata.subtitle_source).toBe("asr_transcript");
      });

      it("returns null metadata on /search hits without metadata (legacy)", async () => {
        embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
        searchByVectorSpy.mockResolvedValueOnce([
          {
            path: "/Documents/old.txt",
            score: 0.9,
            text: "...",
            snippet: "...",
            source: "nextcloud",
            chunkIdx: 0,
            pageNumber: null,
            brainItemId: null,
          },
        ]);

        const res = await request(app).get(
          "/api/files/knowledge/search?q=hello"
        );
        expect(res.status).toBe(200);
        expect(res.body.hits[0].metadata).toBeNull();
      });
    });

    it("returns hits when embedding + file-search both succeed", async () => {
      embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      searchByVectorSpy.mockResolvedValueOnce([
        {
          path: "/Documents/notes.txt",
          score: 0.92,
          text: "matching snippet",
          source: "nextcloud",
          chunkIdx: 0,
        },
      ]);
      const res = await request(app).get(
        "/api/files/knowledge/search?q=hello"
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.hits)).toBe(true);
      expect(res.body.hits[0].path).toBe("/Documents/notes.txt");
      // userId must always pin to the authed user (RBAC, spec §12).
      // WARP-1014: with the dev stub id === username, so no additional
      // owner key is passed.
      const callArgs = searchByVectorSpy.mock.calls[0][1];
      expect(callArgs.userId).toBe("dev");
      expect(callArgs.additionalUserIds).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────
  // WARP-1014 — dual-shape reads after the WARP-493 UUID cutover.
  // Brain-sourced FileContentChunk rows are keyed by the local User.id
  // UUID; nextcloud-watcher rows stay username-keyed by design. Both
  // routes must scope by BOTH keys or brain chunks vanish from the
  // knowledge surface. These cases run against a router-level app whose
  // identity has id ≠ username (the production shape) — the full-app
  // suite above only exercises the dev stub where both are "dev".
  // ──────────────────────────────────────────
  describe("WARP-1014 — dual-shape reads (username + User.id UUID)", () => {
    const UUID = "6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f";
    let dualApp: import("express").Express;

    beforeAll(async () => {
      const express = (await import("express")).default;
      const { createFilesKnowledgeRouter } = await import(
        "../routes/files-knowledge.js"
      );
      const prisma = new PrismaClient();
      const _app = express();
      _app.use((req, _res, next) => {
        (req as { user?: { id: string; username: string } }).user = {
          id: UUID,
          username: "alice",
        };
        next();
      });
      _app.use("/api", createFilesKnowledgeRouter(prisma));
      dualApp = _app;
    });

    beforeEach(() => {
      // The module-level spies accumulate calls across the whole file;
      // clear so `.mock.calls[0]` is THIS suite's call.
      searchByVectorSpy.mockClear();
      embedSpy.mockClear();
    });

    it("scopes /recent to both the username and the UUID, surfacing brain + nextcloud rows side by side", async () => {
      findManyMock.mockResolvedValueOnce([
        {
          id: 7n,
          userId: UUID, // brain rows are UUID-keyed post-WARP-493
          ncFileId: 0,
          path: "/Brain/upload.pdf",
          chunkIdx: 0,
          text: "brain chunk",
          indexedAt: new Date("2026-07-02T10:00:00Z"),
          source: "brain",
          brainItemId: "bmi-7",
        },
        {
          id: 8n,
          userId: "alice", // watcher rows stay username-keyed by design
          ncFileId: 42,
          path: "/Documents/notes.txt",
          chunkIdx: 0,
          text: "watcher chunk",
          indexedAt: new Date("2026-07-01T10:00:00Z"),
          source: "nextcloud",
        },
      ]);

      const res = await request(dualApp).get("/api/files/knowledge/recent");
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { source: string }) => i.source)).toEqual([
        "brain",
        "nextcloud",
      ]);

      const args = findManyMock.mock.calls[0][0];
      expect(args.where.userId).toEqual({ in: ["alice", UUID] });
    });

    it("keeps the dual-shape filter when a source filter is applied", async () => {
      findManyMock.mockResolvedValueOnce([]);
      const res = await request(dualApp).get(
        "/api/files/knowledge/recent?source=brain",
      );
      expect(res.status).toBe(200);
      const args = findManyMock.mock.calls[0][0];
      expect(args.where.userId).toEqual({ in: ["alice", UUID] });
      expect(args.where.source).toBe("brain");
    });

    it("passes the UUID as an additional index owner to searchHybrid on /search", async () => {
      embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      searchByVectorSpy.mockResolvedValueOnce([
        {
          path: "/Brain/upload.pdf",
          score: 0.93,
          snippet: "brain hit",
          source: "brain",
          chunkIdx: 0,
          pageNumber: null,
          brainItemId: "bmi-7",
        },
        {
          path: "/Documents/notes.txt",
          score: 0.88,
          snippet: "watcher hit",
          source: "nextcloud",
          chunkIdx: 0,
          pageNumber: null,
          brainItemId: null,
        },
      ]);

      const res = await request(dualApp).get(
        "/api/files/knowledge/search?q=notes",
      );
      expect(res.status).toBe(200);
      expect(res.body.hits.map((h: { source: string }) => h.source)).toEqual([
        "brain",
        "nextcloud",
      ]);

      const callArgs = searchByVectorSpy.mock.calls[0][1];
      expect(callArgs.userId).toBe("alice");
      expect(callArgs.additionalUserIds).toEqual([UUID]);
    });

    it("sends the bge-calibrated similarity floor to searchHybrid (WARP-2196)", async () => {
      // The route's floor is a MODEL-SPECIFIC constant, and this pins the
      // value that actually reaches the retriever rather than the literal in
      // the module. Under bge-small-en-v1.5 nothing in the measured eval
      // corpus scores below 0.344, so the pre-WARP-2196 value of 0.25 was an
      // exact no-op here: the dashboard's headline file search shipped a
      // cosine floor that rejected nothing. See
      // services/similarity-floors.test.ts for the distributions.
      embedSpy.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
      // mockImplementation, not mockResolvedValueOnce: the module shim above
      // only forwards to searchHybridSpy once the spy has results or an
      // implementation, and a queued `Once` value is neither — the call would
      // fall through to searchByVectorSpy and never record its args.
      searchHybridSpy.mockImplementation(async () => []);

      const res = await request(dualApp).get(
        "/api/files/knowledge/search?q=notes",
      );
      expect(res.status).toBe(200);

      const args = searchHybridSpy.mock.calls[0][1] as {
        minSimilarity: number;
      };
      expect(args.minSimilarity).toBe(0.63);
      expect(args.minSimilarity).toBeGreaterThan(0.344);

      // The spy is module-scoped; leaving an implementation on it would
      // permanently divert every later test away from searchByVectorSpy.
      searchHybridSpy.mockReset();
    });
  });
});

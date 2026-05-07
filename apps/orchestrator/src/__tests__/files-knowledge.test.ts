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
  },
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the WARP-202 modules the search route dynamically imports. We keep
// the dynamic import surface alive (so loadEmbeddingClient/loadSearchService
// don't fall through to the 503 path) and inject controllable test
// doubles. Tests can override these via the hoisted spies.
// ─────────────────────────────────────────────────────────────────────────
const { embedSpy, searchByVectorSpy, listRecentSpy } = vi.hoisted(() => ({
  embedSpy: vi.fn(),
  searchByVectorSpy: vi.fn(),
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
  listRecent: (...args: unknown[]) => listRecentSpy(...args),
}));

// ─────────────────────────────────────────────────────────────────────────
// Mock the FileContentChunk Prisma surface used by the recent route.
// We replace the whole `@prisma/client` mock from setup.ts so we can
// inject a `fileContentChunk.findMany` per test.
// ─────────────────────────────────────────────────────────────────────────
const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@prisma/client", () => {
  const mockPrisma = {
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

      // userId must always be filtered to the authed user
      const args = findManyMock.mock.calls[0][0];
      expect(args.where.userId).toBe("dev");
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
      const callArgs = searchByVectorSpy.mock.calls[0][1];
      expect(callArgs.userId).toBe("dev");
    });
  });
});

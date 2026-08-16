/**
 * WARP-225 — `/api/me/context-stats/*` route + cross-user RBAC tests.
 *
 * Covers all 5 endpoints:
 *   GET  /api/me/context-stats
 *   GET  /api/me/context-stats/full
 *   GET  /api/me/context-stats/queued
 *   GET  /api/me/context-stats/failed
 *   POST /api/me/context-stats/failed/:id/retry
 *
 * Mandatory test (spec §RBAC): seed 2 users (alice, bob), each with 5
 * BrainMemoryItem rows; hit every endpoint as alice; assert no row of
 * bob's leaks anywhere — counts, recently-indexed, queued, failed,
 * pipeline health, donut. Also assert that alice POSTing retry against
 * bob's itemId returns 404 (not 403, not 200) so the existence of
 * bob's items is never observable.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
} from "vitest";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const publishMock = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  connectMqtt: vi.fn().mockResolvedValue(undefined),
  publish: (...args: unknown[]) => publishMock(...args),
  subscribe: vi.fn(),
  subscribeToTopic: vi.fn(() => () => {}),
  topicMatches: vi.fn(),
}));

// Hoisted via vi.mock so it survives the module reset.
type Item = {
  id: string;
  userId: string;
  filename: string;
  mimeType: string | null;
  bytes: bigint;
  storagePath: string;
  source: string;
  originatingChatId: string | null;
  uploadedAt: Date;
  indexedAt: Date | null;
  extractorWarnings: string[];
  hasOriginalBytes: boolean;
  status: string;
  failureReason: string | null;
  lastAttemptedAt: Date | null;
  recentAttemptCount: number;
  recentAttemptWindowStartedAt: Date | null;
};

type Chunk = {
  id: bigint;
  userId: string;
  brainItemId: string | null;
  // WARP-1394 — the mock mirrors the real column set the dual-source
  // queries touch: chunks carry a source discriminator, a display path,
  // and text (only its length matters to the bytes aggregates).
  source: "brain" | "nextcloud";
  path: string;
  textLen: number;
};

// WARP-1394 — Nextcloud-synced file statuses (watcher-written). Keyed by
// the NEXTCLOUD username, never the local User UUID.
type Fis = {
  userId: string;
  path: string;
  status: "indexing" | "ready" | "skipped" | "failed";
  reason: string | null;
  updatedAt: Date;
};

const itemStore = new Map<string, Item>();
const chunkStore = new Map<string, Chunk>();
const fisStore = new Map<string, Fis>();

function itemsFor(userId: string): Item[] {
  return [...itemStore.values()].filter((i) => i.userId === userId);
}

function chunksFor(userId: string): Chunk[] {
  return [...chunkStore.values()].filter((c) => c.userId === userId);
}

function fisFor(userId: string): Fis[] {
  return [...fisStore.values()].filter((f) => f.userId === userId);
}

// Local re-implementation of `path_ext_to_category()` (extension → the
// same 8 buckets as mime_to_category) so the stub can simulate the SQL
// function deterministically.
function pathExtToCategory(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "other";
  const ext = base.slice(dot + 1).toLowerCase();
  if (["mp3", "wav", "m4a", "flac", "ogg", "opus", "aac"].includes(ext))
    return "audio";
  if (["mp4", "mov", "mkv", "avi", "webm", "m4v"].includes(ext))
    return "video";
  if (ext === "pdf") return "pdf";
  if (
    ["jpg", "jpeg", "png", "gif", "webp", "tiff", "tif", "bmp", "heic"].includes(
      ext,
    )
  )
    return "image";
  if (["eml", "msg"].includes(ext)) return "email";
  if (["zip", "tar", "gz", "tgz", "bz2"].includes(ext)) return "archive";
  if (
    [
      "txt",
      "md",
      "markdown",
      "csv",
      "tsv",
      "json",
      "xml",
      "html",
      "htm",
      "docx",
      "doc",
      "rtf",
      "log",
      "yaml",
      "yml",
    ].includes(ext)
  )
    return "text";
  return "other";
}

// Local re-implementation of the service's `mime_to_category()` so the
// $queryRaw stub can simulate the SQL function deterministically.
function mimeToCategory(mime: string | null): string {
  if (!mime) return "other";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime === "message/rfc822" ||
    mime === "application/vnd.ms-outlook" ||
    mime === "application/x-msmail"
  )
    return "email";
  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/x-tar" ||
    mime === "application/gzip" ||
    mime === "application/x-gzip" ||
    mime === "application/x-bzip2"
  )
    return "archive";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    mime === "application/json" ||
    mime === "application/xml"
  )
    return "text";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: async (s: TemplateStringsArray, ...args: unknown[]) => {
      const parts: string[] = [];
      for (let i = 0; i < s.length; i++) {
        parts.push(s[i]);
        if (i < args.length) parts.push(`$${i + 1}`);
      }
      const sql = parts.join(" ").replace(/\s+/g, " ").trim();
      const userId = args[0] as string;

      // Counts
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1\s*$/.test(
          sql,
        )
      ) {
        return [{ c: BigInt(itemsFor(userId).length) }];
      }
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "FileContentChunk"/.test(sql)
      ) {
        // WARP-1394 — chunk counts are split by source: 'brain' rows key
        // by the User UUID, 'nextcloud' rows by the Nextcloud username.
        if (/"source" = 'brain'/.test(sql)) {
          return [
            {
              c: BigInt(
                chunksFor(userId).filter((c) => c.source === "brain").length,
              ),
            },
          ];
        }
        if (/"source" = 'nextcloud'/.test(sql)) {
          return [
            {
              c: BigInt(
                chunksFor(userId).filter((c) => c.source === "nextcloud")
                  .length,
              ),
            },
          ];
        }
        return [{ c: BigInt(chunksFor(userId).length) }];
      }

      // ── WARP-1394 — FileIndexStatus (Nextcloud-synced) queries ──
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1$/.test(
          sql,
        )
      ) {
        return [{ c: BigInt(fisFor(userId).length) }];
      }
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'indexing'$/.test(
          sql,
        )
      ) {
        return [
          {
            c: BigInt(
              fisFor(userId).filter((f) => f.status === "indexing").length,
            ),
          },
        ];
      }
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'failed'$/.test(
          sql,
        )
      ) {
        return [
          {
            c: BigInt(
              fisFor(userId).filter((f) => f.status === "failed").length,
            ),
          },
        ];
      }
      // WARP-2056 — files the extractors produced no text for.
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "FileIndexStatus" WHERE "userId" = \$1 AND "status" = 'skipped'$/.test(
          sql,
        )
      ) {
        return [
          {
            c: BigInt(
              fisFor(userId).filter((f) => f.status === "skipped").length,
            ),
          },
        ];
      }
      // Indexed-text bytes for synced chunks
      if (/sum\(length\("text"\)\), 0\)::bigint AS b\s+FROM "FileContentChunk"/.test(sql)) {
        return [
          {
            b: BigInt(
              chunksFor(userId)
                .filter((c) => c.source === "nextcloud")
                .reduce((acc, c) => acc + c.textLen, 0),
            ),
          },
        ];
      }
      // Recently-indexed synced files (+ per-path chunk counts)
      if (/AS "chunkCount"\s+FROM "FileIndexStatus" i/.test(sql)) {
        return fisFor(userId)
          .filter((f) => f.status === "ready")
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .slice(0, 10)
          .map((f) => ({
            path: f.path,
            updatedAt: f.updatedAt,
            chunkCount: BigInt(
              chunksFor(userId).filter(
                (c) => c.source === "nextcloud" && c.path === f.path,
              ).length,
            ),
          }));
      }
      // byCategory file counts (extension-derived)
      if (
        /path_ext_to_category\("path"\) AS category,\s+count\(\*\)::bigint AS files\s+FROM "FileIndexStatus"/.test(
          sql,
        )
      ) {
        const buckets = new Map<string, number>();
        for (const f of fisFor(userId)) {
          const cat = pathExtToCategory(f.path);
          buckets.set(cat, (buckets.get(cat) ?? 0) + 1);
        }
        return [...buckets.entries()].map(([category, n]) => ({
          category,
          files: BigInt(n),
        }));
      }
      // byCategory indexed-text bytes (synced chunks)
      if (
        /path_ext_to_category\("path"\) AS category,\s+COALESCE\(sum\(length\("text"\)\), 0\)::bigint AS bytes\s+FROM "FileContentChunk"/.test(
          sql,
        )
      ) {
        const buckets = new Map<string, number>();
        for (const c of chunksFor(userId)) {
          if (c.source !== "nextcloud") continue;
          const cat = pathExtToCategory(c.path);
          buckets.set(cat, (buckets.get(cat) ?? 0) + c.textLen);
        }
        return [...buckets.entries()].map(([category, bytes]) => ({
          category,
          bytes: BigInt(bytes),
        }));
      }
      // throughput7d for synced files ('ready' rows by updatedAt)
      if (/date_trunc\('day', "updatedAt"\)::date AS day/.test(sql)) {
        const byDay = new Map<string, number>();
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - 7);
        for (const f of fisFor(userId)) {
          if (f.status !== "ready") continue;
          if (f.updatedAt < cutoff) continue;
          const k = f.updatedAt.toISOString().slice(0, 10);
          byDay.set(k, (byDay.get(k) ?? 0) + 1);
        }
        return [...byDay.entries()].map(([k, n]) => ({
          day: new Date(k + "T00:00:00Z"),
          count: BigInt(n),
        }));
      }
      // pipeline health for synced files (no timing columns exist)
      if (
        /AS files,\s+count\(\*\) FILTER \(WHERE "status" = 'failed'\)::bigint AS failed\s+FROM "FileIndexStatus"/.test(
          sql,
        )
      ) {
        const buckets = new Map<string, { files: number; failed: number }>();
        for (const f of fisFor(userId)) {
          const cat = pathExtToCategory(f.path);
          const cur = buckets.get(cat) ?? { files: 0, failed: 0 };
          cur.files += 1;
          if (f.status === "failed") cur.failed += 1;
          buckets.set(cat, cur);
        }
        return [...buckets.entries()].map(([category, v]) => ({
          category,
          files: BigInt(v.files),
          failed: BigInt(v.failed),
        }));
      }
      // queued list (synced rows still indexing)
      if (
        /^SELECT "path", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'indexing'/.test(
          sql,
        )
      ) {
        return fisFor(userId)
          .filter((f) => f.status === "indexing")
          .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
          .map((f) => ({ path: f.path, updatedAt: f.updatedAt }));
      }
      // failed list (synced rows)
      if (
        /^SELECT "path", "reason", "updatedAt"\s+FROM "FileIndexStatus"\s+WHERE "userId" = \$1\s+AND "status" = 'failed'/.test(
          sql,
        )
      ) {
        return fisFor(userId)
          .filter((f) => f.status === "failed")
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map((f) => ({
            path: f.path,
            reason: f.reason,
            updatedAt: f.updatedAt,
          }));
      }
      // Anchor the COUNT(*) variant so the queued/failed list queries
      // (which include the same status literal) don't match this branch.
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'queued_for_transcription'/.test(
          sql,
        )
      ) {
        return [
          {
            c: BigInt(
              itemsFor(userId).filter(
                (i) => i.status === "queued_for_transcription",
              ).length,
            ),
          },
        ];
      }
      if (
        /^SELECT count\(\*\)::bigint AS c FROM "BrainMemoryItem" WHERE "userId" = \$1 AND "status" = 'failed'/.test(
          sql,
        )
      ) {
        return [
          {
            c: BigInt(
              itemsFor(userId).filter((i) => i.status === "failed").length,
            ),
          },
        ];
      }
      if (
        /sum\("bytes"\), 0\)::bigint AS b\s+FROM "BrainMemoryItem" WHERE/.test(
          sql,
        )
      ) {
        return [
          {
            b: itemsFor(userId).reduce((acc, i) => acc + i.bytes, 0n),
          },
        ];
      }

      // recentlyIndexed
      if (/AS "chunkCount"\s+FROM "BrainMemoryItem"/.test(sql)) {
        const rows = itemsFor(userId)
          .filter((i) => i.indexedAt !== null)
          .sort(
            (a, b) =>
              (b.indexedAt as Date).getTime() -
              (a.indexedAt as Date).getTime(),
          )
          .slice(0, 10)
          .map((i) => ({
            id: i.id,
            filename: i.filename,
            mimeType: i.mimeType,
            indexedAt: i.indexedAt as Date,
            chunkCount: BigInt(
              chunksFor(userId).filter((c) => c.brainItemId === i.id).length,
            ),
          }));
        return rows;
      }

      // byCategory
      if (
        /AS files,\s+COALESCE\(sum\("bytes"\), 0\)::bigint AS bytes/.test(sql)
      ) {
        const buckets = new Map<string, { files: number; bytes: bigint }>();
        for (const i of itemsFor(userId)) {
          const cat = mimeToCategory(i.mimeType);
          const cur = buckets.get(cat) ?? { files: 0, bytes: 0n };
          cur.files += 1;
          cur.bytes += i.bytes;
          buckets.set(cat, cur);
        }
        return [...buckets.entries()].map(([category, v]) => ({
          category,
          files: BigInt(v.files),
          bytes: v.bytes,
        }));
      }

      // throughput7d
      if (/date_trunc\('day', "indexedAt"\)::date AS day/.test(sql)) {
        const byDay = new Map<string, number>();
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() - 7);
        for (const i of itemsFor(userId)) {
          if (!i.indexedAt) continue;
          if (i.indexedAt < cutoff) continue;
          const k = i.indexedAt.toISOString().slice(0, 10);
          byDay.set(k, (byDay.get(k) ?? 0) + 1);
        }
        return [...byDay.entries()].map(([k, n]) => ({
          day: new Date(k + "T00:00:00Z"),
          count: BigInt(n),
        }));
      }

      // pipelineHealth
      if (/avg\(\s+EXTRACT\(EPOCH FROM/.test(sql)) {
        const buckets = new Map<
          string,
          { files: number; readyTimes: number[]; failed: number }
        >();
        for (const i of itemsFor(userId)) {
          const cat = mimeToCategory(i.mimeType);
          const cur =
            buckets.get(cat) ?? { files: 0, readyTimes: [], failed: 0 };
          cur.files += 1;
          if (i.status === "failed") cur.failed += 1;
          if (i.indexedAt && i.status === "ready") {
            cur.readyTimes.push(
              (i.indexedAt.getTime() - i.uploadedAt.getTime()) / 1000,
            );
          }
          buckets.set(cat, cur);
        }
        return [...buckets.entries()].map(([category, v]) => ({
          category,
          files: BigInt(v.files),
          avg_seconds:
            v.readyTimes.length === 0
              ? null
              : v.readyTimes.reduce((a, b) => a + b, 0) / v.readyTimes.length,
          failed: BigInt(v.failed),
        }));
      }

      // queued list
      if (
        /"id", "filename", "mimeType", "uploadedAt"\s+FROM "BrainMemoryItem"\s+WHERE "userId" = \$1\s+AND "status" = 'queued_for_transcription'/.test(
          sql,
        )
      ) {
        return itemsFor(userId)
          .filter((i) => i.status === "queued_for_transcription")
          .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
          .map((i) => ({
            id: i.id,
            filename: i.filename,
            mimeType: i.mimeType,
            uploadedAt: i.uploadedAt,
          }));
      }

      // failed list
      if (
        /"failureReason",\s+"lastAttemptedAt", "recentAttemptCount"\s+FROM "BrainMemoryItem"\s+WHERE "userId" = \$1\s+AND "status" = 'failed'/.test(
          sql,
        )
      ) {
        return itemsFor(userId)
          .filter((i) => i.status === "failed")
          .map((i) => ({
            id: i.id,
            filename: i.filename,
            mimeType: i.mimeType,
            failureReason: i.failureReason,
            lastAttemptedAt: i.lastAttemptedAt,
            recentAttemptCount: i.recentAttemptCount,
          }));
      }

      throw new Error(`Unexpected query: ${sql.slice(0, 200)}`);
    },
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    brainMemoryItem: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          itemStore.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Item>;
        }) => {
          const r = itemStore.get(where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data);
          return r;
        },
      ),
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    BrainMemoryItemStatus: {
      queued_for_transcription: "queued_for_transcription",
      indexing: "indexing",
      ready: "ready",
      failed: "failed",
    },
  };
});

let app: import("express").Express;
let setUser: (u: string) => void;
// WARP-493: full identity override for cases that need req.user.id ≠
// req.user.username (the production shape — id is the local User UUID).
let setIdentity: (i: { id: string; username: string }) => void;

beforeAll(async () => {
  let currentUser = "alice";
  let currentIdentity: { id: string; username: string } | null = null;
  setUser = (u: string) => {
    currentUser = u;
    currentIdentity = null;
  };
  setIdentity = (i) => {
    currentIdentity = i;
  };
  const express = (await import("express")).default;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const { createMeContextStatsRouter } = await import(
    "../routes/me-context-stats.js"
  );
  const _app = express();
  _app.use(express.json());
  _app.use((req, _res, next) => {
    (req as { user?: { id: string; username: string } }).user =
      currentIdentity ?? {
        id: currentUser,
        username: currentUser,
      };
    next();
  });
  _app.use("/api", createMeContextStatsRouter(prisma));
  app = _app;
});

beforeEach(() => {
  itemStore.clear();
  chunkStore.clear();
  fisStore.clear();
  publishMock.mockReset();
  setUser("alice");
});

let chunkId = 0n;
function makeItem(overrides: Partial<Item> = {}): Item {
  const now = new Date();
  const id = overrides.id ?? `bmi-${itemStore.size + 1}`;
  const base: Item = {
    id,
    userId: "alice",
    filename: `${id}.bin`,
    mimeType: "application/pdf",
    bytes: 1024n,
    storagePath: `/tmp/${id}`,
    source: "chat_attachment",
    originatingChatId: null,
    uploadedAt: now,
    indexedAt: now,
    extractorWarnings: [],
    hasOriginalBytes: true,
    status: "ready",
    failureReason: null,
    lastAttemptedAt: null,
    recentAttemptCount: 0,
    recentAttemptWindowStartedAt: null,
    ...overrides,
  };
  base.id = id;
  itemStore.set(base.id, base);
  return base;
}

function makeChunk(userId: string, brainItemId: string): void {
  chunkId += 1n;
  chunkStore.set(`c-${chunkId}`, {
    id: chunkId,
    userId,
    brainItemId,
    source: "brain",
    path: "",
    textLen: 0,
  });
}

// WARP-1394 — a synced (watcher-written) chunk: keyed by NC username,
// no brain item, carries the display path + text length.
function makeNcChunk(userId: string, path: string, textLen: number): void {
  chunkId += 1n;
  chunkStore.set(`c-${chunkId}`, {
    id: chunkId,
    userId,
    brainItemId: null,
    source: "nextcloud",
    path,
    textLen,
  });
}

function makeFis(overrides: Partial<Fis> & { path: string }): Fis {
  const row: Fis = {
    userId: "alice",
    status: "ready",
    reason: null,
    updatedAt: new Date(),
    ...overrides,
  };
  fisStore.set(`${row.userId}:${row.path}`, row);
  return row;
}

// ── Endpoint smoke tests ────────────────────────────────────────────────

describe("GET /api/me/context-stats", () => {
  it("returns 401 when no user is on the request", async () => {
    const express = (await import("express")).default;
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const { createMeContextStatsRouter } = await import(
      "../routes/me-context-stats.js"
    );
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use("/api", createMeContextStatsRouter(prisma));
    const res = await request(noAuthApp).get("/api/me/context-stats");
    expect(res.status).toBe(401);
  });

  it("returns counts + recently-indexed for the caller", async () => {
    makeItem({ id: "a-1", filename: "alpha.pdf", indexedAt: new Date() });
    makeItem({ id: "a-2", filename: "beta.pdf", indexedAt: new Date() });
    makeChunk("alice", "a-1");
    makeChunk("alice", "a-1");
    makeChunk("alice", "a-2");
    const res = await request(app).get("/api/me/context-stats");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(2);
    expect(res.body.chunks).toBe(3);
    expect(res.body.recentlyIndexed).toHaveLength(2);
    expect(res.headers["cache-control"]).toContain("max-age=30");
  });
});

describe("GET /api/me/context-stats/full", () => {
  it("returns full deep-dive with throughput, byCategory, pipeline health", async () => {
    makeItem({
      id: "a-1",
      filename: "doc.pdf",
      mimeType: "application/pdf",
      indexedAt: new Date(),
    });
    makeItem({
      id: "a-2",
      filename: "talk.mp3",
      mimeType: "audio/mpeg",
      indexedAt: new Date(),
    });
    const res = await request(app).get("/api/me/context-stats/full");
    expect(res.status).toBe(200);
    expect(res.body.bytesIndexed).toBe(2048);
    expect(res.body.byCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "pdf", files: 1 }),
        expect.objectContaining({ category: "audio", files: 1 }),
      ]),
    );
    expect(res.body.throughput7d).toHaveLength(7);
    expect(res.body.pipelineHealth.length).toBeGreaterThan(0);
  });
});

describe("GET /api/me/context-stats/queued", () => {
  it("returns the queued list with per-MIME reason strings", async () => {
    makeItem({
      id: "q-1",
      mimeType: "audio/mpeg",
      status: "queued_for_transcription",
      indexedAt: null,
    });
    const res = await request(app).get("/api/me/context-stats/queued");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: "q-1",
      category: "audio",
    });
  });
});

describe("GET /api/me/context-stats/failed", () => {
  it("returns the failed list with failureReason and retry-cap state", async () => {
    makeItem({
      id: "f-1",
      mimeType: "video/mp4",
      status: "failed",
      failureReason: "no_chunks",
      indexedAt: null,
    });
    const res = await request(app).get("/api/me/context-stats/failed");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: "f-1",
      failureReason: "no_chunks",
      category: "video",
    });
  });
});

describe("POST /api/me/context-stats/failed/:id/retry", () => {
  it("flips a failed row to queued and publishes run-one", async () => {
    makeItem({
      id: "f-1",
      mimeType: "audio/mpeg",
      status: "failed",
      failureReason: "no_chunks",
      indexedAt: null,
    });
    const res = await request(app).post(
      "/api/me/context-stats/failed/f-1/retry",
    );
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued_for_transcription");
    expect(itemStore.get("f-1")?.status).toBe("queued_for_transcription");
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "f-1", userId: "alice" },
    );
  });

  it("returns 409 when the row isn't in 'failed' state", async () => {
    makeItem({ id: "r-1", status: "ready" });
    const res = await request(app).post(
      "/api/me/context-stats/failed/r-1/retry",
    );
    expect(res.status).toBe(409);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 429 + Retry-After when 3 attempts already happened in the last hour", async () => {
    makeItem({
      id: "f-2",
      status: "failed",
      recentAttemptCount: 3,
      recentAttemptWindowStartedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const res = await request(app).post(
      "/api/me/context-stats/failed/f-2/retry",
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ── Mandatory cross-user RBAC isolation test (spec §RBAC) ───────────────

describe("RBAC: cross-user isolation", () => {
  // Per spec: 2 users (alice + bob), each with 5 files. Alice hits every
  // endpoint; assert no row of bob's leaks anywhere. Then assert alice
  // POSTing retry against bob's itemId returns 404 (no existence leak).

  beforeEach(() => {
    // Alice: 2 ready, 1 queued (audio), 1 failed (video), 1 indexing.
    makeItem({
      id: "a-1",
      userId: "alice",
      filename: "alice-doc-1.pdf",
      mimeType: "application/pdf",
      status: "ready",
      indexedAt: new Date(),
    });
    makeItem({
      id: "a-2",
      userId: "alice",
      filename: "alice-doc-2.pdf",
      mimeType: "application/pdf",
      status: "ready",
      indexedAt: new Date(),
    });
    makeItem({
      id: "a-3",
      userId: "alice",
      filename: "alice-talk.mp3",
      mimeType: "audio/mpeg",
      status: "queued_for_transcription",
      indexedAt: null,
    });
    makeItem({
      id: "a-4",
      userId: "alice",
      filename: "alice-clip.mp4",
      mimeType: "video/mp4",
      status: "failed",
      failureReason: "extractor_unavailable",
      indexedAt: null,
    });
    makeItem({
      id: "a-5",
      userId: "alice",
      filename: "alice-mid.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      status: "indexing",
      indexedAt: null,
    });
    makeChunk("alice", "a-1");
    makeChunk("alice", "a-1");
    makeChunk("alice", "a-2");

    // Bob: 5 distinct files spanning every category Alice's set covers,
    // plus one bob-only category (image) so a leak would be obvious.
    makeItem({
      id: "b-1",
      userId: "bob",
      filename: "bob-secret.pdf",
      mimeType: "application/pdf",
      status: "ready",
      indexedAt: new Date(),
    });
    makeItem({
      id: "b-2",
      userId: "bob",
      filename: "bob-talk.mp3",
      mimeType: "audio/mpeg",
      status: "queued_for_transcription",
      indexedAt: null,
    });
    makeItem({
      id: "b-3",
      userId: "bob",
      filename: "bob-clip.mp4",
      mimeType: "video/mp4",
      status: "failed",
      failureReason: "bob_specific_failure",
      indexedAt: null,
    });
    makeItem({
      id: "b-4",
      userId: "bob",
      filename: "bob-photo.jpg",
      mimeType: "image/jpeg",
      status: "ready",
      indexedAt: new Date(),
    });
    makeItem({
      id: "b-5",
      userId: "bob",
      filename: "bob-zip.zip",
      mimeType: "application/zip",
      status: "ready",
      indexedAt: new Date(),
    });
    makeChunk("bob", "b-1");
    makeChunk("bob", "b-1");
    makeChunk("bob", "b-1");
    makeChunk("bob", "b-4");
    makeChunk("bob", "b-5");

    setUser("alice");
  });

  it("GET /me/context-stats only sees alice's 5 files + 3 chunks", async () => {
    const res = await request(app).get("/api/me/context-stats");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(5); // not 10
    expect(res.body.chunks).toBe(3); // not 8
    expect(res.body.queued).toBe(1); // alice's audio
    expect(res.body.failed).toBe(1); // alice's video
    // Recently-indexed must not contain any bob filename.
    const filenames = res.body.recentlyIndexed.map(
      (r: { filename: string }) => r.filename,
    );
    expect(filenames.every((f: string) => !f.startsWith("bob-"))).toBe(true);
  });

  it("GET /me/context-stats/full hides bob's image + archive categories", async () => {
    const res = await request(app).get("/api/me/context-stats/full");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(5);
    // Categories present in alice's data: pdf, audio, video, text.
    // Bob-only categories must NOT appear.
    const cats = res.body.byCategory.map(
      (r: { category: string }) => r.category,
    );
    expect(cats).not.toContain("image");
    expect(cats).not.toContain("archive");
    // Bob's bytes must not be summed in.
    expect(res.body.bytesIndexed).toBe(5 * 1024); // alice has 5 items × 1024 bytes
  });

  it("GET /me/context-stats/queued only lists alice's queued audio", async () => {
    const res = await request(app).get("/api/me/context-stats/queued");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("a-3");
    // No bob row anywhere.
    expect(
      res.body.items.every(
        (i: { filename: string }) => !i.filename.startsWith("bob-"),
      ),
    ).toBe(true);
  });

  it("GET /me/context-stats/failed only lists alice's failed video", async () => {
    const res = await request(app).get("/api/me/context-stats/failed");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe("a-4");
    expect(res.body.items[0].failureReason).toBe("extractor_unavailable");
    expect(res.body.items[0].failureReason).not.toBe("bob_specific_failure");
  });

  it("POST /me/context-stats/failed/<bob's id>/retry returns 404, not 403, not 200", async () => {
    // Alice attempts to retry bob's failed item.
    setUser("alice");
    const res = await request(app).post(
      "/api/me/context-stats/failed/b-3/retry",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    // Bob's item state must not change; no MQTT publish.
    expect(itemStore.get("b-3")?.status).toBe("failed");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("POST /me/context-stats/failed/<bob's id>/retry doesn't differ from missing-id 404", async () => {
    // Both must return identical 404 envelope so an attacker can't
    // distinguish "exists but not yours" from "doesn't exist at all".
    setUser("alice");
    const cross = await request(app).post(
      "/api/me/context-stats/failed/b-3/retry",
    );
    const missing = await request(app).post(
      "/api/me/context-stats/failed/does-not-exist/retry",
    );
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(cross.body).toEqual(missing.body);
  });

  it("Switching to bob shows only bob's data", async () => {
    setUser("bob");
    const res = await request(app).get("/api/me/context-stats");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(5);
    expect(res.body.chunks).toBe(5); // bob's 5 chunks
    expect(res.body.queued).toBe(1);
    expect(res.body.failed).toBe(1);
    setUser("alice"); // restore
  });
});

// ── WARP-493 — getUserId flips to req.user.id (UUID) ──
//
// This route file had its own copy of the pre-493 `username ?? id`
// helper, which keyed every aggregate + the transcribe-retry ownership
// check by Nextcloud username. The suites above stamp id === username
// (the dev shape) and can't tell the two apart — these cases stamp the
// PRODUCTION shape (id = User.id UUID ≠ username) and pin that the
// UUID is what scopes reads, ownership, and the run-one publish.
describe("WARP-493 — context-stats keys by req.user.id (UUID), never username", () => {
  const UUID = "9f8e7d6c-5b4a-4210-aedc-ba9876543210";

  it("summary counts rows keyed by the UUID, not by username", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeItem({ id: "u-1", userId: UUID, indexedAt: new Date() });
    makeChunk(UUID, "u-1");
    // A username-keyed row must NOT be visible to the UUID identity.
    makeItem({ id: "stale-1", userId: "alice-nc", indexedAt: new Date() });

    const res = await request(app).get("/api/me/context-stats");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(1);
    expect(res.body.chunks).toBe(1);
  });

  it("failed-retry ownership + run-one publish key by the UUID", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeItem({
      id: "f-uuid",
      userId: UUID,
      mimeType: "audio/mpeg",
      status: "failed",
      failureReason: "no_chunks",
      indexedAt: null,
    });
    const res = await request(app).post(
      "/api/me/context-stats/failed/f-uuid/retry",
    );
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "f-uuid", userId: UUID },
    );
  });
});

// ── WARP-1394 — Nextcloud-synced files surface in every aggregate ──
//
// The box's primary corpus arrives via file sync (watcher →
// FileIndexStatus + FileContentChunk, keyed by NEXTCLOUD username), not
// as chat attachments. Before this fix every aggregate read
// BrainMemoryItem only, so a synced-only box reported files: 0 and the
// dashboard rendered the "context is empty" onboarding card forever.
// These cases run the PRODUCTION identity shape (UUID ≠ username) to pin
// the dual keying: brain rows by req.user.id, synced rows by username.
describe("WARP-1394 — synced files (FileIndexStatus) surface in context-stats", () => {
  const UUID = "11111111-2222-4333-8444-555555555555";

  it("a synced-only corpus yields files > 0 (the /context empty-state repro)", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeFis({ userId: "alice-nc", path: "/Docs/plan.docx" });
    makeFis({ userId: "alice-nc", path: "/Docs/report.pdf" });
    makeNcChunk("alice-nc", "/Docs/plan.docx", 1200);
    makeNcChunk("alice-nc", "/Docs/report.pdf", 800);

    const res = await request(app).get("/api/me/context-stats");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(2); // was 0 before WARP-1394
    expect(res.body.chunks).toBe(2);
    expect(
      res.body.recentlyIndexed.map((r: { id: string }) => r.id),
    ).toEqual(
      expect.arrayContaining(["nc:/Docs/plan.docx", "nc:/Docs/report.pdf"]),
    );
    expect(
      res.body.recentlyIndexed.every(
        (r: { source: string }) => r.source === "nextcloud",
      ),
    ).toBe(true);
  });

  it("merges both pipelines in /full and keeps sources separate in pipelineHealth", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeItem({
      id: "b-1",
      userId: UUID,
      filename: "attached.pdf",
      mimeType: "application/pdf",
      indexedAt: new Date(),
    });
    makeChunk(UUID, "b-1");
    makeFis({ userId: "alice-nc", path: "/Docs/notes.txt" });
    makeNcChunk("alice-nc", "/Docs/notes.txt", 500);

    const res = await request(app).get("/api/me/context-stats/full");
    expect(res.status).toBe(200);
    expect(res.body.files).toBe(2);
    expect(res.body.chunks).toBe(2);
    // 1024 original chat-attachment bytes + 500 bytes of indexed synced text.
    expect(res.body.bytesIndexed).toBe(1524);
    const cats = Object.fromEntries(
      res.body.byCategory.map((c: { category: string; files: number }) => [
        c.category,
        c.files,
      ]),
    );
    expect(cats.pdf).toBe(1);
    expect(cats.text).toBe(1);
    expect(res.body.pipelineHealth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "pdf", source: "brain" }),
        expect.objectContaining({
          category: "text",
          source: "nextcloud",
          avgSecondsToReady: null,
        }),
      ]),
    );
  });

  it("failed synced files appear with their reason and are not retryable here", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeFis({
      userId: "alice-nc",
      path: "/Docs/x.pdf",
      status: "failed",
      reason: "nc_file_id_unresolved",
    });

    const failed = await request(app).get("/api/me/context-stats/failed");
    expect(failed.status).toBe(200);
    expect(failed.body.items).toEqual([
      expect.objectContaining({
        id: "nc:/Docs/x.pdf",
        filename: "x.pdf",
        category: "pdf",
        failureReason: "nc_file_id_unresolved",
        source: "nextcloud",
      }),
    ]);

    // The transcription-retry route owns BrainMemoryItem rows only; a
    // synced id must 404, never mutate.
    const retry = await request(app).post(
      `/api/me/context-stats/failed/${encodeURIComponent("nc:/Docs/x.pdf")}/retry`,
    );
    expect(retry.status).toBe(404);
  });

  it("cross-user: bob's synced rows never leak into alice's aggregates", async () => {
    setIdentity({ id: UUID, username: "alice-nc" });
    makeFis({ userId: "alice-nc", path: "/Docs/mine.txt" });
    makeFis({ userId: "bob-nc", path: "/Docs/bobs-secret.pdf" });
    makeFis({
      userId: "bob-nc",
      path: "/Docs/bobs-fail.pdf",
      status: "failed",
      reason: "boom",
    });
    makeNcChunk("bob-nc", "/Docs/bobs-secret.pdf", 999);

    const summary = await request(app).get("/api/me/context-stats");
    const full = await request(app).get("/api/me/context-stats/full");
    const failed = await request(app).get("/api/me/context-stats/failed");
    expect(summary.body.files).toBe(1);
    expect(summary.body.chunks).toBe(0);
    expect(JSON.stringify(full.body)).not.toContain("bobs-");
    expect(failed.body.items).toEqual([]);
  });
});

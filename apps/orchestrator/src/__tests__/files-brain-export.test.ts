/**
 * Unit tests for the brain-memory export + delete + download routes
 * shipped in WARP-205. Sibling of `files-brain.test.ts`, which covers
 * the WARP-203 upload/list/get surface; the two suites share the same
 * mocking pattern (in-memory Prisma stand-in + tempdir BRAIN_ROOT).
 *
 *   GET    /api/files/brain/export?all=1
 *   GET    /api/files/brain/export?chatId=<id>
 *   GET    /api/files/brain/:itemId/download
 *   DELETE /api/files/brain/:itemId
 *
 * Spec §6.3 (lifecycle) + §12 (RBAC). The export streams a zip with
 * `manifest.json` + per-item original bytes; cross-user access on
 * either endpoint returns 404 (not 403) — same no-existence-leak
 * pattern as the WARP-203 GET route.
 *
 * The DELETE path also cascades `FileContentChunk` rows whose
 * `brainItemId` matches via Prisma `deleteMany` — covered here.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import request from "supertest";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yauzl from "yauzl";

let brainRoot: string;

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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../services/mqtt.service.js", () => ({
  connectMqtt: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn(),
  subscribe: vi.fn(),
  subscribeToTopic: vi.fn(() => () => {}),
  topicMatches: vi.fn(),
}));

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/nextcloud.client.js")
  >("../services/nextcloud.client.js");
  return {
    ...actual,
    ncListFiles: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncGetUserQuota: vi.fn(),
  };
});

// ── In-memory Prisma stand-in. Same shape as files-brain.test.ts but
// with FileContentChunk wired up so we can assert the cascade-delete
// behavior (deleteMany by brainItemId). ──
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
};
type Chunk = { id: bigint; brainItemId: string | null; userId: string };

const itemStore = new Map<string, Item>();
const chunkStore = new Map<string, Chunk>();
// WARP-242: wrapped per-document DEK rows, keyed `${keyId}#${version}` —
// the DELETE route must crypto-shred the item's key(s) with the row.
const dekStore = new Map<string, { keyId: string; version: number }>();
let cuidCounter = 0;
let chunkCounter = 0n;

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    brainMemoryItem: {
      create: vi.fn(async ({ data }: { data: Partial<Item> }) => {
        const id = `bmi-${++cuidCounter}`;
        const record: Item = {
          id,
          userId: data.userId!,
          filename: data.filename!,
          mimeType: data.mimeType ?? null,
          bytes: data.bytes!,
          storagePath: data.storagePath ?? "",
          source: data.source!,
          originatingChatId: data.originatingChatId ?? null,
          uploadedAt: new Date(),
          indexedAt: null,
          extractorWarnings: data.extractorWarnings ?? [],
          hasOriginalBytes: data.hasOriginalBytes ?? true,
        };
        itemStore.set(id, record);
        return record;
      }),
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
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          itemStore.get(where.id) ?? null,
      ),
      findMany: vi.fn(
        async ({
          where,
          take,
          skip,
          orderBy: _orderBy,
        }: {
          where?: {
            userId?: string;
            source?: string;
            originatingChatId?: string;
          };
          take?: number;
          skip?: number;
          orderBy?: unknown;
        } = {}) => {
          let rows = Array.from(itemStore.values());
          if (where?.userId)
            rows = rows.filter((r) => r.userId === where.userId);
          if (where?.source)
            rows = rows.filter((r) => r.source === where.source);
          if (where?.originatingChatId !== undefined) {
            rows = rows.filter(
              (r) => r.originatingChatId === where.originatingChatId,
            );
          }
          rows.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
          const start = skip ?? 0;
          const end = take ? start + take : rows.length;
          return rows.slice(start, end);
        },
      ),
      count: vi.fn(
        async ({ where }: { where?: { userId?: string } } = {}) => {
          let rows = Array.from(itemStore.values());
          if (where?.userId)
            rows = rows.filter((r) => r.userId === where.userId);
          return rows.length;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = itemStore.get(where.id);
        if (!r) throw new Error("not found");
        itemStore.delete(where.id);
        return r;
      }),
      deleteMany: vi.fn(
        async ({ where }: { where?: { userId?: string } } = {}) => {
          let removed = 0;
          for (const [id, row] of itemStore) {
            if (where?.userId && row.userId !== where.userId) continue;
            itemStore.delete(id);
            removed++;
          }
          return { count: removed };
        },
      ),
    },
    fileContentChunk: {
      count: vi.fn(
        async ({
          where,
        }: { where?: { brainItemId?: string; userId?: string } } = {}) => {
          let rows = Array.from(chunkStore.values());
          if (where?.brainItemId)
            rows = rows.filter((r) => r.brainItemId === where.brainItemId);
          if (where?.userId) rows = rows.filter((r) => r.userId === where.userId);
          return rows.length;
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: { where?: { brainItemId?: string; userId?: string } } = {}) => {
          let removed = 0;
          for (const [id, row] of chunkStore) {
            if (where?.brainItemId && row.brainItemId !== where.brainItemId)
              continue;
            if (where?.userId && row.userId !== where.userId) continue;
            chunkStore.delete(id);
            removed++;
          }
          return { count: removed };
        },
      ),
    },
    // WARP-242: crypto-shred target — deleteItem/purgeUserData delete the
    // per-document DEK rows (all versions for a keyId).
    documentEncryptionKey: {
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { keyId: string | { in: string[] } };
        }) => {
          const ids =
            typeof where.keyId === "string" ? [where.keyId] : where.keyId.in;
          let removed = 0;
          for (const [k, row] of dekStore) {
            if (ids.includes(row.keyId)) {
              dekStore.delete(k);
              removed++;
            }
          }
          return { count: removed };
        },
      ),
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  };
});

let app: import("express").Express;
let prisma: import("@prisma/client").PrismaClient;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-brain-export-test-"));
  brainRoot = dir;
  process.env.BRAIN_MEMORY_ROOT = dir;
  let currentUser = "alice";
  const express = (await import("express")).default;
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();
  const { createFilesBrainRouter } = await import("../routes/files-brain.js");
  const _app = express();
  _app.use(express.json());
  _app.use((req, _res, next) => {
    (req as { user?: { id: string; username: string } }).user = {
      id: currentUser,
      username: currentUser,
    };
    next();
  });
  _app.use("/api", createFilesBrainRouter(prisma));
  app = _app;
  (app as unknown as { __setUser: (u: string) => void }).__setUser = (
    u: string,
  ) => {
    currentUser = u;
  };
});

afterAll(async () => {
  if (brainRoot) await rm(brainRoot, { recursive: true, force: true });
});

beforeEach(() => {
  itemStore.clear();
  chunkStore.clear();
  dekStore.clear();
  cuidCounter = 0;
  chunkCounter = 0n;
  (app as unknown as { __setUser: (u: string) => void }).__setUser("alice");
});

afterEach(async () => {
  await rm(brainRoot, { recursive: true, force: true });
});

/**
 * Seed an item directly: db row + on-disk original bytes. Avoids going
 * through the upload route so we can control timestamps and contents.
 */
async function seedItem(
  userId: string,
  filename: string,
  contents: Buffer,
  opts: { chatId?: string | null; mime?: string } = {},
): Promise<{ id: string; storagePath: string }> {
  const id = `bmi-${++cuidCounter}`;
  const dir = join(brainRoot, userId, id);
  await mkdir(dir, { recursive: true });
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const storagePath = join(dir, ext ? `original${ext}` : "original");
  await writeFile(storagePath, contents);
  const row: Item = {
    id,
    userId,
    filename,
    mimeType: opts.mime ?? "text/plain",
    bytes: BigInt(contents.length),
    storagePath,
    source: "chat_attachment",
    originatingChatId: opts.chatId ?? null,
    uploadedAt: new Date(),
    indexedAt: null,
    extractorWarnings: [],
    hasOriginalBytes: true,
  };
  itemStore.set(id, row);
  return { id, storagePath };
}

function seedChunk(brainItemId: string, userId: string): void {
  const id = ++chunkCounter;
  chunkStore.set(String(id), { id, brainItemId, userId });
}

/** Read an in-memory zip Buffer and return file → contents (utf8). */
async function unzip(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err);
      const out = new Map<string, string>();
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) return reject(err2);
          const chunks: Buffer[] = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("end", () => resolve(out));
    });
  });
}

describe("GET /api/files/brain/export", () => {
  it("?all=1 streams a zip of every item the caller owns + manifest.json", async () => {
    await seedItem("alice", "a.txt", Buffer.from("first"));
    await seedItem("alice", "b.md", Buffer.from("second"));
    await seedItem("bob", "secret.txt", Buffer.from("not-yours"));

    const res = await request(app)
      .get("/api/files/brain/export?all=1")
      .buffer(true)
      .parse((r, cb) => {
        const data: Buffer[] = [];
        r.on("data", (c: Buffer) => data.push(c));
        r.on("end", () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toMatch(/attachment.*\.zip/);

    const files = await unzip(res.body as Buffer);
    expect(files.has("manifest.json")).toBe(true);
    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.userId).toBe("alice");
    expect(manifest.items.length).toBe(2);
    // No bob items leaked.
    for (const it of manifest.items) {
      expect(it).not.toHaveProperty("text");
      expect(["a.txt", "b.md"]).toContain(it.filename);
      expect(it).toHaveProperty("chunkCount");
    }

    // Per-item entries are present.
    const entryNames = Array.from(files.keys()).filter(
      (n) => n !== "manifest.json",
    );
    expect(entryNames.length).toBe(2);
    expect(entryNames.some((n) => n.endsWith("/a.txt"))).toBe(true);
    expect(entryNames.some((n) => n.endsWith("/b.md"))).toBe(true);
    expect(files.get(entryNames.find((n) => n.endsWith("a.txt"))!)).toBe(
      "first",
    );
  });

  it("?chatId=<id> exports only items originating from that chat", async () => {
    await seedItem("alice", "shared.txt", Buffer.from("s"), {
      chatId: "chat-A",
    });
    await seedItem("alice", "other.txt", Buffer.from("o"), {
      chatId: "chat-B",
    });
    await seedItem("alice", "untagged.txt", Buffer.from("u"));

    const res = await request(app)
      .get("/api/files/brain/export?chatId=chat-A")
      .buffer(true)
      .parse((r, cb) => {
        const data: Buffer[] = [];
        r.on("data", (c: Buffer) => data.push(c));
        r.on("end", () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    const files = await unzip(res.body as Buffer);
    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.items.length).toBe(1);
    expect(manifest.items[0].filename).toBe("shared.txt");
    expect(manifest.items[0].originatingChatId).toBe("chat-A");
    expect(manifest.scope).toEqual({ chatId: "chat-A" });
  });

  it("?chatId mode emits an empty manifest when no items match (no 404)", async () => {
    await seedItem("alice", "elsewhere.txt", Buffer.from("e"), {
      chatId: "chat-X",
    });

    const res = await request(app)
      .get("/api/files/brain/export?chatId=chat-Y")
      .buffer(true)
      .parse((r, cb) => {
        const data: Buffer[] = [];
        r.on("data", (c: Buffer) => data.push(c));
        r.on("end", () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    const files = await unzip(res.body as Buffer);
    const manifest = JSON.parse(files.get("manifest.json")!);
    expect(manifest.items).toEqual([]);
  });

  it("requires either ?all=1 or ?chatId=<id> (rejects ambiguous calls)", async () => {
    const res = await request(app).get("/api/files/brain/export");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_scope");
  });

  it("never reads outside BRAIN_ROOT/<userId> (zip-slip defense)", async () => {
    // Seed an item but rewrite its storagePath to an absolute traversal
    // that escapes the user's own tree. The route must skip / refuse
    // rather than stream `/etc/passwd`-class content into the zip.
    const { id } = await seedItem("alice", "evil.txt", Buffer.from("legit"));
    const evilRow = itemStore.get(id)!;
    evilRow.storagePath = "/etc/passwd";

    const res = await request(app)
      .get("/api/files/brain/export?all=1")
      .buffer(true)
      .parse((r, cb) => {
        const data: Buffer[] = [];
        r.on("data", (c: Buffer) => data.push(c));
        r.on("end", () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    const files = await unzip(res.body as Buffer);
    // The manifest still lists the row (it owned by alice in DB), but
    // the bytes are NOT included.
    const entryNames = Array.from(files.keys()).filter(
      (n) => n !== "manifest.json",
    );
    expect(entryNames).toEqual([]);
  });
});

describe("DELETE /api/files/brain/:itemId", () => {
  it("deletes the row, cascades chunks, removes on-disk dir", async () => {
    const { id, storagePath } = await seedItem(
      "alice",
      "doomed.txt",
      Buffer.from("bye"),
    );
    seedChunk(id, "alice");
    seedChunk(id, "alice");
    seedChunk("other-id", "alice");
    // WARP-242: the item's wrapped DEK (and a stray second version) must be
    // crypto-shredded with it; an unrelated item's DEK must survive.
    dekStore.set(`brain:${id}#1`, { keyId: `brain:${id}`, version: 1 });
    dekStore.set(`brain:${id}#2`, { keyId: `brain:${id}`, version: 2 });
    dekStore.set("brain:other-id#1", { keyId: "brain:other-id", version: 1 });

    const res = await request(app).delete(`/api/files/brain/${id}`);
    expect(res.status).toBe(204);

    expect(itemStore.has(id)).toBe(false);
    // Cascade: chunks with this brainItemId are gone; the unrelated
    // chunk is untouched.
    const remaining = Array.from(chunkStore.values()).filter(
      (c) => c.brainItemId === id,
    );
    expect(remaining).toEqual([]);
    expect(chunkStore.size).toBe(1);

    // WARP-242 crypto-shred: every DEK version for this item is gone.
    expect(
      Array.from(dekStore.values()).filter((d) => d.keyId === `brain:${id}`),
    ).toEqual([]);
    expect(dekStore.has("brain:other-id#1")).toBe(true);

    // On-disk: per-item dir is gone.
    await expect(stat(storagePath)).rejects.toThrow();
  });

  it("404s another user's item (RBAC — does NOT leak existence)", async () => {
    const { id } = await seedItem("alice", "a.txt", Buffer.from("a"));
    seedChunk(id, "alice");

    (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
    const res = await request(app).delete(`/api/files/brain/${id}`);
    expect(res.status).toBe(404);

    // Row + chunk still there.
    expect(itemStore.has(id)).toBe(true);
    expect(chunkStore.size).toBe(1);
  });

  it("404s an unknown itemId", async () => {
    const res = await request(app).delete("/api/files/brain/no-such-id");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/files/brain/:itemId/download", () => {
  it("streams the original bytes for the caller's own item", async () => {
    const bytes = Buffer.from("payload-XYZ");
    const { id } = await seedItem("alice", "doc.txt", bytes);

    const res = await request(app)
      .get(`/api/files/brain/${id}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const data: Buffer[] = [];
        r.on("data", (c: Buffer) => data.push(c));
        r.on("end", () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/doc\.txt/);
    expect((res.body as Buffer).equals(bytes)).toBe(true);
  });

  it("404s another user's item", async () => {
    const { id } = await seedItem("alice", "a.txt", Buffer.from("a"));
    (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
    const res = await request(app).get(`/api/files/brain/${id}/download`);
    expect(res.status).toBe(404);
  });

  // ── WARP-2207: ?disposition=inline ──────────────────────────────────
  //
  // A chat attachment could never be rendered in place: this route is the
  // only endpoint serving its original bytes, and it hard-coded
  // `Content-Disposition: attachment`, which a browser honours inside
  // <object>/<img>/<video> by DOWNLOADING. Same regression WARP-1919 fixed
  // for /api/files/download, still live here.
  //
  // Inline is granted ONLY through `inlinePreviewContentType()` — the same
  // safelist the Files route uses, not a second copy. A brain item is
  // arbitrary user-uploaded content, so `text/html` and `image/svg+xml`
  // must keep downloading: rendering one inline on the dashboard origin is
  // stored XSS against the session cookie.
  describe("?disposition=inline (WARP-2207)", () => {
    /**
     * Drain the response body before returning.
     *
     * These assertions only read headers, but the route answers with
     * `createReadStream(...).pipe(res)`. Leaving that stream unconsumed keeps
     * an open handle on the seeded file, and Windows refuses to unlink a file
     * with an open handle — so `afterEach`'s tempdir cleanup retried until the
     * hook timed out and took the whole suite with it. Same `.buffer().parse()`
     * shape the sibling byte-for-byte test already uses.
     */
    function getDrained(url: string) {
      return request(app)
        .get(url)
        .buffer(true)
        .parse((r, cb) => {
          const data: Buffer[] = [];
          r.on("data", (c: Buffer) => data.push(c));
          r.on("end", () => cb(null, Buffer.concat(data)));
        });
    }

    it("serves a safelisted PDF inline, with the safelisted type and nosniff", async () => {
      const { id } = await seedItem("alice", "quote.pdf", Buffer.from("%PDF-1.4"), {
        mime: "application/pdf",
      });
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^inline/);
      expect(res.headers["content-disposition"]).toMatch(/quote\.pdf/);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("exempts PDF from the sandbox CSP — a sandboxed PDF renders blank", async () => {
      const { id } = await seedItem("alice", "quote.pdf", Buffer.from("%PDF-1.4"), {
        mime: "application/pdf",
      });
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });

    it("sandboxes every other safelisted inline type", async () => {
      const { id } = await seedItem("alice", "photo.png", Buffer.from("\x89PNG"), {
        mime: "image/png",
      });
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.headers["content-disposition"]).toMatch(/^inline/);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["content-security-policy"]).toBe("sandbox");
    });

    it("refuses inline for HTML — it downloads instead (stored-XSS guard)", async () => {
      const { id } = await seedItem(
        "alice",
        "evil.html",
        Buffer.from("<script>alert(1)</script>"),
        { mime: "text/html" },
      );
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      // The disposition is the whole guard. The attachment branch still
      // echoes the stored mimeType (unchanged by WARP-2207), and
      // `Content-Type: text/html` under `Content-Disposition: attachment` is
      // inert — the browser downloads it rather than rendering it on our
      // origin. What must never happen is `inline`.
      expect(res.headers["content-disposition"]).toMatch(/^attachment/);
      expect(res.headers["content-disposition"]).not.toMatch(/inline/);
    });

    it("refuses inline for SVG — it downloads instead (stored-XSS guard)", async () => {
      const { id } = await seedItem("alice", "evil.svg", Buffer.from("<svg/>"), {
        mime: "image/svg+xml",
      });
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    });

    // The stored MIME is attacker-influenced at upload time. The inline
    // branch must derive its type from the FILENAME through the safelist,
    // never from the row — otherwise a row claiming application/pdf on an
    // .html file would be served inline as a scriptable document.
    it("never trusts the stored mimeType — a spoofed PDF row on .html still downloads", async () => {
      const { id } = await seedItem(
        "alice",
        "evil.html",
        Buffer.from("<script>alert(1)</script>"),
        { mime: "application/pdf" },
      );
      const res = await getDrained(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.headers["content-disposition"]).toMatch(/^attachment/);
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });

    it("leaves the default (no query) as an attachment, byte for byte", async () => {
      const bytes = Buffer.from("payload-XYZ");
      const { id } = await seedItem("alice", "doc.txt", bytes);
      const res = await request(app)
        .get(`/api/files/brain/${id}/download`)
        .buffer(true)
        .parse((r, cb) => {
          const data: Buffer[] = [];
          r.on("data", (c: Buffer) => data.push(c));
          r.on("end", () => cb(null, Buffer.concat(data)));
        });
      expect(res.headers["content-disposition"]).toMatch(/^attachment/);
      expect((res.body as Buffer).equals(bytes)).toBe(true);
    });

    it("still 404s another user's item when inline is requested (RBAC unchanged)", async () => {
      const { id } = await seedItem("alice", "a.pdf", Buffer.from("%PDF"));
      (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
      const res = await request(app).get(
        `/api/files/brain/${id}/download?disposition=inline`,
      );
      expect(res.status).toBe(404);
    });
  });
});

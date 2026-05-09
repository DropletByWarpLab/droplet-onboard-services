/**
 * Unit tests for /api/files/brain/* (WARP-203).
 *
 * Spec §6.3 (lifecycle), §7 (chat-attachment UX), §12 (RBAC):
 *   POST /api/files/brain/upload   — multipart, 50MB cap, MIME allow-list,
 *                                     row + disk + MQTT publish, returns 202.
 *   GET  /api/files/brain          — paginated list of caller's items.
 *   GET  /api/files/brain/:itemId  — manifest of caller's single item.
 *
 * The route file is `apps/orchestrator/src/routes/files-brain.ts`.
 *
 * RBAC test asserts user A can't read or upload to user B's items —
 * spec §12 calls this out explicitly as the most critical thing to
 * cover. We also assert per-user list isolation (cross-user list MUST
 * NOT leak).
 *
 * Tests run with `BRAIN_MEMORY_ROOT` pinned to a per-suite tmpdir so
 * the upload route's filesystem writes don't escape into the dev box.
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
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Pin BRAIN_MEMORY_ROOT BEFORE the route module loads so its
// import-time read of the env var lands in our tempdir, not /data.
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

const publishMock = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  connectMqtt: vi.fn().mockResolvedValue(undefined),
  publish: (...args: unknown[]) => publishMock(...args),
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

// ── In-memory Prisma stand-in for BrainMemoryItem ──
//
// We hand-roll the bits the route actually calls (create, update,
// findMany, findUnique, count) so we can assert on the rows that
// land. The shape mirrors the real Prisma client.
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
  // WARP-218
  status: string;
  failureReason: string | null;
  lastAttemptedAt: Date | null;
  recentAttemptCount: number;
  recentAttemptWindowStartedAt: Date | null;
};
const itemStore = new Map<string, Item>();
let cuidCounter = 0;

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
          status: data.status ?? "indexing",
          failureReason: data.failureReason ?? null,
          lastAttemptedAt: data.lastAttemptedAt ?? null,
          recentAttemptCount: data.recentAttemptCount ?? 0,
          recentAttemptWindowStartedAt: data.recentAttemptWindowStartedAt ?? null,
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
          where?: { userId?: string; source?: string; originatingChatId?: string };
          take?: number;
          skip?: number;
          orderBy?: unknown;
        } = {}) => {
          let rows = Array.from(itemStore.values());
          if (where?.userId) rows = rows.filter((r) => r.userId === where.userId);
          if (where?.source) rows = rows.filter((r) => r.source === where.source);
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
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError: class extends Error {} },
    // WARP-218: route imports BrainMemoryItemStatus directly to pick the
    // initial status by MIME — the mock has to surface the same enum
    // values the real generated client emits.
    BrainMemoryItemStatus: {
      queued_for_transcription: "queued_for_transcription",
      indexing: "indexing",
      ready: "ready",
      failed: "failed",
    },
  };
});

let app: import("express").Express;
let prisma: import("@prisma/client").PrismaClient;
let getCurrentUser: () => string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "files-brain-test-"));
  brainRoot = dir;
  process.env.BRAIN_MEMORY_ROOT = dir;
  // AUTH_ENABLED is false; auth middleware injects { username: "dev" } —
  // we override that with a per-test middleware that stamps the user
  // we want.
  let currentUser = "dev";
  getCurrentUser = () => currentUser;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = (await import("express")).default;
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient();
  const { createFilesBrainRouter } = await import(
    "../routes/files-brain.js"
  );
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
  // Expose so tests can swap users between requests.
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
  publishMock.mockReset();
  cuidCounter = 0;
  (app as unknown as { __setUser: (u: string) => void }).__setUser("alice");
});

afterEach(async () => {
  // Clean the per-suite tempdir between tests.
  await rm(brainRoot, { recursive: true, force: true });
});

describe("POST /api/files/brain/upload", () => {
  it("rejects missing file with 400", async () => {
    const res = await request(app).post("/api/files/brain/upload");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_file");
  });

  it("rejects an unsupported MIME with 415", async () => {
    // Use an arbitrary MIME the allow-list doesn't recognise.
    // (video/mp4 was the placeholder before WARP-198 added video to
    // the allow-list — application/x-tex stays out of any extractor
    // family we ship today.)
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("nope"), {
        filename: "paper.tex",
        contentType: "application/x-tex",
      });
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("unsupported_mime");
    expect(res.body.mimeType).toBe("application/x-tex");
  });

  it("rejects oversized uploads with 413", async () => {
    // multer's fileSize cap is 50MB. Use 50MB + 1KB to trip it without
    // burning RAM in the test runner — supertest streams the buffer.
    const huge = Buffer.alloc(50 * 1024 * 1024 + 1024, 0x61);
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", huge, {
        filename: "big.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });

  it("inserts row + writes original bytes + manifest + publishes MQTT, returns 202", async () => {
    const bytes = Buffer.from("# hello brain\n\nbody copy", "utf8");
    const res = await request(app)
      .post("/api/files/brain/upload")
      .field("chatId", "chat-42")
      .attach("file", bytes, {
        filename: "notes.md",
        contentType: "text/markdown",
      });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("indexing");
    expect(res.body.itemId).toBeTruthy();

    // Row inserted with the right shape.
    const item = itemStore.get(res.body.itemId)!;
    expect(item.userId).toBe("alice");
    expect(item.filename).toBe("notes.md");
    expect(item.mimeType).toBe("text/markdown");
    expect(item.source).toBe("chat_attachment");
    expect(item.originatingChatId).toBe("chat-42");
    expect(item.bytes).toBe(BigInt(bytes.length));
    expect(item.storagePath).toMatch(/original\.md$/);

    // On-disk: original bytes + manifest mirroring the row.
    const onDisk = await readFile(item.storagePath);
    expect(onDisk.equals(bytes)).toBe(true);
    const manifestPath = join(brainRoot, "alice", item.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.userId).toBe("alice");
    expect(manifest.filename).toBe("notes.md");

    // MQTT: droplet/files/brain/uploaded with itemId + userId + path.
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock.mock.calls[0][0]).toBe("droplet/files/brain/uploaded");
    const payload = publishMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.itemId).toBe(item.id);
    expect(payload.userId).toBe("alice");
    expect(payload.path).toBe(item.storagePath);
    expect(payload.mimeType).toBe("text/markdown");
  });

  it.each([
    ["application/pdf", "doc.pdf"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "doc.docx",
    ],
    ["text/plain", "doc.txt"],
    ["text/csv", "data.csv"],
    ["text/html", "page.html"],
    ["image/jpeg", "photo.jpg"],
    ["image/png", "photo.png"],
  ])("accepts %s files", async (mime, filename) => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("data"), { filename, contentType: mime });
    expect(res.status).toBe(202);
  });

  // WARP-197 — audio MIMEs are now in the allow-list. The route still
  // returns 202 because the actual transcription happens out-of-band
  // (file-indexer consumes the MQTT broadcast and runs faster-whisper).
  it.each([
    ["audio/wav", "memo.wav"],
    ["audio/x-wav", "memo.wav"],
    ["audio/mpeg", "memo.mp3"],
    ["audio/mp4", "memo.m4a"],
    ["audio/ogg", "memo.ogg"],
    ["audio/flac", "memo.flac"],
    ["audio/webm", "memo.webm"],
    ["audio/aac", "memo.aac"],
  ])("accepts audio %s uploads (WARP-197)", async (mime, filename) => {
    const fakeBytes = Buffer.alloc(64);
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", fakeBytes, { filename, contentType: mime });
    expect(res.status).toBe(202);
  });

  it("accepts email uploads (WARP-199)", async () => {
    // The orchestrator only validates MIME + size — extraction happens
    // in the file-indexer. A minimal RFC 822 envelope is enough.
    const fakeEml = Buffer.from("Subject: hi\n\nbody\n");
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", fakeEml, {
        filename: "march.eml",
        contentType: "message/rfc822",
      });
    expect(res.status).toBe(202);
  });

  it.each([
    ["application/vnd.ms-outlook", "outlook.msg"],
    ["application/x-msmail", "outlook-alt.msg"],
  ])("accepts Outlook %s uploads (WARP-199)", async (mime, filename) => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("fake mapi"), {
        filename,
        contentType: mime,
      });
    expect(res.status).toBe(202);
  });

  // WARP-200 — archive MIMEs. The file-indexer's archive extractor walks
  // members under bounded recursion + 5-layer bomb defense, so the
  // upload route just has to accept the MIME; the actual safety lives
  // downstream in services/file-indexer/extractors/archive.py.
  it.each([
    ["application/zip", "stuff.zip"],
    ["application/x-zip-compressed", "stuff.zip"],
    ["application/x-tar", "stuff.tar"],
    ["application/gzip", "stuff.tar.gz"],
    ["application/x-gzip", "stuff.tar.gz"],
    ["application/x-bzip2", "stuff.tar.bz2"],
  ])("accepts archive uploads: %s (WARP-200)", async (mime, filename) => {
    const fakeArchive = Buffer.alloc(64);
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", fakeArchive, { filename, contentType: mime });
    expect(res.status).toBe(202);
  });

  // WARP-198 — video MIMEs. The file-indexer's video extractor uses
  // a subtitles-first / audio-fallback strategy; the orchestrator's
  // upload route just has to accept the MIME. 2 GB byte cap is enforced
  // by VIDEO_MAX_BYTES in the indexer's registry — multer's 50 MB cap
  // still applies here for chat attachments.
  it.each([
    ["video/mp4", "meeting.mp4"],
    ["video/quicktime", "demo.mov"],
    ["video/x-matroska", "talk.mkv"],
    ["video/webm", "screencast.webm"],
    ["video/x-msvideo", "old-clip.avi"],
    ["video/mpeg", "broadcast.mpg"],
  ])("accepts video uploads: %s (WARP-198)", async (mime, filename) => {
    const fakeVideo = Buffer.alloc(64);
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", fakeVideo, { filename, contentType: mime });
    expect(res.status).toBe(202);
  });

  // WARP-218 — audio + video uploads must land with
  // status='queued_for_transcription' so the daily ASR worker (and the
  // synchronous brain_ingest path's skip guard) can see them. Other
  // MIMEs keep the original 'indexing' status.
  it("audio uploads insert with status=queued_for_transcription (WARP-218)", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.alloc(64), {
        filename: "memo.wav",
        contentType: "audio/wav",
      });
    expect(res.status).toBe(202);
    const item = itemStore.get(res.body.itemId)!;
    expect(item.status).toBe("queued_for_transcription");
  });

  it("video uploads insert with status=queued_for_transcription (WARP-218)", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.alloc(64), {
        filename: "demo.mp4",
        contentType: "video/mp4",
      });
    expect(res.status).toBe(202);
    const item = itemStore.get(res.body.itemId)!;
    expect(item.status).toBe("queued_for_transcription");
  });

  it("document uploads keep status=indexing (existing path) (WARP-218)", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("hello"), {
        filename: "note.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(202);
    const item = itemStore.get(res.body.itemId)!;
    expect(item.status).toBe("indexing");
  });
});

describe("GET /api/files/brain", () => {
  it("lists only the caller's items, paginated, newest first", async () => {
    // Seed 3 alice items + 2 bob items.
    (app as unknown as { __setUser: (u: string) => void }).__setUser("alice");
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/files/brain/upload")
        .attach("file", Buffer.from(`alice-${i}`), {
          filename: `a${i}.txt`,
          contentType: "text/plain",
        });
    }
    (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post("/api/files/brain/upload")
        .attach("file", Buffer.from(`bob-${i}`), {
          filename: `b${i}.txt`,
          contentType: "text/plain",
        });
    }

    // Alice list is hers only.
    (app as unknown as { __setUser: (u: string) => void }).__setUser("alice");
    const aliceList = await request(app).get("/api/files/brain");
    expect(aliceList.status).toBe(200);
    expect(aliceList.body.total).toBe(3);
    expect(aliceList.body.items.length).toBe(3);
    for (const it of aliceList.body.items) {
      expect(it.userId).toBe("alice");
      expect(it.filename).toMatch(/^a\d/);
    }

    // Bob's list is just his.
    (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
    const bobList = await request(app).get("/api/files/brain");
    expect(bobList.body.total).toBe(2);
    expect(bobList.body.items.every((i: Item) => i.userId === "bob")).toBe(
      true,
    );
  });

  it("respects ?limit and ?offset", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/files/brain/upload")
        .attach("file", Buffer.from(`x${i}`), {
          filename: `x${i}.txt`,
          contentType: "text/plain",
        });
    }
    const page1 = await request(app).get("/api/files/brain?limit=2");
    expect(page1.body.items.length).toBe(2);
    const page2 = await request(app).get("/api/files/brain?limit=2&offset=2");
    expect(page2.body.items.length).toBe(2);
    expect(page1.body.items[0].id).not.toBe(page2.body.items[0].id);
  });

  it("filters by ?originatingChatId", async () => {
    await request(app)
      .post("/api/files/brain/upload")
      .field("chatId", "chat-A")
      .attach("file", Buffer.from("a"), {
        filename: "a.txt",
        contentType: "text/plain",
      });
    await request(app)
      .post("/api/files/brain/upload")
      .field("chatId", "chat-B")
      .attach("file", Buffer.from("b"), {
        filename: "b.txt",
        contentType: "text/plain",
      });
    const res = await request(app).get(
      "/api/files/brain?originatingChatId=chat-A",
    );
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].originatingChatId).toBe("chat-A");
  });
});

describe("GET /api/files/brain/:itemId", () => {
  it("returns the manifest for the caller's own item", async () => {
    const up = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("alice"), {
        filename: "a.txt",
        contentType: "text/plain",
      });
    const res = await request(app).get(
      `/api/files/brain/${up.body.itemId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe("alice");
    expect(res.body.filename).toBe("a.txt");
  });

  it("404s another user's item (RBAC — does NOT leak existence)", async () => {
    (app as unknown as { __setUser: (u: string) => void }).__setUser("alice");
    const aliceUp = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("alice"), {
        filename: "a.txt",
        contentType: "text/plain",
      });

    (app as unknown as { __setUser: (u: string) => void }).__setUser("bob");
    const res = await request(app).get(
      `/api/files/brain/${aliceUp.body.itemId}`,
    );
    expect(res.status).toBe(404);
  });
});

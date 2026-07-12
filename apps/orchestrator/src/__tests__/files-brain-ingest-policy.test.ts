/**
 * WARP-905 — ingest-policy for the brain-memory routes.
 *
 * The optional "await-approval" ingest policy: POST /files/brain/upload
 * persists + echoes the policy (default 'auto_embed' preserves the historical
 * embed-on-upload behaviour), and POST /files/brain/:id/approve releases a
 * held item — flipping the policy to 'auto_embed' and re-driving ingestion
 * (documents re-publish `droplet/files/brain/uploaded`; audio/video go through
 * the transcription worker via `droplet/transcription/run-one`).
 *
 * Mirrors the in-memory mock pattern in files-brain-transcribe-now.test.ts so
 * the tests run without a live Postgres or MQTT broker. `publishRunOne` is the
 * REAL helper wired to the mocked `publish`, exactly as the transcribe-now
 * suite exercises it.
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const publishMock = vi.fn();
vi.mock("../services/mqtt.service.js", () => ({
  connectMqtt: vi.fn().mockResolvedValue(undefined),
  publish: (...args: unknown[]) => publishMock(...args),
  subscribe: vi.fn(),
  subscribeToTopic: vi.fn(() => () => {}),
  topicMatches: vi.fn(),
}));

// Keep the on-disk writes out of these route tests — the manifest/bytes
// side-effects have their own coverage; here we assert the DB + MQTT contract.
vi.mock("../services/brain-memory.service.js", () => ({
  writeOriginal: vi.fn(
    async (_u: string, id: string, name: string) =>
      `/data/brain-memory/u/${id}/${name}`,
  ),
  writeManifest: vi.fn().mockResolvedValue(undefined),
  streamExportZip: vi.fn(),
  deleteItem: vi.fn(),
  isPathUnderUser: vi.fn(() => true),
}));

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
  ingestPolicy: string;
  failureReason: string | null;
  lastAttemptedAt: Date | null;
  recentAttemptCount: number;
  recentAttemptWindowStartedAt: Date | null;
};

const itemStore = new Map<string, Item>();
const createdData: Array<Record<string, unknown>> = [];

vi.mock("@prisma/client", () => {
  const mockPrisma = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    brainMemoryItem: {
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; userId_sha256?: unknown } }) => {
          if (where.id) return itemStore.get(where.id) ?? null;
          return null; // sha256 dedup probe — never a hit here
        },
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdData.push(data);
        const row: Item = {
          id: "bmi-new",
          uploadedAt: new Date(),
          indexedAt: null,
          extractorWarnings: [],
          hasOriginalBytes: true,
          failureReason: null,
          lastAttemptedAt: null,
          recentAttemptCount: 0,
          recentAttemptWindowStartedAt: null,
          ...(data as Partial<Item>),
        } as Item;
        itemStore.set(row.id, row);
        return row;
      }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
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
    BrainIngestPolicy: {
      auto_embed: "auto_embed",
      await_approval: "await_approval",
    },
  };
});

let app: import("express").Express;
let setUser: (u: string) => void;

beforeAll(async () => {
  brainRoot = await mkdtemp(join(tmpdir(), "files-brain-ip-test-"));
  process.env.BRAIN_MEMORY_ROOT = brainRoot;
  let currentUser = "alice";
  setUser = (u: string) => {
    currentUser = u;
  };
  const express = (await import("express")).default;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const { createFilesBrainRouter } = await import("../routes/files-brain.js");
  const _app = express();
  _app.use(express.json());
  _app.use((req, _res, next) => {
    (req as { user?: { id: string; username: string } | undefined }).user =
      currentUser === "__anon__"
        ? undefined
        : { id: currentUser, username: currentUser };
    next();
  });
  _app.use("/api", createFilesBrainRouter(prisma));
  app = _app;
});

afterAll(async () => {
  if (brainRoot) await rm(brainRoot, { recursive: true, force: true });
});

beforeEach(() => {
  itemStore.clear();
  createdData.length = 0;
  publishMock.mockReset();
  setUser("alice");
});

afterEach(() => {
  itemStore.clear();
});

function makeItem(overrides: Partial<Item> = {}): Item {
  const now = new Date();
  const base: Item = {
    id: "bmi-1",
    userId: "alice",
    filename: "notes.txt",
    mimeType: "text/plain",
    bytes: 100n,
    storagePath: "/tmp/notes.txt",
    source: "chat_attachment",
    originatingChatId: null,
    uploadedAt: now,
    indexedAt: null,
    extractorWarnings: [],
    hasOriginalBytes: true,
    status: "indexing",
    ingestPolicy: "await_approval",
    failureReason: null,
    lastAttemptedAt: null,
    recentAttemptCount: 0,
    recentAttemptWindowStartedAt: null,
    ...overrides,
  };
  itemStore.set(base.id, base);
  return base;
}

describe("POST /api/files/brain/upload — ingest policy", () => {
  it("holds under ingestPolicy=await_approval: persists + echoes the policy", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .field("ingestPolicy", "await_approval")
      .attach("file", Buffer.from("alpha beta gamma"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(202);
    expect(res.body.ingestPolicy).toBe("await_approval");
    expect(createdData).toHaveLength(1);
    expect(createdData[0].ingestPolicy).toBe("await_approval");
    // Fail-closed: a held upload is NOT published to the indexer.
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("defaults to auto_embed when no policy field is supplied", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .attach("file", Buffer.from("alpha beta gamma"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(202);
    expect(res.body.ingestPolicy).toBe("auto_embed");
    expect(createdData[0].ingestPolicy).toBe("auto_embed");
    // auto_embed publishes the uploaded event so the indexer starts embedding.
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/files/brain/uploaded",
      expect.objectContaining({ itemId: "bmi-new", userId: "alice" }),
    );
  });

  it("treats any non-'await_approval' policy value as auto_embed", async () => {
    const res = await request(app)
      .post("/api/files/brain/upload")
      .field("ingestPolicy", "something_else")
      .attach("file", Buffer.from("alpha beta gamma"), {
        filename: "notes.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(202);
    expect(res.body.ingestPolicy).toBe("auto_embed");
  });
});

describe("POST /api/files/brain/:itemId/approve", () => {
  it("401s when unauthenticated", async () => {
    setUser("__anon__");
    const res = await request(app).post("/api/files/brain/bmi-1/approve");
    expect(res.status).toBe(401);
  });

  it("404s when the item belongs to another user (no existence leak)", async () => {
    makeItem({ userId: "bob" });
    const res = await request(app).post("/api/files/brain/bmi-1/approve");
    expect(res.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("404s when the item doesn't exist", async () => {
    const res = await request(app).post("/api/files/brain/missing/approve");
    expect(res.status).toBe(404);
  });

  it("409 not_pending_approval when the item is already auto_embed", async () => {
    makeItem({ ingestPolicy: "auto_embed" });
    const res = await request(app).post("/api/files/brain/bmi-1/approve");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_pending_approval");
    expect(res.body.ingestPolicy).toBe("auto_embed");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("flips a held document to auto_embed and re-publishes the uploaded event", async () => {
    makeItem({ mimeType: "text/plain", status: "indexing" });
    const res = await request(app).post("/api/files/brain/bmi-1/approve");
    expect(res.status).toBe(202);
    expect(res.body.ingestPolicy).toBe("auto_embed");
    expect(itemStore.get("bmi-1")!.ingestPolicy).toBe("auto_embed");
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/files/brain/uploaded",
      expect.objectContaining({ itemId: "bmi-1", userId: "alice" }),
    );
  });

  it("drives a held audio item through the transcription worker", async () => {
    makeItem({
      mimeType: "audio/wav",
      status: "queued_for_transcription",
    });
    const res = await request(app).post("/api/files/brain/bmi-1/approve");
    expect(res.status).toBe(202);
    expect(res.body.ingestPolicy).toBe("auto_embed");
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "bmi-1", userId: "alice" },
    );
  });
});

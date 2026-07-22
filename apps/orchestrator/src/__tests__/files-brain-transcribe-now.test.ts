/**
 * WARP-218 — POST /api/files/brain/:itemId/transcribe-now route.
 *
 * Promotes a queued_for_transcription (or failed) item to immediate
 * processing by publishing droplet/transcription/run-one. Validates auth,
 * ownership, state, and the per-item rolling-hour retry cap (max 3 in
 * the last 60 minutes; cap-hit returns 429 + Retry-After header).
 *
 * Mirrors the in-memory mock pattern used by files-brain.test.ts so
 * tests don't require a live Postgres or MQTT broker.
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
      create: vi.fn(),
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
  brainRoot = await mkdtemp(join(tmpdir(), "files-brain-tn-test-"));
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
    (req as { user?: { id: string; username: string } }).user = {
      id: currentUser,
      username: currentUser,
    };
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
    filename: "x.wav",
    mimeType: "audio/wav",
    bytes: 100n,
    storagePath: "/tmp/x.wav",
    source: "chat_attachment",
    originatingChatId: null,
    uploadedAt: now,
    indexedAt: null,
    extractorWarnings: [],
    hasOriginalBytes: true,
    status: "queued_for_transcription",
    ingestPolicy: "auto_embed",
    failureReason: null,
    lastAttemptedAt: null,
    recentAttemptCount: 0,
    recentAttemptWindowStartedAt: null,
    ...overrides,
  };
  itemStore.set(base.id, base);
  return base;
}

describe("POST /api/files/brain/:itemId/transcribe-now", () => {
  it("returns 404 when the item belongs to another user (no existence leak)", async () => {
    makeItem({ userId: "bob" });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(404);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the item doesn't exist", async () => {
    const res = await request(app).post("/api/files/brain/missing/transcribe-now");
    expect(res.status).toBe(404);
  });

  it("returns 409 when status is already 'indexing'", async () => {
    makeItem({ status: "indexing" });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already_processing|invalid_state/);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("returns 409 when status is 'ready' (terminal)", async () => {
    makeItem({ status: "ready" });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
  });

  it("returns 429 when 3 attempts already happened in the last hour", async () => {
    makeItem({
      status: "failed",
      recentAttemptCount: 3,
      recentAttemptWindowStartedAt: new Date(Date.now() - 30 * 60 * 1000), // 30m ago
      lastAttemptedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.attemptsInWindow).toBe(3);
    expect(typeof res.body.retryAfterSeconds).toBe("number");
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("ALLOWS retry when 3 attempts happened but the window is older than 1h", async () => {
    makeItem({
      status: "failed",
      recentAttemptCount: 3,
      recentAttemptWindowStartedAt: new Date(Date.now() - 90 * 60 * 1000),
      lastAttemptedAt: new Date(Date.now() - 90 * 60 * 1000),
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "bmi-1", userId: "alice" },
    );
  });

  it("returns 202 + publishes for a valid queued item", async () => {
    makeItem({ status: "queued_for_transcription" });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(res.body.itemId).toBe("bmi-1");
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("returns 202 + publishes for a failed item below the cap", async () => {
    makeItem({
      status: "failed",
      recentAttemptCount: 1,
      recentAttemptWindowStartedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(1);
    // Failed → queued transition leaves the row reset for the worker.
    expect(itemStore.get("bmi-1")!.status).toBe("queued_for_transcription");
  });

  // WARP-905 — a held (ingestPolicy=await_approval) audio/video item must NOT
  // be pushed through transcription + embedding by transcribe-now. The human
  // approval gate owns that release (POST /approve, which itself drives the
  // transcription worker). Without this gate, a direct API caller (or a
  // stale-UI race) could bypass the hold entirely for audio/video uploads.
  it("returns 409 awaiting_approval for a held (await_approval) audio item — does NOT index", async () => {
    makeItem({
      mimeType: "audio/wav",
      status: "queued_for_transcription",
      ingestPolicy: "await_approval",
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("awaiting_approval");
    expect(res.body.ingestPolicy).toBe("await_approval");
    // Fail-closed: nothing is handed to the transcription worker.
    expect(publishMock).not.toHaveBeenCalled();
    // Policy is untouched — still held, dashboard keeps showing the gate.
    expect(itemStore.get("bmi-1")!.ingestPolicy).toBe("await_approval");
    expect(itemStore.get("bmi-1")!.status).toBe("queued_for_transcription");
  });

  it("returns 409 awaiting_approval for a held (await_approval) video item — does NOT index", async () => {
    makeItem({
      filename: "clip.mp4",
      mimeType: "video/mp4",
      status: "queued_for_transcription",
      ingestPolicy: "await_approval",
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("awaiting_approval");
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("still blocks a held item even when it is in the 'failed' state", async () => {
    makeItem({
      mimeType: "audio/wav",
      status: "failed",
      ingestPolicy: "await_approval",
      recentAttemptCount: 1,
      recentAttemptWindowStartedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("awaiting_approval");
    expect(publishMock).not.toHaveBeenCalled();
    // The failed→queued reset must NOT happen for a held item.
    expect(itemStore.get("bmi-1")!.status).toBe("failed");
  });

  it("still transcribes an approved (auto_embed) queued audio item", async () => {
    makeItem({
      mimeType: "audio/wav",
      status: "queued_for_transcription",
      ingestPolicy: "auto_embed",
    });
    const res = await request(app).post("/api/files/brain/bmi-1/transcribe-now");
    expect(res.status).toBe(202);
    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith(
      "droplet/transcription/run-one",
      { itemId: "bmi-1", userId: "alice" },
    );
  });
});

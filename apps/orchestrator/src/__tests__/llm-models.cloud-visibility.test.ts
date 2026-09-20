/**
 * WARP-2871 — GET /api/llm/models hides cloud models from people who
 * cannot use them.
 *
 * The chat selector must only offer what a turn would not 451 on. The
 * verdict is the T3 resolver's AND-gated `cloud` (workspace escape ∧ role),
 * the same field `decideCloudTurn` consumes at dispatch time — that gate
 * stays the boundary; this is presentation. Same posture on every edge:
 *
 *   - person with cloud=false  → local models only;
 *   - person with cloud=true   → the full catalogue;
 *   - `service` principal      → the full catalogue (§3: never resolves
 *                                through layer 2 — voice picks its own model);
 *   - no person id             → the full catalogue (nothing to resolve; the
 *                                gateway's workspace 451 still applies);
 *   - resolver throws / null   → local only (fail closed, like the gate).
 *
 * The filter runs AFTER the cache read on a COPY, so the cached object stays
 * caller-independent: two callers with different verdicts must not see each
 * other's list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    vision: { model: "", maxImages: 3 },
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(),
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  BrainMemoryItemStatus: {
    queued_for_transcription: "queued_for_transcription",
    indexing: "indexing",
    ready: "ready",
    failed: "failed",
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  recordAccessDenied: vi.fn(),
}));

// A controllable cache: the "cached object not mutated" case seeds it.
const cacheStore = new Map<string, unknown>();
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cacheStore.delete(key);
  }),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));

const CATALOGUE = {
  models: [
    { id: "gpt-oss:20b", provider: "local", name: "gpt-oss:20b", context_window: 131072 },
    { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: 131072 },
    { id: "gpt-4o", provider: "openai", name: "GPT-4o", context_window: 128000 },
    { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4", context_window: 200000 },
  ],
};
const LOCAL_IDS = ["gpt-oss:20b", "llama3.2:3b"];
const ALL_IDS = CATALOGUE.models.map((m) => m.id);

const mockListModels = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelContextWindow: vi.fn().mockResolvedValue(null),
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: false }),
  getModelProvider: vi.fn().mockResolvedValue(undefined),
  chat: vi.fn(),
  listModels: (...a: unknown[]) => mockListModels(...a),
}));

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({})),
}));

// `defaultModel` is stamped from a settings read; unset here so the field
// resolves from the list itself and the assertions below stay about the list.
vi.mock("../services/active-model.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/active-model.service.js")>();
  return { ...actual, readActiveChatModel: vi.fn().mockResolvedValue(null) };
});

const mockResolveEffectiveAccess = vi.fn();
vi.mock("../services/effective-access.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/effective-access.service.js")>();
  return {
    ...actual,
    resolveEffectiveAccess: (...a: unknown[]) => mockResolveEffectiveAccess(...a),
  };
});

import { createLlmRouter } from "../routes/llm.js";

function buildApp(user: { id?: string; username?: string; role: string } | undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createLlmRouter({} as never));
  return app;
}

const ids = (res: request.Response): string[] =>
  (res.body.models as Array<{ id: string }>).map((m) => m.id);

beforeEach(() => {
  cacheStore.clear();
  mockListModels.mockReset().mockResolvedValue(CATALOGUE);
  mockResolveEffectiveAccess.mockReset();
});

describe("GET /api/llm/models — cloud visibility (WARP-2871)", () => {
  it("a person whose verdict is cloud=false sees local models only", async () => {
    mockResolveEffectiveAccess.mockResolvedValue({ cloud: false });
    const res = await request(buildApp({ id: "u-1", role: "family" })).get("/api/llm/models");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(LOCAL_IDS);
    expect(mockResolveEffectiveAccess).toHaveBeenCalledWith("u-1");
  });

  it("a person whose verdict is cloud=true sees the full catalogue", async () => {
    mockResolveEffectiveAccess.mockResolvedValue({ cloud: true });
    const res = await request(buildApp({ id: "u-1", role: "family" })).get("/api/llm/models");
    expect(ids(res)).toEqual(ALL_IDS);
  });

  it("a service principal sees the full catalogue and the resolver is never asked", async () => {
    const res = await request(buildApp({ id: "svc", role: "service" })).get("/api/llm/models");
    expect(ids(res)).toEqual(ALL_IDS);
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("a session with no person id sees the full catalogue and the resolver is never asked", async () => {
    const res = await request(buildApp({ username: "legacy", role: "owner" })).get("/api/llm/models");
    expect(ids(res)).toEqual(ALL_IDS);
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("resolver throws ⇒ local only (fail closed)", async () => {
    mockResolveEffectiveAccess.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp({ id: "u-1", role: "admin" })).get("/api/llm/models");
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(LOCAL_IDS);
  });

  it("resolver finds no user ⇒ local only (fail closed)", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(null);
    const res = await request(buildApp({ id: "gone", role: "admin" })).get("/api/llm/models");
    expect(ids(res)).toEqual(LOCAL_IDS);
  });

  it("keeps degraded + defaultModel behaviour: a degraded list is still filtered, never cached", async () => {
    mockListModels.mockResolvedValue({ ...CATALOGUE, degraded_providers: ["local"] });
    mockResolveEffectiveAccess.mockResolvedValue({ cloud: false });
    const res = await request(buildApp({ id: "u-1", role: "family" })).get("/api/llm/models");
    expect(res.body.degraded).toBe(true);
    expect(ids(res)).toEqual(LOCAL_IDS);
    expect("defaultModel" in res.body).toBe(true);
    expect(cacheStore.size).toBe(0);
  });

  it("the cached object is never mutated: a denied caller does not narrow the next allowed caller", async () => {
    mockResolveEffectiveAccess.mockResolvedValueOnce({ cloud: false });
    const denied = await request(buildApp({ id: "u-1", role: "family" })).get("/api/llm/models");
    expect(ids(denied)).toEqual(LOCAL_IDS);
    // The full catalogue was cached on the first (miss) call.
    expect(mockListModels).toHaveBeenCalledTimes(1);

    mockResolveEffectiveAccess.mockResolvedValueOnce({ cloud: true });
    const allowed = await request(buildApp({ id: "u-2", role: "admin" })).get("/api/llm/models");
    // Served from cache — and the cache still holds every model.
    expect(mockListModels).toHaveBeenCalledTimes(1);
    expect(ids(allowed)).toEqual(ALL_IDS);
  });
});

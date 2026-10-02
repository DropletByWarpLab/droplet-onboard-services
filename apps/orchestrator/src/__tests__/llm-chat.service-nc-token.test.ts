/**
 * POST /api/llm/chat — the Nextcloud credential a turn hands the agent loop.
 *
 * The route threads `resolveNcToken(req)` into `toolCallContext.ncToken`,
 * which the MCP child receives as `_meta.ncToken` and the file tools send as
 * X-Nextcloud-Token. The voice principal authenticates with the static
 * SERVICE_TOKEN_VOICE bearer, and that secret used to come back as its
 * "Nextcloud token". Unlike the sibling chat-route suites, this one runs the
 * REAL resolveNcToken, so the defect is reproduced at the route that shipped
 * it: a voice turn carries no ncToken, a person's turn still carries theirs.
 *
 * The "no Nextcloud credential" warning is for a person whose session was
 * never provisioned (its remedy is a password re-login). A service principal
 * never has one, so the warning must stay quiet for it, not fire every turn.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const h = vi.hoisted(() => ({
  redisGet: vi.fn<(key: string) => Promise<string | null>>(),
}));

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    vision: { model: "vision-local", maxImages: 3 },
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
  SESSION_COOKIE_NAME: "droplet_session",
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// resolveNcToken reads the per-person slot through getRedis().get.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  getRedis: () => ({ get: h.redisGet }),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/brain/brain-block.service.js", () => ({
  buildBrainBlock: vi.fn(async () => ""),
  BRAIN_BLOCK_CHAR_BUDGET: 2000,
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([{ name: "list_recent_files" }]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelContextWindow: vi.fn().mockResolvedValue(null),
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: false }),
  getModelProvider: vi.fn().mockResolvedValue("local"),
  chat: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
}));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(function () {
    return {
      ensureConversation: vi.fn().mockResolvedValue(null),
      createTurnRows: vi.fn().mockResolvedValue(null),
      finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
      updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
      listConversationsForUser: vi.fn().mockResolvedValue([]),
      getConversationForUser: vi.fn().mockResolvedValue(null),
      deleteConversationForUser: vi.fn().mockResolvedValue(false),
    };
  }),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";
import { signAccessToken } from "../services/jwt.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

guardComposerFailOpen();

const VOICE_BEARER = "voice-bearer-0123456789abcdef";
const VOICE = { id: "_service:voice", username: "_service:voice", displayName: "Voice Assistant", role: "service" as const };
const OWNER = { id: "owner-uuid", username: "stefan", displayName: "Stefan", role: "owner" as const };

/** authMiddleware's job, done up front: the principal the bearer resolved to. */
function buildApp(user: typeof VOICE | typeof OWNER) {
  const prisma = {
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

const turn = (app: express.Express, bearer: string) =>
  request(app)
    .post("/api/llm/chat")
    .set("Authorization", `Bearer ${bearer}`)
    .send({
      model: "m1",
      messages: [{ role: "user", content: "what did I change most recently?" }],
      allowed_tools: ["list_recent_files"],
      ephemeral: true,
      stream: false,
    });

/** runAgent(deps, opts) — the options are the SECOND argument. */
function toolCallContext(): { ncToken?: string; userId?: string } | undefined {
  expect(mockRunAgent).toHaveBeenCalledTimes(1);
  return mockRunAgent.mock.calls[0][1].toolCallContext;
}

const NO_CREDENTIAL_WARNING = expect.stringContaining("no Nextcloud credential");
// guardComposerFailOpen() installs a fresh pass-through spy on console.warn
// before every test, so console.warn below is that spy.
const warn = () => vi.mocked(console.warn);

beforeEach(() => {
  h.redisGet.mockReset().mockResolvedValue(null);
  mockRunAgent.mockReset().mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — the voice principal's bearer never becomes its ncToken", () => {
  it("a voice turn hands the agent no Nextcloud token", async () => {
    const res = await turn(buildApp(VOICE), VOICE_BEARER);

    expect(res.status).toBe(200);
    const ctx = toolCallContext();
    expect(ctx?.ncToken).toBeUndefined();
    expect(JSON.stringify(mockRunAgent.mock.calls[0][1])).not.toContain(VOICE_BEARER);
    // The acting identity still rides along; only the credential is gone.
    expect(ctx?.userId).toBe("_service:voice");
    expect(h.redisGet).not.toHaveBeenCalled();
  });

  it("a voice turn does not log the person-session warning", async () => {
    const res = await turn(buildApp(VOICE), VOICE_BEARER);

    expect(res.status).toBe(200);
    expect(warn()).not.toHaveBeenCalledWith(NO_CREDENTIAL_WARNING);
  });
});

describe("POST /api/llm/chat — a person's turn is unchanged", () => {
  it("carries the person's Nextcloud app-password from the session store", async () => {
    h.redisGet.mockResolvedValue("stefan-nc-app-password");

    const res = await turn(buildApp(OWNER), signAccessToken(OWNER));

    expect(res.status).toBe(200);
    expect(toolCallContext()?.ncToken).toBe("stefan-nc-app-password");
    expect(h.redisGet).toHaveBeenCalledWith("auth:nc-token:owner-uuid");
    expect(warn()).not.toHaveBeenCalledWith(NO_CREDENTIAL_WARNING);
  });

  it("still warns when a person's session has no Nextcloud credential", async () => {
    const res = await turn(buildApp(OWNER), signAccessToken(OWNER));

    expect(res.status).toBe(200);
    expect(toolCallContext()?.ncToken).toBeUndefined();
    expect(warn()).toHaveBeenCalledWith(NO_CREDENTIAL_WARNING);
  });
});

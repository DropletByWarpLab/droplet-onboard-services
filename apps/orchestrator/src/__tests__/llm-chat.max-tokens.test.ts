/**
 * WARP-849 — POST /api/llm/chat forwards `max_tokens` into the agent loop.
 *
 * The zod schema has always accepted `max_tokens`, but neither runAgent
 * call site passed it through, so the setup wizard's sample-probe budget
 * never reached the provider. With reasoning models (gpt-oss:20b) the
 * budget matters: reasoning spends completion tokens before any
 * user-visible content, and an exhausted budget returns EMPTY content
 * with `finish_reason:"length"` — the wizard's false "Got an empty
 * response" failure on a perfectly healthy box.
 *
 * Test harness mirrors llm-chat.base-prompt.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
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
  requireRole:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
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

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue(null),
    createTurnRows: vi.fn().mockResolvedValue(null),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
  })),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";

function createPrismaMock() {
  return {
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "user-uuid", username: "test", role: "owner" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

function agentRequest(): { max_tokens?: number } {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls.at(-1)![1] as { max_tokens?: number };
}

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — max_tokens pass-through (WARP-849)", () => {
  it("forwards the request's max_tokens to runAgent (non-streaming)", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        max_tokens: 2000,
        ephemeral: true,
      });

    expect(res.status).toBe(200);
    expect(agentRequest().max_tokens).toBe(2000);
  });

  it("passes no max_tokens to runAgent when the caller omitted it", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(agentRequest().max_tokens).toBeUndefined();
  });
});

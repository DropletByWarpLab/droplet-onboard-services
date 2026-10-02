/**
 * WARP-3193 PERF-9 — a re-submitted turn whose assistant row is still
 * streaming is refused with 409 `turn_in_progress`: the agent loop that
 * created that row is running, and a second one would run every tool side
 * effect (email, unlock) twice. The terminal case (409
 * `turn_already_completed`) is pinned alongside it.
 *
 * Test harness mirrors llm-chat.empty-replay.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

const { createTurnRows } = vi.hoisted(() => ({ createTurnRows: vi.fn() }));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(function () {
    return {
      ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
      createTurnRows,
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
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

guardComposerFailOpen();

function createPrismaMock() {
  return {
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "user-uuid", username: "test", role: "owner" };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(createPrismaMock() as never));
  return app;
}

const send = () =>
  request(buildApp())
    .post("/api/llm/chat")
    .send({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "email Bob the invoice" }],
      stream: false,
      turnId: "turn-1",
    });

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  createTurnRows.mockReset();
});

describe("POST /api/llm/chat — a re-submitted turn never starts a second agent loop", () => {
  it("409s turn_in_progress while the turn's assistant row is still streaming", async () => {
    createTurnRows.mockResolvedValue({
      userMessageId: "u-1",
      assistantMessageId: "a-1",
      assistantAlreadyFinal: false,
      assistantInFlight: true,
    });

    const res = await send();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "turn_in_progress",
      conversationId: "conv-1",
      assistantMessageId: "a-1",
    });
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("still 409s turn_already_completed for a finished turn", async () => {
    createTurnRows.mockResolvedValue({
      userMessageId: "u-1",
      assistantMessageId: "a-1",
      assistantAlreadyFinal: true,
      assistantInFlight: false,
    });

    const res = await send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("turn_already_completed");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("runs the agent for a turn this request created", async () => {
    createTurnRows.mockResolvedValue({
      userMessageId: "u-1",
      assistantMessageId: "a-1",
      assistantAlreadyFinal: false,
      assistantInFlight: false,
    });

    const res = await send();

    expect(res.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});

/**
 * A thrown agent loop must still end the SSE stream with an error `done`.
 *
 * Found on the bench box 2026-09-28: the model runner 500'd on the gpt-oss
 * chat template, runAgent threw, and the client got a 200 stream with no
 * events at all — an empty turn, no retry chip.
 *
 * Test harness mirrors llm-chat.max-tokens.test.ts.
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

import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — see the helper's header: without these three delegates both
// block composers threw on every turn and the route's fail-open swallowed it.
guardComposerFailOpen();

function createPrismaMock() {
  return {
    // WARP-2652 — persona + business + workspace, absent here until now.
    ...promptBlockPrismaDelegates(),
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

function doneEvents(text: string): Array<{ stop_reason: string; error?: string }> {
  // encodeSSE frames: `event: <type>\ndata: <json>\n\n`.
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("event: done\n"))
    .map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
}

// Other runAgent callers (post-turn work) get a normal answer; each test
// overrides only the chat turn's call, with the *Once variants.
beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — streaming turn whose agent loop throws", () => {
  it("ends the stream with one error done event and no upstream detail", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("ai-gateway 502: secret upstream body"));
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/llm/chat")
      .send({ model: "gpt-oss:20b", messages: [{ role: "user", content: "hi" }], stream: true });

    expect(res.status).toBe(200);
    const done = doneEvents(res.text);
    expect(done).toHaveLength(1);
    expect(done[0]!.stop_reason).toBe("error");
    expect(done[0]!.error).toMatch(/^agent_loop_failed/);
    expect(res.text).not.toContain("secret upstream body");
  });

  it("does not add a second done when the loop already sent one", async () => {
    mockRunAgent.mockImplementationOnce(async (deps: { onEvent: (e: unknown) => void }) => {
      deps.onEvent({ type: "done", iterations: 1, stop_reason: "error", error: "x" });
      throw new Error("after done");
    });
    const res = await request(buildApp(createPrismaMock()))
      .post("/api/llm/chat")
      .send({ model: "gpt-oss:20b", messages: [{ role: "user", content: "hi" }], stream: true });

    expect(doneEvents(res.text)).toHaveLength(1);
  });
});

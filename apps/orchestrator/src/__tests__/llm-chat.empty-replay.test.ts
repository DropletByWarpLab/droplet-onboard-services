/**
 * POST /api/llm/chat rejects threads with no user turn — 400 `empty_replay`.
 *
 * A dashboard replay bug (retryMessage serializing an empty `messages`
 * array) used to reach the agent loop as a blank thread, and the model
 * answered with a plausible-looking generic greeting. The route now
 * rejects any request whose messages contain no `role:"user"` entry so a
 * client regression surfaces as a visible pre-stream error
 * (useChat.ts::friendlyPreStreamError) instead of a silent wrong answer.
 *
 * Every legitimate caller sends a user turn: the dashboard replays the
 * full thread, voice-io sends system+user, the setup wizard's ephemeral
 * probe sends a single user message.
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

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
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

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});


/** WARP-2652 — the assembled base prompt the route handed the agent loop. */
function systemPromptText(): string {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as {
    messages: { role: string; content: unknown }[];
  };
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

// WARP-2652 — the fixture floor. Not a test of the persona or business
// feature (llm-chat.persona-block.test.ts / llm-chat.business-block.test.ts
// own those); it is the statement that the turns measured in the rest of this
// file run against the prompt the product assembles, blocks included.
describe("POST /api/llm/chat — the prompt blocks this suite assumes (fixture floor)", () => {
  it("assembles a base prompt carrying both the persona and the business block", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
});

describe("POST /api/llm/chat — user-turn-less threads rejected (empty_replay)", () => {
  it("rejects an empty messages array with 400 empty_replay", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [],
        stream: false,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_replay");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("rejects a thread with system/assistant turns but no user turn", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [
          { role: "system", content: "You are the Droplet assistant." },
          { role: "assistant", content: "Hello! How can I help?" },
        ],
        stream: false,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_replay");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("accepts a normal thread with a user turn", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        ephemeral: true,
      });

    expect(res.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalled();
  });

  it("accepts a tool-replay thread whose LAST message is not a user turn", async () => {
    const app = buildApp(createPrismaMock());

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [
          { role: "system", content: "You are the Droplet assistant." },
          { role: "user", content: "list my devices" },
          { role: "assistant", content: "" },
          { role: "tool", content: '{"devices":[]}', tool_call_id: "call_1" },
        ],
        stream: false,
        ephemeral: true,
      });

    expect(res.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalled();
  });
});

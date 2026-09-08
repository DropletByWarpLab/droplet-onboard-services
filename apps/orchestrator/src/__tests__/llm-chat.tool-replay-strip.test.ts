/**
 * WARP-2849 slice 1 — POST /api/llm/chat drops the tool fields a client
 * cannot legitimately supply, instead of forwarding them into a guaranteed
 * ai-gateway 422.
 *
 * `chatRequestSchema` accepts `role:"tool"` + `tool_call_id` and has never
 * declared `tool_calls`, so zod strips the assistant call a replayed tool
 * message is meant to answer. What reached the gateway was therefore always an
 * ORPHAN tool result, and the gateway refuses exactly that, fail-closed
 * (`services/ai-gateway/schemas.py::_validate_tool_message_integrity`):
 *
 *   rule 3 — "tool result references unknown tool_call_id: 'call_1'"
 *   rule 4 — "tool_call_id is only valid on tool messages"
 *
 * Both raise → FastAPI 422, so every request that used the documented replay
 * path failed the whole turn.
 *
 * `llm-chat.empty-replay.test.ts` already sends this exact shape and asserts
 * only that `runAgent` was CALLED — which it is, with a body the gateway would
 * have rejected. `runAgent` is mocked there, so nothing could see it. These
 * tests assert on the messages actually handed to the loop, which is the only
 * place the defect was ever visible from a test.
 *
 * NOT covered here, deliberately: carrying prior tool RESULTS across a turn
 * boundary. That is WARP-2849 slice 2 and must be reconstructed server-side
 * from the persisted trace — never trusted from the request body.
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

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue(null),
    createTurnRows: vi.fn().mockResolvedValue(null),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    getConversationToolNames: vi.fn().mockResolvedValue([]),
  })),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter, stripClientToolReplay } from "../routes/llm.js";

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

/** The messages the route actually handed the agent loop. */
function agentMessages(): { role: string; content: unknown; tool_call_id?: string }[] {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as {
    messages: { role: string; content: unknown; tool_call_id?: string }[];
  };
  return req.messages;
}

/**
 * The ai-gateway's two rules, restated over the outbound body. Asserting the
 * INVARIANT rather than "no tool messages" is what keeps this test honest if
 * the strip is ever reimplemented differently.
 */
function expectGatewayWouldAccept(
  messages: { role: string; tool_call_id?: string }[],
): void {
  const emitted = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      // rule 3 — a tool result must answer a tool_call emitted earlier in
      // THIS request. Nothing emits one: `tool_calls` is undeclared.
      expect(emitted.has(m.tool_call_id ?? "")).toBe(true);
    }
    // rule 4 — tool_call_id belongs on tool messages and nowhere else.
    if (m.tool_call_id !== undefined) expect(m.role).toBe("tool");
  }
}

describe("stripClientToolReplay", () => {
  it("drops tool-role messages and keeps everything else in order", () => {
    const out = stripClientToolReplay([
      { role: "system", content: "sys" },
      { role: "user", content: "list my devices" },
      { role: "assistant", content: "" },
      { role: "tool", content: '{"devices":[]}', tool_call_id: "call_1" },
      { role: "assistant", content: "You have no devices." },
      { role: "user", content: "are you sure?" },
    ]);

    expect(out.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(out.messages.map((m) => m.content)).toEqual([
      "sys",
      "list my devices",
      "",
      "You have no devices.",
      "are you sure?",
    ]);
    expect(out.droppedToolMessages).toBe(1);
    expect(out.strippedToolCallIds).toBe(0);
  });

  it("strips a tool_call_id planted on a non-tool role, keeping the message", () => {
    const out = stripClientToolReplay([
      { role: "user", content: "hello", tool_call_id: "call_9" },
    ]);

    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(out.messages[0]).not.toHaveProperty("tool_call_id");
    expect(out.strippedToolCallIds).toBe(1);
    expect(out.droppedToolMessages).toBe(0);
  });

  it("returns an ordinary thread unchanged, with both counters at zero", () => {
    const input = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];

    const out = stripClientToolReplay(input);

    expect(out.messages).toEqual(input);
    expect(out.droppedToolMessages).toBe(0);
    expect(out.strippedToolCallIds).toBe(0);
  });
});

describe("POST /api/llm/chat — client tool fields never reach the agent loop", () => {
  it("drops a replayed tool message that would have 422'd at the gateway", async () => {
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
    const sent = agentMessages();
    expect(sent.some((m) => m.role === "tool")).toBe(false);
    expect(sent.some((m) => m.tool_call_id !== undefined)).toBe(false);
    expectGatewayWouldAccept(sent);
  });

  it("keeps the surrounding turns, in order, when a tool message is dropped", async () => {
    const app = buildApp(createPrismaMock());

    await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [
          { role: "user", content: "list my devices" },
          { role: "tool", content: "{}", tool_call_id: "call_1" },
          { role: "assistant", content: "You have no devices." },
          { role: "user", content: "are you sure?" },
        ],
        stream: false,
        ephemeral: true,
      });

    // The route prepends its own base system prompt; the replayed thread
    // follows it verbatim minus the tool message.
    const sent = agentMessages();
    expect(sent[0]!.role).toBe("system");
    expect(sent.slice(1).map((m) => [m.role, m.content])).toEqual([
      ["user", "list my devices"],
      ["assistant", "You have no devices."],
      ["user", "are you sure?"],
    ]);
  });

  it("strips a tool_call_id planted on a user turn", async () => {
    const app = buildApp(createPrismaMock());

    await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [{ role: "user", content: "hello", tool_call_id: "call_7" }],
        stream: false,
        ephemeral: true,
      });

    const sent = agentMessages();
    expect(sent.some((m) => m.tool_call_id !== undefined)).toBe(false);
    expectGatewayWouldAccept(sent);
  });

  it("leaves an ordinary thread untouched", async () => {
    const app = buildApp(createPrismaMock());

    await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-oss:20b",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "how are you?" },
        ],
        stream: false,
        ephemeral: true,
      });

    const sent = agentMessages();
    expect(sent.slice(1).map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", "hi"],
      ["user", "how are you?"],
    ]);
  });
});

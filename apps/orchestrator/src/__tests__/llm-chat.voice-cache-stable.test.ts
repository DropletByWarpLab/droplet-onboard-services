/**
 * WARP-3125 — POST /api/llm/chat builds a cache-stable voice prompt.
 *
 * DMR's llama-server reuses the KV cache only for the prompt prefix that is
 * byte-identical to the previous request. Two things in the route changed
 * that prefix on every voice turn, or dropped part of it:
 *
 *  1. Keyword selection ran on top of voice's explicit `allowed_tools`, so the
 *     `# Tools` block changed with every sentence. The route now picks
 *     `explicit` for a service principal that named its own set. RBAC
 *     narrowing still runs first. Every other caller keeps the configured
 *     mode, and agent runs never pass through here.
 *
 *  2. The gpt-oss chat template renders only `messages[0]` as developer
 *     instructions. A system message at index 1 or later has no branch in
 *     the template's message loop and is silently dropped. The route splices
 *     its base prompt at index 0, which pushed voice's own system message
 *     (the spoken-reply persona) to index 1, so on every tool turn it never
 *     reached the model. The route now folds a service caller's leading
 *     system message into the one index-0 system message.
 *
 * `runAgent` is mocked here, so these cases pin what the route HANDS the loop.
 * What the model then receives is pinned through the real loop in
 * llm-chat.voice-model-request.test.ts.
 *
 * Harness mirrors llm-chat.reasoning-effort.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const configState = vi.hoisted(() => ({
  AUTH_ENABLED: false,
  agentMaxIter: { defaultIter: 5, capIter: 10 },
  TOOL_SELECTION_MODE: "domains" as "off" | "domains",
}));

vi.mock("../config.js", () => ({ config: configState }));

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
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
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
// The streaming path probes for a cold model before the loop; keep it off the
// network.
vi.mock("../services/model-readiness.service.js", () => ({
  probeColdModel: vi.fn().mockResolvedValue(null),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";
import type { ChatMessage } from "../types/index.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

guardComposerFailOpen();

type TestUser = { id: string; username: string; role: string };

const OWNER: TestUser = { id: "user-uuid", username: "test", role: "owner" };
const VOICE: TestUser = {
  id: "_service:voice",
  username: "_service:voice",
  role: "service",
};

// A slice of voice-io's DEFAULT_VOICE_ALLOWED_TOOLS.
const VOICE_TOOLS = [
  "get_system_health",
  "list_cameras",
  "control_device",
  "search_content",
  "read_file",
];

// voice-io's system message after WARP-3125: persona only, no clock.
const VOICE_SYSTEM =
  "You're Droplet, and you're its voice. One short spoken sentence per reply. No markdown.";

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

function buildApp(user: TestUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: TestUser }).user = user;
    next();
  });
  app.use("/api", createLlmRouter(createPrismaMock() as never));
  return app;
}

interface AgentReq {
  messages: ChatMessage[];
  allowed_tools?: string[];
  tool_selection_mode?: string;
}

function agentRequest(index = -1): AgentReq {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls.at(index)![1] as AgentReq;
}

async function postChat(user: TestUser, body: Record<string, unknown>) {
  return request(buildApp(user))
    .post("/api/llm/chat")
    .send({
      model: "gpt-oss:20b",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      ephemeral: true,
      ...body,
    });
}

/** The body voice-io sends on a tool-enabled turn. */
function voiceToolTurn(utterance: string, extra: Record<string, unknown> = {}) {
  return {
    messages: [
      { role: "system", content: VOICE_SYSTEM },
      { role: "user", content: utterance },
    ],
    allowed_tools: VOICE_TOOLS,
    max_iter: 2,
    ...extra,
  };
}

const systemMessages = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === "system");
const text = (m: ChatMessage | undefined) =>
  typeof m?.content === "string" ? m.content : "";

beforeEach(() => {
  configState.TOOL_SELECTION_MODE = "domains";
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — per-turn tool selection mode (WARP-3125)", () => {
  it("voice's explicit allowed_tools is advertised unselected", async () => {
    const res = await postChat(VOICE, voiceToolTurn("is everything working?"));
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.tool_selection_mode).toBe("explicit");
    expect(req.allowed_tools).toEqual(VOICE_TOOLS);
  });

  it("the streaming path, voice's production path, gets the same mode", async () => {
    const res = await postChat(
      VOICE,
      voiceToolTurn("is everything working?", { stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(agentRequest().tool_selection_mode).toBe("explicit");
  });

  it("two different voice utterances hand the loop the identical tool request", async () => {
    await postChat(VOICE, voiceToolTurn("is everything working?"));
    await postChat(VOICE, voiceToolTurn("is the front camera online?"));
    const a = agentRequest(0);
    const b = agentRequest(1);
    // Both unselected: equal inputs alone would also hold under `domains`,
    // where the loop then narrows each sentence differently.
    expect(a.tool_selection_mode).toBe("explicit");
    expect(b.tool_selection_mode).toBe("explicit");
    expect(JSON.stringify(b.allowed_tools)).toBe(JSON.stringify(a.allowed_tools));
    // The wire payload those inputs produce is pinned end to end, through
    // the real agent loop, in llm-chat.voice-model-request.test.ts.
  });

  it("RBAC narrowing still strips voice's non-voice write tools first", async () => {
    // block_network_device is a write tool outside VOICE_WRITE_TOOLS;
    // control_device is the one voice may drive.
    const res = await postChat(
      VOICE,
      voiceToolTurn("block that device", {
        allowed_tools: ["list_cameras", "control_device", "block_network_device"],
      }),
    );
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.tool_selection_mode).toBe("explicit");
    expect(req.allowed_tools).toEqual(["list_cameras", "control_device"]);
  });

  it("a caller without allowed_tools keeps domain selection", async () => {
    const res = await postChat(OWNER, {});
    expect(res.status).toBe(200);
    expect(agentRequest().tool_selection_mode).toBe("domains");
  });

  it("a person's explicit allowed_tools keeps domain selection", async () => {
    const res = await postChat(OWNER, { allowed_tools: ["calculate"] });
    expect(res.status).toBe(200);
    expect(agentRequest().tool_selection_mode).toBe("domains");
  });

  it("the setup wizard's allowed_tools: [] is still zero tools", async () => {
    // AiStep.tsx sends [] for its curated sample prompts.
    const res = await postChat(OWNER, { allowed_tools: [] });
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.allowed_tools).toEqual([]);
    expect(req.tool_selection_mode).toBe("domains");
  });

  it("the operator's TOOL_SELECTION_MODE=off still wins for voice", async () => {
    configState.TOOL_SELECTION_MODE = "off";
    const res = await postChat(VOICE, voiceToolTurn("is everything working?"));
    expect(res.status).toBe(200);
    expect(agentRequest().tool_selection_mode).toBe("off");
  });
});

describe("POST /api/llm/chat — voice's system message reaches the model (WARP-3125)", () => {
  it("a voice tool turn carries exactly one system message, at index 0", async () => {
    const res = await postChat(VOICE, voiceToolTurn("is everything working?"));
    expect(res.status).toBe(200);
    const { messages } = agentRequest();
    expect(systemMessages(messages)).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    // The orchestrator's base prompt leads...
    expect(text(messages[0])).toContain("You are Droplet");
    // ...and voice's persona is folded in at the end, verbatim.
    expect(text(messages[0]).endsWith(`\n\n${VOICE_SYSTEM}`)).toBe(true);
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "is everything working?",
    });
    expect(messages).toHaveLength(2);
  });

  it("the folded system message is byte-identical across two utterances", async () => {
    await postChat(VOICE, voiceToolTurn("is everything working?"));
    await postChat(VOICE, voiceToolTurn("is the front camera online?"));
    expect(text(agentRequest(1).messages[0])).toBe(
      text(agentRequest(0).messages[0]),
    );
  });

  it("the tool_choice='none' path is untouched: voice's own message stays index 0", async () => {
    // No base prompt on that path, so voice's message already renders as the
    // developer instructions; nothing to fold.
    const res = await postChat(VOICE, {
      messages: [
        { role: "system", content: VOICE_SYSTEM },
        { role: "user", content: "good morning" },
      ],
      tool_choice: "none",
    });
    expect(res.status).toBe(200);
    const { messages } = agentRequest();
    expect(messages).toEqual([
      { role: "system", content: VOICE_SYSTEM },
      { role: "user", content: "good morning" },
    ]);
  });

  it("a dashboard caller's message layout is unchanged", async () => {
    // Scoped to service principals: a person's own system message keeps its
    // position. (Pins and attachments at index >= 1 are a separate ticket.)
    const res = await postChat(OWNER, {
      messages: [
        { role: "system", content: "caller context" },
        { role: "user", content: "hello" },
      ],
    });
    expect(res.status).toBe(200);
    const { messages } = agentRequest();
    expect(systemMessages(messages)).toHaveLength(2);
    expect(text(messages[0])).toContain("You are Droplet");
    expect(messages[1]).toEqual({ role: "system", content: "caller context" });
  });
});

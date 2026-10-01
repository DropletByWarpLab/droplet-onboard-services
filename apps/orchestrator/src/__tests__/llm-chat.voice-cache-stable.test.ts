/**
 * WARP-3125 — POST /api/llm/chat builds a cache-stable voice prompt.
 *
 * DMR's llama-server reuses the KV cache only for the prompt prefix that is
 * byte-identical to the previous request. Two things in the route changed
 * that prefix on every voice turn, or dropped part of it:
 *
 *  1. Keyword selection ran on top of voice's explicit `allowed_tools`, so the
 *     `# Tools` block changed with every sentence. The route now picks
 *     `explicit` for the VOICE principal when it names its own set. RBAC
 *     narrowing still runs first. Every other caller keeps the configured
 *     mode (including the other service principals, `_service:mcp`,
 *     `_service:email` and the rest, which share the route and the `service`
 *     role), and agent runs never pass through here.
 *
 *  2. The gpt-oss chat template renders only `messages[0]` as developer
 *     instructions. A system message at index 1 or later has no branch in
 *     the template's message loop and is silently dropped. The route splices
 *     its base prompt at index 0, which pushed voice's own system message
 *     (the spoken-reply persona) to index 1, so on every tool turn it never
 *     reached the model. The route now folds the voice principal's leading
 *     system message into the one index-0 system message. Only voice's: a
 *     folded message lands in the box's own system instructions, so the fold
 *     is not extended to every service token.
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

  it("a dashboard caller's tool_choice='none' turn leaves its message unmarked at index 0", async () => {
    // WARP-3338: marked only on turns that get the base prompt. With no base
    // prompt the caller's message is already index 0, so nothing is folded
    // and the request reaches the model exactly as the caller sent it.
    const res = await postChat(OWNER, {
      messages: [
        { role: "system", content: "caller context" },
        { role: "user", content: "hello" },
      ],
      tool_choice: "none",
    });
    expect(res.status).toBe(200);
    expect(agentRequest().messages).toEqual([
      { role: "system", content: "caller context" },
      { role: "user", content: "hello" },
    ]);
  });

  it("a dashboard caller's message keeps its position, marked as its chat instructions", async () => {
    // Scoped to the voice principal: a person's own system message keeps its
    // position. WARP-3338: it is marked, and the agent loop folds it into
    // index 0 on the wire under "Instructions for this chat".
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
    expect(messages[1]).toEqual({
      role: "system",
      content: "caller context",
      contextBlock: "chat_instructions",
    });
  });
});

/**
 * `/api/llm/chat` admits role `service` for every machine bearer
 * (middleware/auth.ts SERVICE_PRINCIPALS), not just voice-io. The two
 * behaviours above are voice's alone:
 *
 *  - `explicit` advertises the caller's own list unselected. Another token
 *    that sends `allowed_tools` has not opted into that; it keeps keyword
 *    selection and the loop's budget narrowing.
 *  - the fold puts the caller's system text into the box's index-0 developer
 *    instructions, AFTER the base prompt and the off-LAN notices. Before
 *    WARP-3125 the gpt-oss template dropped that text on a tool turn. Folding
 *    it for every service token would let each one append to the box's own
 *    system instructions.
 *
 * WARP-3338: the agent loop now folds every system message into index 0 on
 * the wire. A non-voice caller's text still stays out of the route's base
 * prompt: it reaches the model under its own "Instructions for this chat"
 * header, after the box's instructions.
 */
describe("POST /api/llm/chat — a non-voice service principal is unchanged (WARP-3125)", () => {
  const MCP: TestUser = { id: "_service:mcp", username: "_service:mcp", role: "service" };
  const EMAIL: TestUser = { id: "_service:email", username: "_service:email", role: "service" };
  // `service` is also a Prisma Role value: a user row that carries it is not a
  // service token, and must not be treated as voice either.
  const SERVICE_ROLE_USER: TestUser = {
    id: "3f0c9a8e-user",
    username: "svc-row",
    role: "service",
  };
  const CALLER_SYSTEM = "SERVICE_CALLER_SYSTEM_TEXT do something unusual";

  const turn = (allowed_tools: string[]) => ({
    messages: [
      { role: "system", content: CALLER_SYSTEM },
      { role: "user", content: "is everything working?" },
    ],
    allowed_tools,
    max_iter: 2,
  });

  it.each([
    ["_service:mcp", MCP],
    ["_service:email", EMAIL],
    ["a user row carrying the service role", SERVICE_ROLE_USER],
  ])("%s with an explicit allowed_tools keeps domain selection", async (_label, user) => {
    const res = await postChat(user, turn(VOICE_TOOLS));
    expect(res.status).toBe(200);
    expect(agentRequest().tool_selection_mode).toBe("domains");
  });

  it.each([
    ["_service:mcp", MCP],
    ["_service:email", EMAIL],
  ])("%s keeps its system text out of the route's base prompt", async (_label, user) => {
    const res = await postChat(user, turn(VOICE_TOOLS));
    expect(res.status).toBe(200);
    const { messages } = agentRequest();
    // The layout a non-voice caller had before WARP-3125: the route's base
    // prompt at index 0, the caller's own message left where it was.
    expect(text(messages[0])).toContain("You are Droplet");
    expect(text(messages[0])).not.toContain(CALLER_SYSTEM);
    // WARP-3338: marked as its chat instructions; the agent loop folds it on
    // the wire under its own header, after the box's base prompt.
    expect(messages[1]).toEqual({
      role: "system",
      content: CALLER_SYSTEM,
      contextBlock: "chat_instructions",
    });
    expect(systemMessages(messages)).toHaveLength(2);
  });

  it("voice, on the same request, still gets both (the control)", async () => {
    const res = await postChat(VOICE, turn(VOICE_TOOLS));
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.tool_selection_mode).toBe("explicit");
    expect(systemMessages(req.messages)).toHaveLength(1);
    expect(text(req.messages[0]).endsWith(`\n\n${CALLER_SYSTEM}`)).toBe(true);
  });
});

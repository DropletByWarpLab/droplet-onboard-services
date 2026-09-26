// add-llm-tool:not-a-gate — reads TOOLS only to mock listTools() with the real
// registry; it asserts on the voice caller's cache-stable request (WARP-3125),
// not on a site an agent edits when adding a tool.

/**
 * WARP-3125 — what the model receives on a voice tool turn, captured at the
 * inference transport.
 *
 * DMR's llama-server reuses its KV cache only for the prompt prefix that is
 * byte-identical to the previous request. On a voice tool turn that prefix is
 * the one system message (rendered as the harmony developer block, with the
 * `# Tools` section inside it) and then the user turn. So the property voice
 * needs is: across different utterances and across a minute boundary,
 * everything before the user turn goes out byte-identical.
 *
 * Same harness shape as llm-chat.model-request.test.ts (WARP-2643): the route
 * and `runAgent` are REAL, the MCP child lists the REAL registry, and only the
 * inference transport is captured. `llm-chat.voice-cache-stable.test.ts` pins
 * what the route hands the loop; this file pins what comes out of the loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const h = vi.hoisted(() => ({
  config: {
    AUTH_ENABLED: false,
    // The SHIPPED window (docker-compose.yml), so the loop's real tool-budget
    // assert runs against the number a box runs with.
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "domains" as "off" | "domains",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    vision: { maxImages: 0, model: "" },
    AGENT_BLANK_TURN_DEBUG: false,
  },
}));
vi.mock("../config.js", () => ({ config: h.config }));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(),
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    DbNull: Symbol.for("test.Prisma.DbNull"),
  },
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
vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));

const mockListTools = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));

/** The capture point: the fully assembled request `runAgent` hands the gateway. */
interface CapturedModelRequest {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: {
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }[];
}
const modelRequests: CapturedModelRequest[] = [];
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelContextWindow: vi.fn().mockResolvedValue(null),
  chat: vi.fn(async (req: CapturedModelRequest) => {
    modelRequests.push(req);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
    };
  }),
  chatStream: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  getModelCapabilities: vi.fn().mockResolvedValue(undefined),
  getModelProvider: vi.fn().mockResolvedValue(null),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  isTimeoutError: () => false,
}));

// Voice turns are ephemeral, so the persistence write path never runs and
// there is no conversation to read continuity from.
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

import { createLlmRouter } from "../routes/llm.js";
import { TOOLS } from "@droplet/tools-core";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";
import { voiceDefaultAllowedTools } from "./helpers/voice-allowed-tools.js";

guardComposerFailOpen();

type TestUser = { id: string; username: string; role: string };
const VOICE: TestUser = {
  id: "_service:voice",
  username: "_service:voice",
  role: "service",
};
const OWNER: TestUser = { id: "owner-uuid", username: "stefan", role: "owner" };

/** What voice-io sends: the list from its source, in its order. */
const VOICE_TOOLS = voiceDefaultAllowedTools();

/** voice-io's system message after WARP-3125: persona text, no clock. */
const VOICE_SYSTEM =
  "You're Droplet, and you're its voice. One short spoken sentence per reply. No markdown.";

/** voice-io's user turn: the bracketed context line, then the transcript. */
function voiceUserTurn(clock: string, utterance: string): string {
  return (
    `[Context: it is Thursday, May 14, 2026 at ${clock} UTC; the Droplet is ` +
    "located in Greenwich, CT. Use this for time, date, and location " +
    "questions; do not say you don't have access to them.]\n" +
    utterance
  );
}

function createPrismaMock() {
  return {
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
    chatMessage: { findMany: vi.fn(async () => []) },
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

/** POST the body voice-io sends on a tool-enabled turn; return the captured request. */
async function voiceTurn(
  user: TestUser,
  userContent: string,
  allowedTools: string[] = VOICE_TOOLS,
): Promise<CapturedModelRequest> {
  const before = modelRequests.length;
  const res = await request(buildApp(user))
    .post("/api/llm/chat")
    .send({
      model: "m1",
      messages: [
        { role: "system", content: VOICE_SYSTEM },
        { role: "user", content: userContent },
      ],
      allowed_tools: allowedTools,
      max_iter: 2,
      ephemeral: true,
      stream: false,
    });
  expect(res.status).toBe(200);
  expect(modelRequests.length).toBe(before + 1);
  return modelRequests.at(-1)!;
}

const toolNames = (req: CapturedModelRequest) =>
  (req.tools ?? []).map((t) => t.function.name);
const systemMessages = (req: CapturedModelRequest) =>
  req.messages.filter((m) => m.role === "system");

beforeEach(() => {
  h.config.TOOL_SELECTION_MODE = "domains";
  modelRequests.length = 0;
  mockListTools.mockReset();
  mockListTools.mockResolvedValue(
    Array.from(TOOLS.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
});

describe("a voice tool turn on the wire (WARP-3125)", () => {
  it("two different utterances put byte-identical tools[] on the wire", async () => {
    const health = await voiceTurn(VOICE, voiceUserTurn("9:17 PM", "is everything working?"));
    const camera = await voiceTurn(VOICE, voiceUserTurn("9:17 PM", "is the front camera online?"));

    expect(JSON.stringify(camera.tools)).toBe(JSON.stringify(health.tools));
    // The tool the health question needs is advertised, so no self-heal
    // iteration is spent re-admitting it.
    expect(toolNames(health)).toContain("get_system_health");
    // Registry order, whatever order voice listed them in.
    const registryOrder = Array.from(TOOLS.keys()).filter((n) =>
      toolNames(health).includes(n),
    );
    expect(toolNames(health)).toEqual(registryOrder);
    // Nothing outside voice's list.
    for (const name of toolNames(health)) expect(VOICE_TOOLS).toContain(name);
  });

  it("everything before the user turn is byte-identical across a minute boundary", async () => {
    // The whole cacheable prefix: the one system message and tools[]. Only the
    // user turn, which carries the clock, may differ.
    const first = await voiceTurn(VOICE, voiceUserTurn("9:17 PM", "is everything working?"));
    const second = await voiceTurn(VOICE, voiceUserTurn("9:18 PM", "what's on my calendar today?"));

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
    expect(JSON.stringify(second.messages[0])).toBe(JSON.stringify(first.messages[0]));
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    expect(second.messages[1]!.content).not.toBe(first.messages[1]!.content);
    expect(String(second.messages[1]!.content)).toContain("9:18 PM");
  });

  it("carries exactly one system message, with voice's persona folded into it", async () => {
    const req = await voiceTurn(VOICE, voiceUserTurn("9:17 PM", "is everything working?"));
    expect(systemMessages(req)).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("system");
    const sys = String(req.messages[0]!.content);
    expect(sys).toContain("You are Droplet");
    expect(sys.endsWith(`\n\n${VOICE_SYSTEM}`)).toBe(true);
    expect(req.messages[1]!.role).toBe("user");
  });

  it("RBAC narrowing still runs first: a non-voice write tool never reaches the wire", async () => {
    const req = await voiceTurn(
      VOICE,
      voiceUserTurn("9:17 PM", "block that device"),
      [...VOICE_TOOLS, "block_network_device"],
    );
    expect(toolNames(req)).not.toContain("block_network_device");
    // control_device is the one write tool voice may drive.
    expect(toolNames(req)).toContain("control_device");
  });

  it("a person sending the same list keeps domain selection, so the two turns differ", async () => {
    // The contrast that makes the first case mean something: this is what
    // voice got before WARP-3125, and what every non-service caller still
    // gets.
    const health = await voiceTurn(OWNER, voiceUserTurn("9:17 PM", "is everything working?"));
    const camera = await voiceTurn(OWNER, voiceUserTurn("9:17 PM", "is the front camera online?"));
    expect(JSON.stringify(camera.tools)).not.toBe(JSON.stringify(health.tools));
    expect(toolNames(health)).not.toContain("get_system_health");
  });
});

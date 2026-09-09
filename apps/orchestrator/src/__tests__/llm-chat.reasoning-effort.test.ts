/**
 * WARP-1442 — POST /api/llm/chat resolves the reasoning-effort knob.
 *
 * Server-side voice default: the always-on voice assistant runs as the
 * `_service:voice` principal and its replies are one short spoken sentence, so
 * the gpt-oss reasoning channel is wasted latency. When voice sends no explicit
 * `reasoning_effort` the route defaults it to VOICE_REASONING_EFFORT ("low") —
 * WITHOUT any voice-io change. Every OTHER caller (dashboard, wizard) is
 * unaffected: with no explicit value they forward NOTHING, so the gateway
 * request is byte-for-byte unchanged. An explicit value always wins.
 *
 * Test harness mirrors llm-chat.max-tokens.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// WARP-1442 — the streaming path fires a cold-model probe before the agent
// loop. Stub it to null so the stream:true route tests are deterministic and
// never reach for a real Ollama (OLLAMA_URL defaults to host.docker.internal).
vi.mock("../services/model-readiness.service.js", () => ({
  probeColdModel: vi.fn().mockResolvedValue(null),
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

type TestUser = { id: string; username: string; role: string };

const OWNER: TestUser = { id: "user-uuid", username: "test", role: "owner" };
const VOICE: TestUser = {
  id: "_service:voice",
  username: "voice",
  role: "service",
};

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

function agentRequest(): { reasoning_effort?: string } {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls.at(-1)![1] as { reasoning_effort?: string };
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

const ORIGINAL_ENV = process.env.VOICE_REASONING_EFFORT;

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  delete process.env.VOICE_REASONING_EFFORT;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.VOICE_REASONING_EFFORT;
  else process.env.VOICE_REASONING_EFFORT = ORIGINAL_ENV;
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
    const res = await postChat(OWNER, {});
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
});

describe("POST /api/llm/chat — reasoning_effort resolution (WARP-1442)", () => {
  it("defaults the voice principal to 'low' when no effort is given", async () => {
    const res = await postChat(VOICE, {});
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBe("low");
  });

  it("does NOT default a non-voice caller — dashboard stays byte-for-byte unchanged", async () => {
    const res = await postChat(OWNER, {});
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBeUndefined();
  });

  it("lets an explicit value override the voice default", async () => {
    const res = await postChat(VOICE, { reasoning_effort: "high" });
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBe("high");
  });

  it("honors an explicit value from a non-voice caller (opt-in)", async () => {
    const res = await postChat(OWNER, { reasoning_effort: "medium" });
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBe("medium");
  });

  it("honors the VOICE_REASONING_EFFORT env override for the voice default", async () => {
    process.env.VOICE_REASONING_EFFORT = "medium";
    const res = await postChat(VOICE, {});
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBe("medium");
  });

  it("falls back to 'low' when VOICE_REASONING_EFFORT is set to garbage", async () => {
    process.env.VOICE_REASONING_EFFORT = "ludicrous";
    const res = await postChat(VOICE, {});
    expect(res.status).toBe(200);
    expect(agentRequest().reasoning_effort).toBe("low");
  });

  it("rejects an invalid reasoning_effort with 400 before the gateway", async () => {
    const res = await postChat(OWNER, { reasoning_effort: "ultra" });
    expect(res.status).toBe(400);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // WARP-1442 — voice's PRODUCTION path is streaming. The route wires
  // reasoning_effort into BOTH runAgent sites; every assertion above only
  // exercised stream:false, so the streaming site was covered by inspection.
  // These pin it directly on the wire the voice principal actually uses.
  it("defaults the voice principal to 'low' on the streaming path (stream:true)", async () => {
    const res = await postChat(VOICE, { stream: true });
    expect(res.status).toBe(200);
    // Prove we took the streaming branch, not a stream:false fall-through.
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(agentRequest().reasoning_effort).toBe("low");
  });

  it("does NOT default a non-voice caller on the streaming path — byte-for-byte unchanged (stream:true)", async () => {
    const res = await postChat(OWNER, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(agentRequest().reasoning_effort).toBeUndefined();
  });
});

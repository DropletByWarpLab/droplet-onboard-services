/**
 * WARP-2469 / WARP-2486 — the NON-STREAMING chat path must not egress the
 * interceptor's confirmation secret through the tool trace.
 *
 * A WARP-2305 challenge carries its 256-bit token inside
 * `error.details` (both nested under `interceptor` and flat, for the
 * WARP-640 chip). The agent loop's trace holds the RAW parsed payload,
 * and the non-streaming route both persists that trace and returns it in
 * the response body — so without a scrub, whoever holds the HTTP
 * response holds a live approval token the approval route itself
 * deliberately withholds. The streaming path never had this leak: its
 * SSE `tool_result` carries only the opaque `challengeId`.
 *
 * PAIRED assertions, per this suite's house style: the interceptor
 * secret is GONE, while a WARP-640 scene challenge — whose flat
 * `confirmationToken` is the client-facing "Approve & run" handle by
 * design — survives untouched. A scrub that stripped every
 * `confirmation_required` result would pass the absence half and break
 * the scene chip; the presence half catches that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
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
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
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
  resolveNcToken: vi.fn().mockResolvedValue("nc-token"),
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([{ name: "delete_file" }, { name: "run_scene" }]),
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
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: false }),
  getModelProvider: vi.fn().mockResolvedValue("local"),
  chat: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
}));

const { mockFinalize } = vi.hoisted(() => ({
  mockFinalize: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
    createTurnRows: vi.fn().mockResolvedValue({
      userMessageId: "um-1",
      assistantMessageId: "am-1",
      assistantAlreadyFinal: false,
    }),
    finalizeAssistantMessage: mockFinalize,
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

vi.mock("../services/vision-attachments.service.js", () => ({
  buildImageBlocks: vi.fn().mockResolvedValue({ blocks: [], usedItemIds: [] }),
  attachImageBlocksToLastUserMessage: vi.fn(),
  decideVisionRoute: () => ({ mode: "text", model: "m" }),
}));

vi.mock("../services/effective-access.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/effective-access.service.js")>();
  return {
    ...actual,
    resolveEffectiveAccess: vi.fn().mockResolvedValue({
      tier: "owner",
      cloud: true,
      connectors: {},
      features: [],
      toolDomains: [],
    }),
  };
});

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

/** The interceptor's minted secret — the thing that must never egress. */
const SECRET = "itc-secret-256-bit-do-not-egress";

/**
 * Byte-faithful to `interceptOutcomeToToolResult` in
 * `@droplet/tools-core` (interceptor.ts): the token rides in
 * `error.details` BOTH nested and flat.
 */
const INTERCEPTOR_CHALLENGE = {
  ok: false,
  status: "confirmation_required",
  error: {
    code: "CONFIRMATION_REQUIRED",
    message: "'delete_file' writes, so it needs a thumbs-up.",
    details: {
      interceptor: {
        outcome: "confirmation_required",
        tool: "delete_file",
        confirmationToken: SECRET,
        expiresAt: 1234567890,
      },
      confirmationToken: SECRET,
      type: "delete_file",
    },
  },
};

/**
 * A WARP-640 scene challenge. Its flat `confirmationToken` is the
 * CLIENT-FACING one-click handle (echoed to `POST /api/scenes/:id/run`)
 * and has no `interceptor` block — it must pass through untouched.
 */
const SCENE_CHALLENGE = {
  ok: false,
  status: "confirmation_required",
  error: {
    code: "CONFIRMATION_REQUIRED",
    message: "Running this scene needs your approval.",
    details: { type: "scene_run", sceneId: "s1", confirmationToken: "scene-token" },
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = {
      id: "owner-uuid",
      username: "stefan",
      role: "owner",
    };
    next();
  });
  const prisma = {
    // WARP-2652 — persona + business + workspace, absent here until now.
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

beforeEach(() => {
  mockFinalize.mockClear();
  mockRunAgent.mockReset().mockResolvedValue({
    message: { role: "assistant", content: "That needs your approval first." },
    trace: [
      {
        tool_call_id: "tc-1",
        tool: "delete_file",
        args: { path: "/Shared/x" },
        result: INTERCEPTOR_CHALLENGE,
      },
      {
        tool_call_id: "tc-2",
        tool: "run_scene",
        args: { sceneId: "s1" },
        result: SCENE_CHALLENGE,
      },
    ],
    iterations: 1,
    stop_reason: "model_done",
  });
});

async function postChat() {
  const res = await request(buildApp())
    .post("/api/llm/chat")
    .send({
      model: "llama3:8b",
      provider: "local",
      messages: [{ role: "user", content: "delete it" }],
    });
  expect(res.status).toBe(200);
  return res;
}


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
    await postChat();
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
});

describe("POST /api/llm/chat (non-streaming) — interceptor challenge trace", () => {
  it("returns the challenge without the interceptor secret, and keeps it legible", async () => {
    const res = await postChat();

    // MUTATION (drop the scrub before persistence/response): red here.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    // The scrub removes `error.details`, nothing else — the challenge is
    // still a renderable refusal, not a mangled one.
    const first = res.body.trace[0].result;
    expect(first.status).toBe("confirmation_required");
    expect(first.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(first.error.message).toContain("thumbs-up");
    expect(first.error.details).toBeUndefined();
  });

  it("persists the tool trace without the interceptor secret", async () => {
    await postChat();

    expect(mockFinalize).toHaveBeenCalled();
    const persisted = JSON.stringify(
      mockFinalize.mock.calls.map((c) => c[0].toolCalls),
    );
    expect(persisted).not.toContain(SECRET);
    // …while the trace itself was persisted, not emptied.
    expect(persisted).toContain("delete_file");
  });

  it("leaves the WARP-640 scene challenge untouched — the scrub subtracts, it does not empty", async () => {
    const res = await postChat();

    const scene = res.body.trace[1].result;
    expect(scene.error.details).toEqual({
      type: "scene_run",
      sceneId: "s1",
      confirmationToken: "scene-token",
    });
    expect(
      JSON.stringify(mockFinalize.mock.calls.map((c) => c[0].toolCalls)),
    ).toContain("scene-token");
  });
});

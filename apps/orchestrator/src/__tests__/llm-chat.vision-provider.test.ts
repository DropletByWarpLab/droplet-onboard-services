/**
 * WARP-904 (review fix) — the per-turn audit trail must persist the provider
 * of the model that ACTUALLY ran, not the provider the caller forwarded.
 *
 * When a user selects a non-vision cloud model (provider forwarded, e.g.
 * "openai"), attaches an image, and the box has a local VISION_MODEL
 * configured, the turn auto-routes to that local vision model. Before this
 * fix, routes/llm.ts persisted `model: <local vision model>` alongside
 * `provider: chatReq.provider` (the cloud provider) — an internally
 * inconsistent audit row (e.g. model:"llava:7b" + provider:"openai").
 *
 * This test drives the real route through the vision-reroute branch and
 * asserts finalizeAssistantMessage receives the vision model's provider,
 * not the user's original selection. The pure decideVisionRoute stays real;
 * only the disk/DB-bound buildImageBlocks and the gateway lookups are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// NB: literal inlined (not the VISION_MODEL const) — vi.mock is hoisted above
// the const, so referencing it here would throw a TDZ ReferenceError.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    // The local vision model image turns auto-route to when the selected
    // model can't see. Its provider ("ollama") is what the audit row must
    // record — NOT the cloud provider the caller forwarded.
    vision: { model: "llava:7b", maxImages: 3 },
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const VISION_MODEL = "llava:7b";

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
  mcpClient: { listTools: vi.fn().mockResolvedValue([]), callTool: vi.fn() },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));

// Keep the pure routing decision (decideVisionRoute) + message-splice
// (attachImageBlocksToLastUserMessage) REAL — only stub the disk/DB-bound
// image-block builder so we can force a "one image is renderable" turn.
vi.mock("../services/vision-attachments.service.js", async (importActual) => {
  const actual =
    await importActual<
      typeof import("../services/vision-attachments.service.js")
    >();
  return { ...actual, buildImageBlocks: vi.fn() };
});

// Gateway lookups drive the routing + provider derivation. runAgent is mocked
// so the gateway's chat() is never actually invoked.
const mockGetModelCapabilities = vi.fn();
const mockGetModelProvider = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelCapabilities: (...a: unknown[]) => mockGetModelCapabilities(...a),
  getModelProvider: (...a: unknown[]) => mockGetModelProvider(...a),
  chat: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
}));

const mockEnsureConversation = vi.fn();
const mockCreateTurnRows = vi.fn();
const mockFinalize = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: (...a: unknown[]) => mockEnsureConversation(...a),
    createTurnRows: (...a: unknown[]) => mockCreateTurnRows(...a),
    finalizeAssistantMessage: (...a: unknown[]) => mockFinalize(...a),
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

// WARP-1530: these turns are deliberately CLOUD turns (gpt-4o / provider
// "openai"), so /api/llm/chat's per-person cloud gate now resolves the
// caller's effective access before dispatching. Stubbed to "cloud allowed"
// — the subject here is the per-turn provider audit, not the gate, and the
// gate has its own suite (llm-chat.cloud-access.test.ts). Without this the
// unwired resolver fails closed with a 503, which is the correct posture.
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: vi.fn().mockResolvedValue({ cloud: true, connectors: {} }),
}));

import { createLlmRouter } from "../routes/llm.js";
import { buildImageBlocks } from "../services/vision-attachments.service.js";

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — see the helper's header: without these three delegates both
// block composers threw on every turn and the route's fail-open swallowed it.
guardComposerFailOpen();

const USER_ID = "user-uuid";

function createPrismaMock() {
  return {
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
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = {
      id: USER_ID,
      username: "test",
      role: "owner",
    };
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "A cat." },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockEnsureConversation.mockReset().mockResolvedValue({ id: "conv-1" });
  mockCreateTurnRows.mockReset().mockResolvedValue({
    userMessageId: "um-1",
    assistantMessageId: "am-1",
    assistantAlreadyFinal: false,
  });
  mockFinalize.mockReset().mockResolvedValue(undefined);
  mockGetModelCapabilities.mockReset().mockImplementation((model: string) =>
    // The user's cloud model can't see; the local vision model can.
    Promise.resolve(model === VISION_MODEL ? { vision: true } : { vision: false }),
  );
  mockGetModelProvider.mockReset().mockResolvedValue("ollama");
  vi.mocked(buildImageBlocks).mockReset().mockResolvedValue({
    blocks: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ],
    usedItemIds: ["img-1"],
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
        model: "gpt-4o",
        provider: "openai",
        messages: [{ role: "user", content: "what is in this image?" }],
      });

    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
});

describe("POST /api/llm/chat — per-turn provider audit (vision auto-route)", () => {
  it("persists the vision model's provider, not the caller's forwarded provider", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o", // non-vision cloud pick
        provider: "openai", // forwarded per this PR's per-turn provider wiring
        messages: [{ role: "user", content: "what is in this image?" }],
        attachments: [{ itemId: "img-1" }],
      });

    expect(res.status).toBe(200);

    // The turn actually ran on the local vision model...
    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockRunAgent.mock.calls.at(-1)![1]).toMatchObject({
      model: VISION_MODEL,
    });

    // ...and the persisted audit row must reflect that model AND its
    // provider — NOT model:"llava:7b" + provider:"openai".
    expect(mockFinalize).toHaveBeenCalled();
    const finalArg = mockFinalize.mock.calls.at(-1)![0] as {
      model?: string;
      provider?: string | null;
      status?: string;
    };
    expect(finalArg.status).toBe("completed");
    expect(finalArg.model).toBe(VISION_MODEL);
    expect(finalArg.provider).toBe("ollama");
    expect(finalArg.provider).not.toBe("openai");
    // The provider was resolved from the model that actually ran.
    expect(mockGetModelProvider).toHaveBeenCalledWith(VISION_MODEL);
  });

  it("keeps the caller's provider when the selected model can see (no reroute)", async () => {
    // A vision-capable selected model runs as-is; the caller's forwarded
    // provider must survive untouched (no model-list override).
    mockGetModelCapabilities.mockImplementation(() =>
      Promise.resolve({ vision: true }),
    );
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o", // vision-capable in this case
        provider: "openai",
        messages: [{ role: "user", content: "what is in this image?" }],
        attachments: [{ itemId: "img-1" }],
      });

    expect(res.status).toBe(200);
    // Ran on the selected model — no reroute.
    expect(mockRunAgent.mock.calls.at(-1)![1]).toMatchObject({ model: "gpt-4o" });
    const finalArg = mockFinalize.mock.calls.at(-1)![0] as {
      model?: string;
      provider?: string | null;
    };
    expect(finalArg.model).toBe("gpt-4o");
    expect(finalArg.provider).toBe("openai");
    // Provider was NOT re-derived from the model list (selected model kept).
    expect(mockGetModelProvider).not.toHaveBeenCalled();
  });
});

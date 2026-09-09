/**
 * WARP-2851 — POST /api/llm/chat budgets each turn against the window of the
 * model that actually runs, not against `OLLAMA_CONTEXT_LENGTH` for everyone.
 *
 * Before this, all three budget sites passed the same global, so a cloud model
 * was budgeted at the local Ollama window: the tool-advertisement ceiling
 * threw, `degradeToFit` dropped the business / persona / brain blocks, and the
 * in-loop guard ended the turn early — on a model with far more room.
 *
 * These assert on the `context_window` the route hands `runAgent`, because
 * that single value is what every downstream budget reads: the loop's
 * iteration guard AND `assertToolAdvertisementFitsBudget`'s ceiling both take
 * `req.context_window`.
 *
 * Harness mirrors llm-chat.empty-replay.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

const LOCAL_WINDOW = 16384;

/**
 * A LOCAL-shaped model id on purpose. The per-person cloud gate
 * (WARP-1530 / ADR-032 §3 axis (d)) refuses a cloud model with 503 long before
 * the budget code runs, and standing that gate up here would test the gate,
 * not the window. Window resolution is name-agnostic — it reads whatever the
 * catalogue reports for the model — so the cloud cases are driven by mocking
 * the ADVERTISED window, which is exactly the input under test.
 */
const MODEL = "gpt-oss:20b";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    OLLAMA_CONTEXT_LENGTH: 16384,
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

const mockGetModelContextWindow = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelContextWindow: (...a: unknown[]) => mockGetModelContextWindow(...a),
  getModelCapabilities: vi.fn().mockResolvedValue(undefined),
  getModelProvider: vi.fn().mockResolvedValue(undefined),
  chat: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
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

import { createLlmRouter } from "../routes/llm.js";
import { MAX_RESOLVABLE_CONTEXT_WINDOW } from "../services/context-budget.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";
import { readRepoFile } from "./helpers/test-paths.js";

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

beforeEach(() => {
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockGetModelContextWindow.mockReset();
});

/** The window the route budgeted this turn against. */
function budgetedWindow(): number {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as { context_window: number };
  return req.context_window;
}

async function send(model: string) {
  return request(buildApp())
    .post("/api/llm/chat")
    .send({
      model,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      ephemeral: true,
    });
}

describe("POST /api/llm/chat — per-model context window (WARP-2851)", () => {
  it("budgets a cloud model against its own window, capped to what the gateway can carry", async () => {
    mockGetModelContextWindow.mockResolvedValue(200_000); // anthropic

    const res = await send(MODEL);

    expect(res.status).toBe(200);
    expect(budgetedWindow()).toBe(MAX_RESOLVABLE_CONTEXT_WINDOW);
    // The regression this ticket exists for: it must no longer be the local
    // Ollama window.
    expect(budgetedWindow()).not.toBe(LOCAL_WINDOW);
    expect(budgetedWindow()).toBeGreaterThan(LOCAL_WINDOW);
  });

  it("looks the window up once per turn", async () => {
    mockGetModelContextWindow.mockResolvedValue(200_000);

    await send(MODEL);

    expect(mockGetModelContextWindow).toHaveBeenCalledTimes(1);
    expect(mockGetModelContextWindow).toHaveBeenCalledWith(MODEL);
  });
});

/**
 * The vision half of the AC, pinned at the SOURCE.
 *
 * Vision auto-routing can swap the caller's model for a local `VISION_MODEL`,
 * and the budget has to describe the model that actually runs. A behavioural
 * test cannot tell `agentModel` from `chatReq.model` here — with vision
 * inactive the two are equal, so the assertion would pass either way, which is
 * precisely the kind of test that looks like coverage and is not.
 *
 * What makes the behaviour correct is a source fact: the lookup reads
 * `agentModel`, and it does so AFTER the vision branch has assigned it. So
 * that is what this asserts, with a vacuity check on every pattern first —
 * a guard that finds nothing must fail, not pass.
 */
describe("WARP-2851 — the window is resolved for the post-vision model", () => {
  const source = readRepoFile("apps/orchestrator/src/routes/llm.ts");

  it("reads the route source (vacuity check)", () => {
    expect(source.length).toBeGreaterThan(0);
    expect(source).toContain("getModelContextWindow");
  });

  it("looks up `agentModel`, never `chatReq.model`", () => {
    expect(source).toContain("getModelContextWindow(agentModel)");
    expect(source).not.toContain("getModelContextWindow(chatReq.model)");
  });

  it("resolves AFTER vision auto-routing has settled `agentModel`", () => {
    const visionSwap = source.indexOf("agentModel = route.model");
    const lookup = source.indexOf("getModelContextWindow(agentModel)");

    // Vacuity: both anchors must exist, or the ordering claim is empty.
    expect(visionSwap).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);

    expect(lookup).toBeGreaterThan(visionSwap);
  });

  it("leaves no budget site on the raw local window", () => {
    // The defect was three call sites passing `config.OLLAMA_CONTEXT_LENGTH`.
    // It may now appear ONLY as the resolver's `localWindow` fallback and in
    // the log line — never as a `contextWindow:` / `context_window:` argument.
    expect(source).not.toContain("contextWindow: config.OLLAMA_CONTEXT_LENGTH");
    expect(source).not.toContain("context_window: config.OLLAMA_CONTEXT_LENGTH");
    // Vacuity: the fallback really is still wired, so the negatives above are
    // not passing merely because the constant vanished entirely.
    expect(source).toContain("localWindow: config.OLLAMA_CONTEXT_LENGTH");
  });
});

/**
 * Fail-safe direction is DOWN. Every path where the catalogue cannot vouch for
 * a window resolves to the local one — and, just as importantly, still answers
 * the user. A budget optimisation must never cost a turn.
 */
describe("POST /api/llm/chat — falls back without failing the turn", () => {
  it("falls back to the local window when the provider publishes none", async () => {
    // ollama_local.py ships context_window=None for every model it serves.
    mockGetModelContextWindow.mockResolvedValue(null);

    await send(MODEL);

    expect(budgetedWindow()).toBe(LOCAL_WINDOW);
  });

  it("falls back to the local window when the model is unknown", async () => {
    mockGetModelContextWindow.mockResolvedValue(undefined);

    await send("some-model-nobody-registered");

    expect(budgetedWindow()).toBe(LOCAL_WINDOW);
  });

  it("falls back — and still answers — when the gateway lookup REJECTS", async () => {
    mockGetModelContextWindow.mockRejectedValue(new Error("gateway unreachable"));

    const res = await send(MODEL);

    expect(res.status).toBe(200);
    expect(budgetedWindow()).toBe(LOCAL_WINDOW);
  });

  it("falls back — and still answers — when the lookup THROWS SYNCHRONOUSLY", async () => {
    // The `.catch()` trap this route already documents for the WARP-1921
    // continuity lookup: a module double that predates this export makes the
    // call throw a TypeError before any promise exists, so `.catch()` would
    // not see it and every chat turn would 500. Only try/catch survives this.
    mockGetModelContextWindow.mockImplementation(() => {
      throw new TypeError("getModelContextWindow is not a function");
    });

    const res = await send(MODEL);

    expect(res.status).toBe(200);
    expect(budgetedWindow()).toBe(LOCAL_WINDOW);
  });
});

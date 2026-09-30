/**
 * WARP-3116 — POST /api/llm/chat carries the dashboard's page list to the
 * navigation tools, and only a dashboard turn is told they exist.
 *
 * The pairs matter: a turn WITH pages proves the list reaches the dispatch
 * context and the guidance line renders; the same turn WITHOUT proves both
 * are absent. Either half alone would pass against a route that ignored the
 * field entirely.
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
vi.mock("../services/brain/brain-block.service.js", () => ({
  buildBrainBlock: vi.fn(async () => ""),
  BRAIN_BLOCK_CHAR_BUDGET: 2000,
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-token"),
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([
      { name: "search_content" },
      { name: "find_dashboard_page" },
      { name: "open_dashboard_page" },
    ]),
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
  getModelContextWindow: vi.fn().mockResolvedValue(null),
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: false }),
  getModelProvider: vi.fn().mockResolvedValue("local"),
  chat: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
}));

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
    createTurnRows: vi.fn().mockResolvedValue({
      userMessageId: "um-1",
      assistantMessageId: "am-1",
      assistantAlreadyFinal: false,
    }),
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

guardComposerFailOpen();

const PAGES = [
  { href: "/voice", label: "Voice", section: "Systems › Network" },
  { href: "/settings", label: "Settings", section: "Admin" },
];

function buildApp() {
  const prisma = {
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
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

/** runAgent(deps, opts) — the options are the SECOND argument. */
function runOpts(): {
  allowed_tools?: string[];
  messages: { role: string; content: unknown }[];
  toolCallContext?: { dashboardPages?: unknown };
} {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls[0][1];
}

function systemPrompt(): string {
  return JSON.stringify(runOpts().messages.filter((m) => m.role === "system"));
}

const turn = (extra: Record<string, unknown> = {}) => ({
  model: "llama3:8b",
  messages: [{ role: "user", content: "take me to voice settings" }],
  ...extra,
});

beforeEach(() => {
  mockRunAgent.mockReset().mockResolvedValue({
    message: { role: "assistant", content: "Opening Voice." },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — dashboardPages (WARP-3116)", () => {
  it("forwards the page list to the tool dispatch and names the tools", async () => {
    const res = await request(buildApp()).post("/api/llm/chat").send(turn({ dashboardPages: PAGES }));

    expect(res.status).toBe(200);
    expect(runOpts().toolCallContext?.dashboardPages).toEqual(PAGES);
    expect(systemPrompt()).toContain("find_dashboard_page");
  });

  it("carries no list and names no navigation tool on a turn without one", async () => {
    const res = await request(buildApp()).post("/api/llm/chat").send(turn());

    expect(res.status).toBe(200);
    expect(runOpts().toolCallContext?.dashboardPages).toBeUndefined();
    expect(systemPrompt()).not.toContain("open_dashboard_page");
    expect(systemPrompt()).not.toContain("find_dashboard_page");
  });

  it("leaves the owner's default tool scope alone either way", async () => {
    // Withholding happens where the pool is built, not by materialising the
    // owner's `undefined` — an explicit list would skip the chat exclusions.
    await request(buildApp()).post("/api/llm/chat").send(turn());
    expect(runOpts().allowed_tools).toBeUndefined();
  });

  it("drops a page list that could leave the origin — the turn runs without navigation", async () => {
    // Navigation metadata must never cost the person their answer: a bad
    // list withholds the tools for this turn instead of 400ing it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(buildApp())
      .post("/api/llm/chat")
      .send(turn({ dashboardPages: [{ href: "//evil.example", label: "Evil" }] }));

    expect(res.status).toBe(200);
    expect(runOpts().toolCallContext?.dashboardPages).toBeUndefined();
    expect(systemPrompt()).not.toContain("find_dashboard_page");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dashboardPages rejected"),
      expect.anything(),
    );
    warn.mockRestore();
  });
});

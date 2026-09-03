/**
 * WARP-1529 (RBAC v2 T5) — the wiring: /api/llm/chat resolves the caller's
 * §3 tool scope once per turn and hands the SAME scope to both enforcement
 * points (the `allowed_tools` narrowing and the agent loop, which re-checks
 * it at dispatch).
 *
 * Route harness mirrors llm-chat.interview.test.ts.
 *
 * WARP-2619 — `TOOL_SELECTION_MODE` is PINNED in the config mock below (the
 * WARP-2608 pattern). Note the name collision: the narrowing this file is
 * about is the §3 RBAC one, NOT the relevance-based advertisement that
 * variable controls — and the two run on the same turn, which is precisely
 * why the mode has to be stated rather than left to whatever `undefined`
 * happens to mean. No assertion below discriminates between the two modes
 * today (they all read `allowed_tools` / `toolAccessScope`, which selection
 * does not touch); the pin is what keeps that a checkable claim instead of an
 * accident.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// WARP-2619 — `TOOL_SELECTION_MODE` was ABSENT here, and absence is not
// neutral: `selectAdvertisedTools` short-circuits to "advertise the whole
// pool" on `mode === "off"` ONLY, so the `undefined` this mock supplied fell
// through to the narrowing branch and the suite exercised `domains` by
// accident. Boxes ship `domains` (`apps/orchestrator/src/config.ts`), so the
// pin states outright what the turns here run under, and a future flip of the
// config default cannot silently change what this file measures. Typed as the
// union, not the literal, so a case can assign the rollback value.
const h = vi.hoisted(() => ({
  config: {
    AUTH_ENABLED: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "domains" as "off" | "domains",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: h.config }));

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
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));
const mockListTools = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: (...args: unknown[]) => mockListTools(...args),
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
const resolveEffectiveAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

import { createLlmRouter } from "../routes/llm.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";

const REGISTRY = [
  { name: "list_files" },
  { name: "write_file" },
  { name: "list_cameras" },
  { name: "control_device" },
];

function createPrismaMock(accessRoleId: string | null) {
  return {
    user: {
      findUnique: vi.fn(async () => ({
        accessRoleId,
        accessRole:
          accessRoleId === null
            ? null
            : { toolGrants: [{ domain: "files", level: "use" }] },
      })),
    },
    workspace: { findUnique: vi.fn(async () => ({ id: 1, type: "BUSINESS" })) },
    businessProfile: { findUnique: vi.fn(async () => null), create: vi.fn() },
    assistantPersona: { findUnique: vi.fn(async () => null), create: vi.fn(), upsert: vi.fn() },
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>, role: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = {
      id: "u-1",
      username: "sam",
      role,
    };
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

const agentRequest = () =>
  mockRunAgent.mock.calls.at(-1)![1] as {
    allowed_tools?: string[];
    toolAccessScope?: ToolAccessScope | null;
  };

const chat = (app: express.Express, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }], ...body });

beforeEach(() => {
  h.config.TOOL_SELECTION_MODE = "domains";
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockListTools.mockReset();
  mockListTools.mockResolvedValue(REGISTRY);
  resolveEffectiveAccessMock.mockReset();
});

describe("/api/llm/chat — §3 tool scope wiring", () => {
  it("hands the resolved scope to the agent loop for a role holder", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const res = await chat(buildApp(createPrismaMock("role-1"), "admin"));
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect([...req.toolAccessScope!.domains]).toEqual(["files"]);
    expect([...req.toolAccessScope!.writeDomains]).toEqual(["files"]);
  });

  it("narrows an explicit client allowed_tools list before the loop sees it", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const res = await chat(buildApp(createPrismaMock("role-1"), "admin"), {
      // the stale shelf
      allowed_tools: ["list_files", "list_cameras", "control_device"],
    });
    expect(res.status).toBe(200);
    expect(agentRequest().allowed_tools).toEqual(["list_files"]);
  });

  it("passes NO scope for a user with no AccessRole — today's behavior, bit-for-bit", async () => {
    const prisma = createPrismaMock(null);
    const res = await chat(buildApp(prisma, "family"), {
      allowed_tools: ["list_files", "list_cameras", "control_device"],
    });
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.toolAccessScope).toBeNull();
    // Only the shipped ADR-004 write filter applied — every domain survives.
    expect(req.allowed_tools).toEqual(["list_files", "list_cameras"]);
    // The heavy §3 resolve is never consulted on this path.
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("passes NO scope for the owner — §3 bypass", async () => {
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      allowed_tools: ["list_files", "control_device"],
    });
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.toolAccessScope).toBeNull();
    expect(req.allowed_tools).toEqual(["list_files", "control_device"]);
  });

  it("fails CLOSED when the scope cannot be resolved", async () => {
    resolveEffectiveAccessMock.mockRejectedValue(new Error("db down"));
    const res = await chat(buildApp(createPrismaMock("role-1"), "admin"), {
      allowed_tools: ["list_files", "list_cameras"],
    });
    expect(res.status).toBe(200);
    expect(agentRequest().allowed_tools).toEqual([]);
  });
});

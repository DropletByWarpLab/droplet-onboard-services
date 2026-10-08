/**
 * WARP-2972 — the WIRING: /api/llm/chat resolves the module verdict ONCE per
 * turn, for the session's `User.id`, and hands the same value to the three
 * places that must agree — the agent loop's pool, the budget estimate, and the
 * tool-guidance block.
 *
 * The §3 tool scope is NULL for the owner and for everybody with no AccessRole
 * (`rbac-tool-narrowing.route.test.ts` pins that), and a null scope narrows
 * nothing. The verdict is a separate axis, so it reaches exactly those people.
 *
 * Harness mirrors rbac-tool-narrowing.route.test.ts (the agent loop is a spy;
 * what is asserted is what the route SHIPPED it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

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
  ChatPersistenceService: vi.fn().mockImplementation(function () {
    return {
      ensureConversation: vi.fn(async () => null),
      createTurnRows: vi.fn().mockResolvedValue(null),
      finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
      updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
      listConversationsForUser: vi.fn().mockResolvedValue([]),
      getConversationForUser: vi.fn().mockResolvedValue(null),
      deleteConversationForUser: vi.fn().mockResolvedValue(false),
      getConversationToolNames: vi.fn().mockResolvedValue([]),
    };
  }),
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
import type { ModuleVerdict } from "@droplet/tools-core";
import type { ChatMessage } from "../types/index.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";
import {
  _setToolModuleVerdictForTests,
  type ModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";
import { readPackageFile } from "./helpers/test-paths.js";

const REGISTRY = [
  { name: "find_dashboard_page" },
  { name: "list_files" },
  { name: "list_cameras" },
  { name: "search_camera_events" },
  { name: "list_network_devices" },
];

function createPrismaMock(accessRoleId: string | null) {
  return {
    user: {
      findUnique: vi.fn(async () => ({
        accessRoleId,
        accessRole:
          accessRoleId === null ? null : { toolGrants: [{ domain: "files", level: "use" }] },
      })),
    },
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>, user: Record<string, string>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

const OWNER = { id: "u-owner", username: "olive", role: "owner" };
const FAMILY = { id: "u-fam", username: "fay", role: "family" };
const VOICE = { id: "_service:voice", username: "_service:voice", role: "service" };

const withheld = (...domains: string[]): ModuleVerdict => ({ withheldDomains: new Set(domains) });

const agentRequest = () =>
  mockRunAgent.mock.calls.at(-1)![1] as {
    toolAccessScope?: ToolAccessScope | null;
    moduleVerdict?: ModuleVerdict;
    messages: ChatMessage[];
  };

const systemPromptText = (): string => {
  const sys = agentRequest().messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
};

const chat = (app: express.Express, extra: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }], ...extra });

guardComposerFailOpen();

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

afterEach(() => _setToolModuleVerdictForTests(async () => withheld()));

describe("/api/llm/chat — the module verdict reaches the agent loop", () => {
  it("hands the OWNER (null §3 scope) the verdict, resolved for their User.id", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld("cameras"));
    _setToolModuleVerdictForTests(resolver);
    const res = await chat(buildApp(createPrismaMock(null), OWNER));
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.toolAccessScope).toBeNull();
    expect(req.moduleVerdict!.withheldDomains.has("cameras")).toBe(true);
    expect(resolver).toHaveBeenCalledWith("u-owner");
  });

  it("hands a ROLE-LESS family member the verdict too", async () => {
    _setToolModuleVerdictForTests(async () => withheld("cameras"));
    const res = await chat(buildApp(createPrismaMock(null), FAMILY));
    expect(res.status).toBe(200);
    const req = agentRequest();
    expect(req.toolAccessScope).toBeNull();
    expect(req.moduleVerdict!.withheldDomains.has("cameras")).toBe(true);
  });

  it("resolves once per turn, not once per consumer", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld("cameras"));
    _setToolModuleVerdictForTests(resolver);
    await chat(buildApp(createPrismaMock(null), OWNER));
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("a service principal (voice) is the box, keyed on its own id", async () => {
    const resolver = vi.fn<ModuleVerdictResolver>(async () => withheld("smart-home"));
    _setToolModuleVerdictForTests(resolver);
    await chat(buildApp(createPrismaMock(null), VOICE));
    expect(resolver).toHaveBeenCalledWith("_service:voice");
  });

  it("an unwired process ships the FAIL-CLOSED verdict, and the turn still answers", async () => {
    _setToolModuleVerdictForTests(null);
    const res = await chat(buildApp(createPrismaMock(null), OWNER));
    expect(res.status).toBe(200);
    const w = agentRequest().moduleVerdict!.withheldDomains;
    expect(w.has("cameras")).toBe(true);
    expect(w.has("system")).toBe(false);
  });
});

describe("/api/llm/chat — tool guidance never names a tool the pool no longer holds", () => {
  it("names the camera tools while the module is on", async () => {
    const res = await chat(buildApp(createPrismaMock(null), OWNER));
    expect(res.status).toBe(200);
    expect(systemPromptText()).toContain("Cameras: list_cameras");
  });

  it("drops the camera guidance for an owner when the module is off", async () => {
    // The owner's allowed set is `undefined` ("every tool"): the case a naive
    // filter on the allowed list would miss.
    _setToolModuleVerdictForTests(async () => withheld("cameras"));
    const res = await chat(buildApp(createPrismaMock(null), OWNER));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).not.toContain("Cameras: list_cameras");
    expect(sys).not.toContain("list_cameras");
  });

  it("drops it for a role-less family member too (their allowed list is materialised)", async () => {
    _setToolModuleVerdictForTests(async () => withheld("cameras"));
    await chat(buildApp(createPrismaMock(null), FAMILY));
    expect(systemPromptText()).not.toContain("Cameras: list_cameras");
  });
});

describe("/api/llm/chat — module gating and stage's navigation withholding both reach guidance (WARP-3116)", () => {
  // The two axes are independent: `navigationWithheld` (no dashboard page list)
  // and the module verdict. Guidance must honour BOTH at BOTH call sites.
  const PAGES = [{ href: "/network", label: "Network" }];

  it("a turn with no page list names neither the withheld module's tools nor the navigation tool", async () => {
    _setToolModuleVerdictForTests(async () => withheld("cameras"));
    await chat(buildApp(createPrismaMock(null), OWNER));
    const sys = systemPromptText();
    expect(sys).not.toContain("Cameras: list_cameras");
    expect(sys).not.toContain("find_dashboard_page");
  });

  it("a dashboard turn names the navigation tool and still not the withheld module's", async () => {
    _setToolModuleVerdictForTests(async () => withheld("cameras"));
    await chat(buildApp(createPrismaMock(null), OWNER), { dashboardPages: PAGES });
    const sys = systemPromptText();
    expect(sys).toContain("find_dashboard_page");
    expect(sys).not.toContain("Cameras: list_cameras");
  });

  it("with every module on, a dashboard turn names both (the control)", async () => {
    await chat(buildApp(createPrismaMock(null), OWNER), { dashboardPages: PAGES });
    const sys = systemPromptText();
    expect(sys).toContain("find_dashboard_page");
    expect(sys).toContain("Cameras: list_cameras");
  });

  it("the budget estimate's guidance carries both too: an oversized pool never shows in the sized prompt", async () => {
    // The estimate composes guidance with `(names, "", "", dateLine, navigationWithheld)`
    // (WARP-3281 added `dateLine` ahead of the navigation set);
    // a source pin, in the style of tool-selection.parity.test.ts, because the
    // estimate's inputs are not observable through the mocked agent loop.
    const src = readPackageFile("src", "routes/llm.ts");
    expect(src).toMatch(
      /buildBaseSystemPrompt\(\s*namesForGuidance\(allowedForUser, moduleVerdict\),\s*"",\s*"",\s*dateLine,\s*navigationWithheld,?\s*\)/,
    );
    expect(src).toMatch(
      /buildBaseSystemPrompt\(\s*namesForGuidance\(allowedForUser, moduleVerdict\),\s*degraded\.personaBlock,\s*degraded\.businessBlock,\s*dateLine,\s*navigationWithheld,?\s*\)/,
    );
  });
});

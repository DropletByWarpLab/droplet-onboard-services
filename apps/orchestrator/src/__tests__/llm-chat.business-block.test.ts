/**
 * WARP-1120 (Phase 2, §8/§10/§15) — the role-filtered business block is
 * injected into the base system prompt AFTER the persona block and BEFORE
 * tool guidance, and ONLY while `Workspace.type === 'BUSINESS'`.
 *
 * The load-bearing guarantees proven end-to-end here (not just at the unit
 * level in business-profile.service.test.ts):
 *   - a filled profile appears in an owner's assembled prompt, inside the §15
 *     data-framing delimiter, positioned identity → persona → business →
 *     tool guidance;
 *   - a HOME-typed box injects NOTHING even with a committed profile;
 *   - the model never leaks what the API hides — a family prompt carries the
 *     summary only, a guest prompt carries no business block at all;
 *   - the block feeds the context estimator (`sizeParts.businessBlock`), so a
 *     forced overflow drops it (it is no longer hardcoded "");
 *   - a profile/workspace read failure fail-opens to no business block.
 *
 * Mirrors llm-chat.persona-block.test.ts's route harness.
 *
 * WARP-2608 — `TOOL_SELECTION_MODE` is PINNED in the config mock below, because
 * it is what decides how much of the tool pool the budget assertions here are
 * measured against; the last describe block is meaningless without it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Mutable so a single test can force a tiny context window; a stable object
// reference means llm.ts reading `config.OLLAMA_CONTEXT_LENGTH` sees mutations.
//
// WARP-2608 — `TOOL_SELECTION_MODE` was ABSENT from this mock, and an absent
// key here is not neutral. `routes/llm.ts` charges the context budget for the
// tool schemas this turn will actually advertise, derived through
// `effectiveAdvertisedToolNames({ mode: config.TOOL_SELECTION_MODE, … })`, and
// `selectAdvertisedTools` short-circuits to "the whole pool" on
// `mode === "off"` ONLY. Anything else — `"domains"`, or the `undefined` this
// mock was supplying — falls through to the narrowing branch. So the suite was
// exercising `domains` behaviour by accident, and would have kept doing so if
// `config.ts`'s default were flipped back to `off`: the value it measures had
// no connection to the value boxes ship.
//
// Boxes ship `domains` (`apps/orchestrator/src/config.ts` —
// `z.enum(["off","domains"]).default("domains")`), so `domains` is what the
// default here states outright. The `off` rollback path is a real, supported
// configuration, so it keeps one explicit case of its own below rather than
// being reachable only by omission. Typed as the union, not the literal, so a
// test can assign the other value.
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
  })),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";
import type { ChatMessage } from "../types/index.js";
import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";

const FILLED_PROFILE = {
  id: "singleton",
  onboardingState: "completed",
  interviewChatId: null,
  summary: "SUMMARY_SENTINEL — a small dental practice in Boise.",
  whatWeDo: "WHATWEDO_SENTINEL",
  customers: "CUSTOMERS_SENTINEL",
  teamShape: "TEAMSHAPE_SENTINEL",
  toolsUsed: "TOOLSUSED_SENTINEL",
  typicalDay: "TYPICALDAY_SENTINEL",
  goals: "GOALS_SENTINEL_pain_points",
  lastSource: "onboarding",
  reviewNudgeState: "none",
  reviewDueAt: null,
  reviewDismissedAt: null,
  updatedBy: null,
  updatedAt: new Date("2026-07-08T00:00:00Z"),
};

const RESTRICTED_FIELD_SENTINELS = [
  "WHATWEDO_SENTINEL",
  "CUSTOMERS_SENTINEL",
  "TEAMSHAPE_SENTINEL",
  "TOOLSUSED_SENTINEL",
  "TYPICALDAY_SENTINEL",
  "GOALS_SENTINEL_pain_points",
];

function createPrismaMock(opts: {
  workspaceType?: "HOME" | "BUSINESS";
  profile?: typeof FILLED_PROFILE | null;
  workspaceThrows?: boolean;
} = {}) {
  const workspaceType = opts.workspaceType ?? "BUSINESS";
  const profile = opts.profile === undefined ? FILLED_PROFILE : opts.profile;
  return {
    workspace: {
      findUnique: vi.fn(async () => {
        if (opts.workspaceThrows) throw new Error("workspace read down");
        return { id: 1, type: workspaceType };
      }),
    },
    businessProfile: {
      findUnique: vi.fn(async () => profile),
      create: vi.fn(async () => profile ?? FILLED_PROFILE),
    },
    assistantPersona: {
      findUnique: vi.fn(async () => ({
        id: "singleton",
        preset: "founder",
        verbosity: "concise",
        useFirstNames: true,
        customInstructions: "",
        updatedBy: null,
        updatedAt: new Date("2026-07-08T00:00:00Z"),
      })),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(
  prisma: ReturnType<typeof createPrismaMock>,
  role = "owner",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const asUser = { id: "owner-uuid", username: "stefan", role };
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

function systemPromptText(): string {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

async function chat(app: express.Express) {
  return request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }] });
}

beforeEach(() => {
  h.config.OLLAMA_CONTEXT_LENGTH = 16384;
  h.config.TOOL_SELECTION_MODE = "domains";
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("POST /api/llm/chat — business block injection (§8/§10)", () => {
  it("injects the role-filtered block after persona and before tool guidance (owner, BUSINESS)", async () => {
    const res = await chat(buildApp(createPrismaMock({ workspaceType: "BUSINESS" })));
    expect(res.status).toBe(200);
    const sys = systemPromptText();

    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(sys).toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(sys).toContain(s);

    // Positioning: identity → persona → business → tool guidance.
    const idIdx = sys.indexOf("You are Droplet");
    const personaIdx = sys.indexOf(PERSONA_BLOCK_PREFIX);
    const businessIdx = sys.indexOf(BUSINESS_BLOCK_DELIMITER_OPEN);
    const guidanceIdx = sys.indexOf("Tool guidance:");
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeGreaterThan(idIdx);
    expect(businessIdx).toBeGreaterThan(personaIdx);
    expect(guidanceIdx).toBeGreaterThan(businessIdx);
  });

  it("injects NOTHING on a HOME-typed box even with a committed profile", async () => {
    const prisma = createPrismaMock({ workspaceType: "HOME" });
    const res = await chat(buildApp(prisma));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(sys).not.toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(sys).not.toContain(s);
    // On a HOME box the profile is never even read (short-circuit before the
    // create-on-read materialises a row).
    expect(prisma.businessProfile.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/llm/chat — business block role-leak matrix (§15)", () => {
  it("family sees the summary ONLY — zero restricted-field text in the prompt", async () => {
    const res = await chat(buildApp(createPrismaMock({ workspaceType: "BUSINESS" }), "family"));
    const sys = systemPromptText();
    expect(sys).toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(sys).not.toContain(s);
  });

  it("guest gets NO business block at all", async () => {
    const res = await chat(buildApp(createPrismaMock({ workspaceType: "BUSINESS" }), "guest"));
    const sys = systemPromptText();
    expect(sys).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(sys).not.toContain("SUMMARY_SENTINEL");
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(sys).not.toContain(s);
  });
});

describe("POST /api/llm/chat — business block resilience + budget", () => {
  it("fail-opens to no business block when the workspace read throws", async () => {
    const prisma = createPrismaMock({ workspaceType: "BUSINESS", workspaceThrows: true });
    const res = await chat(buildApp(prisma));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    // Identity + tool guidance still assemble; business is simply absent.
    expect(sys).toContain("You are Droplet");
    expect(sys).toContain("Tool guidance:");
    expect(sys).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });

  it("feeds the estimator so a forced overflow DROPS the business block", async () => {
    // Same filled BUSINESS profile that injects at 16384 (proven above); a
    // tiny window forces degradation. If sizeParts.businessBlock were still
    // hardcoded "", this couldn't distinguish — but the positive test proves
    // it composes, so absence here is a genuine estimator drop.
    h.config.OLLAMA_CONTEXT_LENGTH = 64;
    const res = await chat(buildApp(createPrismaMock({ workspaceType: "BUSINESS" })));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain("You are Droplet"); // identity never dropped
    expect(sys).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    for (const s of RESTRICTED_FIELD_SENTINELS) expect(sys).not.toContain(s);
  });

  it("the legacy TOOL_SELECTION_MODE=off path charges the WHOLE pool, and that costs the business block", async () => {
    // WARP-2608 — `off` is a supported rollback (`docs/ENVIRONMENT.md` calls it
    // the kill switch), so it gets a case rather than being what the suite
    // silently measured. It is asserted COMPARATIVELY: the same request, the
    // same SHIPPED 16,384-token window, the same profile — only the mode
    // differs. Nothing here is a hardcoded token count, so the assertion
    // survives the pool changing size; what it pins is that the mode is what
    // decides.
    //
    // Measured on this fixture: `domains` charges ~2.3K tokens of tool schemas
    // and everything fits, while `off` charges the full chat pool and the
    // estimate reaches ~15,939 against the ~15,360 ceiling — so `degradeToFit`
    // drops the business block (and then the persona block) on an ordinary
    // turn. That is the WARP-2552 finding restated as a test: the cost of the
    // rollback is not neutral, and it is not visible anywhere else.
    //
    // Goes red if `off` ever starts narrowing the pool (it would then behave
    // like `domains` and keep the block), or if the estimate stops being fed
    // the advertised set at all.
    const app = buildApp(createPrismaMock({ workspaceType: "BUSINESS" }));

    h.config.TOOL_SELECTION_MODE = "domains";
    expect((await chat(app)).status).toBe(200);
    const shipped = systemPromptText();

    h.config.TOOL_SELECTION_MODE = "off";
    expect((await chat(app)).status).toBe(200);
    const legacy = systemPromptText();

    expect(shipped).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(legacy).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    // Identity + tool guidance are never-dropped parts under either mode — so
    // the difference above is the estimator, not a broken prompt assembly.
    for (const sys of [shipped, legacy]) {
      expect(sys).toContain("You are Droplet");
      expect(sys).toContain("Tool guidance:");
    }
  });
});

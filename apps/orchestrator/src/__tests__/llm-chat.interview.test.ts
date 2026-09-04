/**
 * WARP-1121 (Phase 3, §9.3) — the interview conductor overlay on /api/llm/chat.
 *
 * Proven end-to-end here (units live in business-onboarding.service.test.ts):
 *   - the conductor block is appended AFTER the base prompt only when
 *     `conversationId === interviewChatId` and the state is live
 *     (in_progress|re_running) — never on ordinary conversations, never
 *     when the interview is over;
 *   - write tools are stripped SERVER-SIDE on interview turns even for the
 *     owner and even when the client explicitly requests them (D-5/§15);
 *   - the conductor SURVIVES a forced context-window overflow (it rides in
 *     the never-dropped identity part) while business/persona degrade away;
 *   - an overlay-probe failure fail-opens to a normal chat turn.
 *
 * Mirrors llm-chat.business-block.test.ts's route harness.
 *
 * WARP-2619 — `TOOL_SELECTION_MODE` is PINNED in the config mock below, the
 * same omission WARP-2608 fixed next door. It is an input to this file's
 * subject rather than background: what survives `degradeToFit` depends on the
 * tool-schema estimate, and that estimate is sized through
 * `effectiveAdvertisedToolNames({ mode: config.TOOL_SELECTION_MODE, … })`.
 * Measured today, no assertion here changes verdict between the two modes —
 * interview turns are spared because the overlay pins a write-free tool list,
 * which shrinks the pool before the estimate is taken. That is a property of
 * the current fixtures, not a guarantee, which is exactly why the mode is
 * stated rather than inherited from an absent key.
 *
 * WARP-2631 — the last describe block makes the mode load-bearing here, on an
 * ORDINARY conversation (no overlay, so the full chat pool) where it costs
 * something: under `off` the pool no longer fits the shipped 16,384 window and
 * `degradeToFit` drops the business block, which this file can see directly in
 * the system prompt. The same block covers the WARP-1921 cross-turn continuity
 * read at `routes/llm.ts:1320`, which was silently inert here because the
 * `ChatPersistenceService` double had no `getConversationToolNames`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// WARP-2619 — an absent `TOOL_SELECTION_MODE` here was not neutral:
// `selectAdvertisedTools` short-circuits to the whole pool on `mode === "off"`
// ONLY, so `undefined` fell through to the narrowing branch and this suite
// measured `domains` by accident — and would have gone on doing so if
// `config.ts`'s default were flipped back. Boxes ship `domains`
// (`apps/orchestrator/src/config.ts`), so that is what is pinned. Typed as the
// union, not the literal, so a case can assign the `off` rollback.
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
// WARP-2631 — the persistence double, now with the two knobs continuity needs.
//
// `sessionId` defaults to `null`, reproducing the previous
// `ensureConversation: () => null` exactly: the route's local `conversationId`
// stays null (`routes/llm.ts:1176`), so every pre-existing case below runs
// unchanged. Only the WARP-2631 cases set it.
//
// `getConversationToolNames` was MISSING, and absence was not inert:
// `routes/llm.ts:1320` calls it on every non-`off` turn that has a
// conversation, and a missing method throws `TypeError` synchronously — caught
// by the deliberate fail-open, so the file stayed green while every turn
// advertised `priorToolNames: []`. A double that omits a method the route calls
// does not exercise the fail-open; it hides the input.
const persistence = vi.hoisted(() => ({
  sessionId: null as string | null,
  getConversationToolNames: vi.fn<(id: string, userId: string) => Promise<string[]>>(),
}));
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn(async () =>
      persistence.sessionId ? { id: persistence.sessionId } : null,
    ),
    createTurnRows: vi.fn().mockResolvedValue(null),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    getConversationToolNames: persistence.getConversationToolNames,
  })),
}));

const mockRunAgent = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

import { createLlmRouter } from "../routes/llm.js";
import type { ChatMessage } from "../types/index.js";
import {
  INTERVIEW_CONDUCTOR_BLOCK,
} from "../services/business-onboarding.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  effectiveAdvertisedToolNames,
  type SelectionMessage,
} from "../services/tool-selection.service.js";
import { guardComposerFailOpen } from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — this file's persona and business fixtures are already correct
// (it is the one chat-route suite that always rendered both blocks). The guard
// keeps it that way; the single case that WANTS the profile read to throw
// declares it.
const composers = guardComposerFailOpen();

/** The live interview conversation id — must be a UUID (chat zod schema). */
const INTERVIEW_ID = "7b9e4a80-33f1-4bfa-9c65-0d1f6f0e2a11";
const OTHER_ID = "1c2d3e4f-5a6b-4c8d-9e0f-a1b2c3d4e5f6";

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "singleton",
    onboardingState: "in_progress",
    interviewChatId: INTERVIEW_ID,
    summary: "SUMMARY_SENTINEL small dental practice",
    whatWeDo: "",
    customers: "",
    teamShape: "",
    toolsUsed: "",
    typicalDay: "",
    goals: "",
    lastSource: null,
    reviewNudgeState: "none",
    reviewDueAt: null,
    reviewDismissedAt: null,
    updatedBy: null,
    updatedAt: new Date("2026-07-09T00:00:00Z"),
    ...overrides,
  };
}

function createPrismaMock(opts: {
  profile?: ReturnType<typeof makeProfile> | null;
  profileThrows?: boolean;
} = {}) {
  const profile = opts.profile === undefined ? makeProfile() : opts.profile;
  return {
    workspace: {
      findUnique: vi.fn(async () => ({ id: 1, type: "BUSINESS" })),
    },
    businessProfile: {
      findUnique: vi.fn(async () => {
        if (opts.profileThrows) throw new Error("profile read down");
        return profile;
      }),
      create: vi.fn(async () => profile),
    },
    assistantPersona: {
      findUnique: vi.fn(async () => ({
        id: "singleton",
        preset: "warm_friendly",
        verbosity: "balanced",
        useFirstNames: true,
        customInstructions: "",
        updatedBy: null,
        updatedAt: new Date("2026-07-09T00:00:00Z"),
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

function buildApp(prisma: ReturnType<typeof createPrismaMock>, role = "owner") {
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

function lastAgentRequest(): {
  messages: ChatMessage[];
  allowed_tools?: string[];
  // WARP-2631 — the two selection inputs the route derives and ships.
  tool_selection_mode?: "off" | "domains";
  prior_tool_names?: string[];
} {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls.at(-1)![1] as {
    messages: ChatMessage[];
    allowed_tools?: string[];
    tool_selection_mode?: "off" | "domains";
    prior_tool_names?: string[];
  };
}

function systemPromptText(): string {
  const req = lastAgentRequest();
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

async function chat(
  app: express.Express,
  body: Record<string, unknown> = {},
) {
  return request(app)
    .post("/api/llm/chat")
    .send({
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      ...body,
    });
}

beforeEach(() => {
  h.config.OLLAMA_CONTEXT_LENGTH = 16384;
  h.config.TOOL_SELECTION_MODE = "domains";
  persistence.sessionId = null;
  persistence.getConversationToolNames.mockReset();
  persistence.getConversationToolNames.mockResolvedValue([]);
  mockRunAgent.mockReset();
  mockRunAgent.mockResolvedValue({
    message: { role: "assistant", content: "ok" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockListTools.mockReset();
  mockListTools.mockResolvedValue([
    { name: "memory_recall" },
    { name: "memory_extract_fact" },
    { name: "business_profile_get" },
  ]);
});

describe("interview conductor overlay (WARP-1121 §9.3)", () => {
  it("appends the conductor block on the live interview conversation", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(INTERVIEW_CONDUCTOR_BLOCK);
    // WARP-2619 — assert the business block is PRESENT before comparing
    // positions. `indexOf` returns -1 when it is absent and -1 is less than
    // any real index, so the ordering assertion below is satisfied by the
    // block having been dropped entirely — it cannot distinguish "business
    // came first" from "there was no business block". `degradeToFit` drops
    // that block whenever the estimate exceeds the window, so the vacuous
    // case is reachable, not hypothetical: the sibling cases in this file
    // that hit the full tool pool (no interview overlay to pin a write-free
    // list) already log a `business` degradation on this same shipped 16,384
    // window. Interview turns are spared today only because the overlay
    // shrinks the pool first.
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    // Conductor comes AFTER the base prompt (identity/persona/business).
    expect(sys.indexOf(BUSINESS_BLOCK_DELIMITER_OPEN)).toBeLessThan(
      sys.indexOf("--- onboarding interview (conductor) ---"),
    );
  });

  it("does not append the conductor on an ordinary conversation", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, { conversationId: OTHER_ID });
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(
      "--- onboarding interview (conductor) ---",
    );
  });

  it("does not append the conductor once the interview is over", async () => {
    const app = buildApp(
      createPrismaMock({
        profile: makeProfile({ onboardingState: "completed" }),
      }),
    );
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(
      "--- onboarding interview (conductor) ---",
    );
  });

  it("appends the conductor during a re-run", async () => {
    const app = buildApp(
      createPrismaMock({
        profile: makeProfile({ onboardingState: "re_running" }),
      }),
    );
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    expect(systemPromptText()).toContain(INTERVIEW_CONDUCTOR_BLOCK);
  });

  it("strips write tools server-side even for the owner requesting them", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: INTERVIEW_ID,
      allowed_tools: ["memory_recall", "memory_extract_fact"],
    });
    expect(res.status).toBe(200);
    const agentReq = lastAgentRequest();
    expect(agentReq.allowed_tools).toEqual(["memory_recall"]);
  });

  it("resolves the full registry minus write tools when the owner sends no allowed_tools", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    const agentReq = lastAgentRequest();
    // undefined would mean "full registry incl. writes" downstream — the
    // interview must always pin an explicit, write-free list.
    expect(agentReq.allowed_tools).toBeDefined();
    expect(agentReq.allowed_tools).not.toContain("memory_extract_fact");
    expect(agentReq.allowed_tools).toContain("memory_recall");
    expect(agentReq.allowed_tools).toContain("business_profile_get");
  });

  it("keeps write tools for the owner on non-interview conversations", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: OTHER_ID,
      allowed_tools: ["memory_recall", "memory_extract_fact"],
    });
    expect(res.status).toBe(200);
    expect(lastAgentRequest().allowed_tools).toEqual([
      "memory_recall",
      "memory_extract_fact",
    ]);
  });

  it("survives a forced overflow that degrades business + persona away", async () => {
    // Window so small the degradation path drops everything droppable —
    // the conductor must still be there (never dropped on interview turns).
    h.config.OLLAMA_CONTEXT_LENGTH = 1;
    const app = buildApp(createPrismaMock());
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(INTERVIEW_CONDUCTOR_BLOCK);
    expect(sys).not.toContain("SUMMARY_SENTINEL");
  });

  it("fail-opens to a normal chat when the overlay probe throws", async () => {
    // WARP-2652 — deliberate: `profileThrows` makes the SAME read the business
    // composer uses throw, so the business fail-open fires on purpose here.
    composers.expectFailOpen("business");
    const app = buildApp(createPrismaMock({ profileThrows: true }));
    const res = await chat(app, { conversationId: INTERVIEW_ID });
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain(
      "--- onboarding interview (conductor) ---",
    );
  });
});

/**
 * WARP-2631 — tool selection on the request path, on an ORDINARY conversation.
 *
 * Two things this file could not see before, both because
 * `ChatPersistenceService`'s double omitted `getConversationToolNames`
 * (`routes/llm.ts:1320` threw `TypeError`, the fail-open swallowed it, and
 * every turn behaved as a first turn):
 *
 *   1. WARP-1921 cross-turn continuity — the tools an earlier turn called stay
 *      advertised on a later turn that names no matching domain. Unit-covered
 *      in `tool-selection.service.test.ts` and
 *      `chat-persistence.continuity.test.ts`; the JOIN between them — the
 *      route deciding whether to read, for whom, and what to forward — had no
 *      coverage at all.
 *   2. What `TOOL_SELECTION_MODE` actually costs. The interview cases above are
 *      spared because the overlay pins a small write-free pool before the
 *      estimate is taken; an ordinary owner turn is not, and under `off` the
 *      full chat pool no longer fits the shipped 16,384 window (WARP-1893).
 *      `degradeToFit` then drops the business block — WARP-2552's cost, in the
 *      one place this file can observe it without a synthetic window.
 */
/**
 * The id the REQUEST BODY claims, and the id the SERVER resolved — two
 * different values on purpose (#1955, twin of the fixture in
 * `rbac-tool-narrowing.route.test.ts`).
 *
 * One constant playing both parts makes the id half of the
 * `toHaveBeenCalledWith` below undiscriminating: it cannot tell the session
 * `ensureConversation` returned from the caller's claim, so
 * `routes/llm.ts:1320` could read `chatReq.conversationId` and the suite would
 * stay green while the "server-authoritative" comment stopped being true.
 */
const CLAIMED_CONTINUITY_ID = "2a7c9f10-6d4b-4e73-8c15-0b9a3e2d4c61";
const SERVER_CONTINUITY_ID = "c07f4a19-9e52-4d38-b6ac-71d0e58b3f24";

/** Read-only, one per domain, none in `CORE_TOOL_NAMES`: `search_content` is
 *  the floor, `list_cameras` the domain continuity should re-admit,
 *  `list_smart_home_devices` the out-of-domain control. */
const POOL = ["search_content", "list_cameras", "list_smart_home_devices"];

/** The names the loop will advertise from exactly what the route shipped.
 *  Through `effectiveAdvertisedToolNames` — the same function the loop calls,
 *  pinned as agreeing with the route's own estimate by
 *  `tool-selection.parity.test.ts` — rather than a local copy of the rule. */
function advertisedFromAgentRequest(): Set<string> {
  const req = lastAgentRequest();
  return effectiveAdvertisedToolNames({
    mode: req.tool_selection_mode!,
    messages: req.messages as unknown as SelectionMessage[],
    priorToolNames: req.prior_tool_names,
    pool: req.allowed_tools ?? [],
  });
}

describe("tool selection on /api/llm/chat (WARP-1921 continuity, WARP-2552 mode cost)", () => {
  beforeEach(() => {
    persistence.sessionId = SERVER_CONTINUITY_ID;
  });

  it("keeps an earlier turn's out-of-domain tool advertised on a later turn", async () => {
    persistence.getConversationToolNames.mockResolvedValue(["list_cameras"]);
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: CLAIMED_CONTINUITY_ID,
      // The WARP-1921 sentence: a follow-up with no camera word in it. Without
      // continuity the model loses the tool it used one turn ago and the
      // WARP-642 self-heal burns an iteration getting it back.
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    // Server-authoritative and user-scoped, with each half independently
    // falsifiable: the id is the one `ensureConversation` returned rather than
    // `CLAIMED_CONTINUITY_ID` (what the body sent), and the user is
    // `req.user`'s (the body carries none).
    expect(persistence.getConversationToolNames).toHaveBeenCalledWith(
      SERVER_CONTINUITY_ID,
      "stefan",
    );
    expect(persistence.getConversationToolNames).not.toHaveBeenCalledWith(
      CLAIMED_CONTINUITY_ID,
      "stefan",
    );
    expect(lastAgentRequest().prior_tool_names).toEqual(["list_cameras"]);
    const advertised = advertisedFromAgentRequest();
    expect(advertised.has("search_content")).toBe(true);
    // Red when the continuity read at `routes/llm.ts:1320` is removed.
    expect(advertised.has("list_cameras")).toBe(true);
    // Continuity re-admits the prior turn's DOMAIN, not the whole pool.
    expect(advertised.has("list_smart_home_devices")).toBe(false);
  });

  it("advertises the floor only when the conversation has no prior tool calls", async () => {
    persistence.getConversationToolNames.mockResolvedValue([]);
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: CLAIMED_CONTINUITY_ID,
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    expect([...advertisedFromAgentRequest()]).toEqual(["search_content"]);
  });

  it("under `domains`, an ordinary full-pool turn keeps its business block", async () => {
    // Half one of the mode pair. The window is the SHIPPED 16,384, not a
    // synthetic 1 — this is what a box does on a real turn.
    h.config.TOOL_SELECTION_MODE = "domains";
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: CLAIMED_CONTINUITY_ID,
      // No `allowed_tools` and role owner ⇒ the full chat pool.
      messages: [{ role: "user", content: "and how did that go" }],
    });
    expect(res.status).toBe(200);
    expect(lastAgentRequest().allowed_tools).toBeUndefined();
    expect(systemPromptText()).toContain("SUMMARY_SENTINEL");
  });

  it("under `off`, the same turn loses the business block to the tool pool (WARP-2552)", async () => {
    // The other half, and the assertion WARP-2619 reported this file as
    // lacking: a verdict that changes with the mode. Since the pool passed the
    // ceiling in WARP-1893, `off` does not fit the 16,384 window beside the
    // fixed prompt blocks — it leans on `degradeToFit`, which drops business
    // first. That is why `off` is documented as a diagnostic/rollback mode
    // rather than a second supported steady state (`docs/ENVIRONMENT.md:36`),
    // and this is the route-level evidence for the claim.
    h.config.TOOL_SELECTION_MODE = "off";
    const app = buildApp(createPrismaMock());
    const res = await chat(app, {
      conversationId: CLAIMED_CONTINUITY_ID,
      messages: [{ role: "user", content: "and how did that go" }],
    });
    expect(res.status).toBe(200);
    expect(systemPromptText()).not.toContain("SUMMARY_SENTINEL");
    // …and `off` skips the continuity read outright (`routes/llm.ts:1318`).
    expect(persistence.getConversationToolNames).not.toHaveBeenCalled();
    expect(lastAgentRequest().prior_tool_names).toEqual([]);
  });
});

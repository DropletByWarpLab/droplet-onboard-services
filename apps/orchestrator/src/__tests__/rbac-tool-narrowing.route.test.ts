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
 *
 * WARP-2631 — that last sentence is now out of date, deliberately. The final
 * describe block below covers the OTHER narrowing: `TOOL_SELECTION_MODE` and
 * the WARP-1921 cross-turn continuity read the route performs at
 * `routes/llm.ts:1320`. Both were invisible here because the
 * `ChatPersistenceService` double had no `getConversationToolNames` — the call
 * threw `TypeError` synchronously and the deliberate fail-open try/catch
 * swallowed it, so every turn in this file behaved as a first turn. The double
 * now has the method (and a controllable `ensureConversation`, since the route
 * only reads continuity once a conversation row exists), and two cases pull
 * the two levers.
 *
 * WARP-2642, the rename. This file was `tool-domain-narrowing.route.test.ts`,
 * and "tool-domain narrowing" names BOTH mechanisms that run on this turn: the
 * §3 RBAC scope (this file's subject, and its two siblings'
 * `tool-domain-narrowing.{catalog,dispatch}.test.ts`) and WARP-1921's
 * relevance-based advertisement, which also narrows by domain. Both #1955 and
 * #1966 had to spend a paragraph disambiguating it. The siblings keep the old
 * name deliberately — neither touches selection, so neither is ambiguous; this
 * is the only file where the two meet, and so the only one whose name had to
 * say which one it is about.
 *
 * WARP-2642, the fixture. The Prisma double now renders the two prompt blocks
 * it was silently dropping. Same defect
 * class as the WARP-2631 one above, one layer over: `assistantPersona.create`
 * and `businessProfile.create` were bare `vi.fn()`s returning `undefined`, so
 * `getPersona` / `getBusinessProfile` handed `undefined` to the composers,
 * BOTH threw, and the deliberate fail-opens at `routes/llm.ts:1694/1719`
 * swallowed it. 20 stderr lines per run (10 tests × 2 composers) under a green
 * suite. Nobody reads a passing suite's stderr — which is exactly how the
 * missing `getConversationToolNames` hid until WARP-2631.
 *
 * It mattered because every turn here was measured against a system prompt
 * missing two blocks the product always sends, and missing them in the
 * direction that HIDES overflow: a prompt that is smaller than the real one
 * can never reproduce a budget the real one blows. The rows below are the
 * shipped shapes — schema defaults for the persona (what `getPersona`'s
 * create-on-first-read materialises on a real box) and a completed profile for
 * the business block (the state the block exists for). The `renders the two
 * prompt blocks` describe asserts both are present so a fixture regression is
 * red instead of silent, and the `afterEach` guard below makes the fail-open
 * itself audible for every case in this file, present and future.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
// WARP-2631 — the persistence double, now with the two knobs continuity needs.
//
// `sessionId` defaults to `null`, which reproduces the previous
// `ensureConversation: () => null` byte-for-byte: the route's local
// `conversationId` stays null (`routes/llm.ts:1176`) and the continuity branch
// is skipped on its own guard. Every pre-existing case below therefore runs
// exactly as it did. Only the WARP-2631 cases set it.
//
// `getConversationToolNames` is the method that was MISSING. Its absence was
// not inert: `routes/llm.ts:1320` calls it on every non-`off` turn with a
// conversation, and a missing method throws `TypeError` synchronously — caught
// by the fail-open try/catch, so the suite went green while advertising
// `priorToolNames: []` on every turn. A double that omits a method the route
// calls does not test the fail-open; it tests nothing and hides the input.
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
const resolveEffectiveAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

import { createLlmRouter } from "../routes/llm.js";
import type { ChatMessage } from "../types/index.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";
import {
  effectiveAdvertisedToolNames,
  type SelectionMessage,
} from "../services/tool-selection.service.js";
// WARP-2642 — the markers the two composers emit. Both are exported constants
// the composers build their output from (`PERSONA_BLOCK_PREFIX` is the literal
// first line of a persona block; `BUSINESS_BLOCK_DELIMITER_OPEN` is the §15
// data-framing opener), so asserting on them pins the shipped text rather than
// a copy of it.
import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
// WARP-2652 — the two shipped row shapes (schema-default persona, completed
// business profile) and the guard, both promoted out of this file so the other
// fifteen chat-route suites do not carry a copy each. Rationale for each row's
// exact value lives in the helper's header.
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

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
    // WARP-2642 — these three returned `null` from `findUnique` and
    // `undefined` from `create` (or were absent entirely), which is not "no
    // block": `getBusinessProfile` / `getPersona` create-on-first-read and hand
    // whatever `create` returned straight to the composer, so
    // `undefined.summary` / `undefined.preset` threw on every turn and the
    // route's fail-open ate it. WARP-2652 moved the rows into the shared
    // helper; `create` returns the same row as `findUnique` there, so the
    // create-on-first-read path cannot silently reintroduce `undefined`.
    ...promptBlockPrismaDelegates(),
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
    // WARP-2631 — the two selection inputs the route derives and ships.
    tool_selection_mode?: "off" | "domains";
    prior_tool_names?: string[];
    messages?: SelectionMessage[];
  };

/**
 * WARP-2631 — the tool names the agent loop will advertise, given exactly what
 * the route shipped.
 *
 * The route does NOT serialize the tool array; `llm-agent.service.ts` does,
 * from the four inputs asserted above (`tool_selection_mode`,
 * `prior_tool_names`, `messages`, `allowed_tools`). So the honest route-level
 * statement is "given this request, the loop advertises X" — computed through
 * `effectiveAdvertisedToolNames`, which is the SAME function the loop calls and
 * which `tool-selection.parity.test.ts` pins as agreeing with the route's own
 * budget estimate. Re-implementing the rule here instead would assert a copy of
 * it rather than the shipped one.
 */
const advertisedFromAgentRequest = (pool: string[]): Set<string> => {
  const req = agentRequest();
  return effectiveAdvertisedToolNames({
    mode: req.tool_selection_mode!,
    messages: req.messages ?? [],
    priorToolNames: req.prior_tool_names,
    pool: req.allowed_tools ?? pool,
  });
};

/** WARP-2642 — the assembled system prompt the route handed the loop. Mirrors
 *  llm-chat.business-block.test.ts's helper of the same name. */
const systemPromptText = (): string => {
  const req = mockRunAgent.mock.calls.at(-1)![1] as { messages: ChatMessage[] };
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
};

const chat = (app: express.Express, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: "hi" }], ...body });

/**
 * WARP-2642 — the fail-opens around block composition, made audible.
 * WARP-2652 — and now shared: the `afterEach` spy that was written inline here
 * is `guardComposerFailOpen()` in `helpers/prompt-block-fixtures.ts`, used by
 * all sixteen chat-route suites. Its header carries the full rationale (why a
 * spy and not vitest's config-level `onConsoleLog`, and why it is scoped to the
 * two composer signatures rather than "any warn" — the continuity fail-open
 * next door uses `console.error`, which the WARP-2631 rejection case exercises
 * deliberately).
 *
 * This suite has no case that WANTS either composer to throw, so it declares no
 * opt-out and every case is guarded, including ones not yet written.
 */
guardComposerFailOpen();

beforeEach(() => {
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
  mockListTools.mockResolvedValue(REGISTRY);
  resolveEffectiveAccessMock.mockReset();
});

/**
 * WARP-2642 — the fixture-integrity floor.
 *
 * Not a test of the persona or business feature (that is
 * llm-chat.persona-block.test.ts / llm-chat.business-block.test.ts, which own
 * the ordering, role-leak and budget contracts). It is the statement that the
 * turns measured in the rest of THIS file run against the prompt the product
 * assembles, blocks included — the thing that was quietly untrue. One
 * assertion per block, on the marker each composer emits, so a fixture
 * regression names which block went missing.
 */
describe("/api/llm/chat — the route renders the two prompt blocks (fixture floor)", () => {
  it("assembles a system prompt carrying both the persona and the business block", async () => {
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["files"],
      locks: false,
    });
    const res = await chat(buildApp(createPrismaMock("role-1"), "admin"));
    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
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

/**
 * WARP-2631 — the OTHER narrowing on the same turn: relevance-based tool
 * advertisement (§3 of the agent-budgets spec), and specifically its
 * cross-turn input.
 *
 * `getConversationToolNames` had unit coverage
 * (`chat-persistence.continuity.test.ts`) and the selector had unit coverage
 * (`tool-selection.service.test.ts`), but nothing exercised the REQUEST PATH
 * that joins them — the leg where the route decides whether to read continuity
 * at all, whom to read it for, and what to hand the loop. That leg is
 * `routes/llm.ts:1317-1332`, and it is guarded twice: once on the mode, once on
 * `conversationId && userId`.
 *
 * The scenario is the one WARP-1921 was filed for: turn 1 called a camera tool,
 * turn 2 says something with no camera word in it. Without continuity the
 * second turn advertises the floor only, the model cannot see the camera tool
 * it just used, and the WARP-642 self-heal burns an iteration recovering.
 */
const CONVO_ID = "3f5c1c56-3b0a-4d9e-9a1b-5f2c8d7e6a40";

/** Read-only, one per domain, none of them in `CORE_TOOL_NAMES`:
 *  `search_content` is the floor, `list_cameras` is the domain continuity
 *  should re-admit, `list_smart_home_devices` is the out-of-domain control
 *  that must stay out. */
const POOL = ["search_content", "list_cameras", "list_smart_home_devices"];

describe("/api/llm/chat — WARP-1921 cross-turn tool continuity", () => {
  beforeEach(() => {
    persistence.sessionId = CONVO_ID;
    resolveEffectiveAccessMock.mockResolvedValue({
      tier: "admin",
      toolDomains: ["cameras", "smart-home", "files"],
      locks: false,
    });
  });

  it("reads the prior turn's tool names for THIS user and ships them to the loop", async () => {
    persistence.getConversationToolNames.mockResolvedValue(["list_cameras"]);
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      conversationId: CONVO_ID,
      // No camera word anywhere — the only route to the cameras domain on
      // this turn is the prior turn's trace.
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    // Scoped to the authenticated user, not the body's claim: a guessed
    // conversation id from another household member reveals nothing.
    expect(persistence.getConversationToolNames).toHaveBeenCalledWith(
      CONVO_ID,
      "sam",
    );
    expect(agentRequest().prior_tool_names).toEqual(["list_cameras"]);
  });

  it("keeps an out-of-domain tool from an earlier turn in the advertised pool", async () => {
    persistence.getConversationToolNames.mockResolvedValue(["list_cameras"]);
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      conversationId: CONVO_ID,
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    const advertised = advertisedFromAgentRequest(POOL);
    // The floor is unconditional.
    expect(advertised.has("search_content")).toBe(true);
    // Continuity — the whole point. Red when `routes/llm.ts:1320` is removed.
    expect(advertised.has("list_cameras")).toBe(true);
    // …and continuity admits the prior turn's DOMAIN, not the whole pool:
    // smart-home was never touched and stays out.
    expect(advertised.has("list_smart_home_devices")).toBe(false);
  });

  it("advertises the floor only when the conversation has no prior tool calls", async () => {
    // The control for the case above: same turn, same pool, empty trace.
    persistence.getConversationToolNames.mockResolvedValue([]);
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      conversationId: CONVO_ID,
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    expect([...advertisedFromAgentRequest(POOL)]).toEqual(["search_content"]);
  });

  it("skips the continuity read entirely and advertises the whole pool under `off`", async () => {
    // The assertion this file lacked (WARP-2619 reported the gap): a verdict
    // that changes with `TOOL_SELECTION_MODE`. `off` is not a subtle variant —
    // it takes the route's guard at `routes/llm.ts:1318` (no persistence read
    // at all, so no continuity to have) and the selector's short-circuit (the
    // pool ships whole, out-of-domain tools included).
    h.config.TOOL_SELECTION_MODE = "off";
    persistence.getConversationToolNames.mockResolvedValue(["list_cameras"]);
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      conversationId: CONVO_ID,
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    expect(persistence.getConversationToolNames).not.toHaveBeenCalled();
    expect(agentRequest().prior_tool_names).toEqual([]);
    const advertised = advertisedFromAgentRequest(POOL);
    expect(advertised.has("list_smart_home_devices")).toBe(true);
    expect(advertised.size).toBe(POOL.length);
  });

  it("still answers the turn when the persistence layer cannot supply continuity", async () => {
    // The fail-open at `routes/llm.ts:1324` is deliberate and load-bearing:
    // continuity is an optimisation, and a 500 on every chat turn is a
    // spectacular way for one to fail. Now that the double HAS the method,
    // this is a real rejection rather than the accidental `TypeError` that
    // used to make every case in this file take this path.
    persistence.getConversationToolNames.mockRejectedValue(new Error("db down"));
    const res = await chat(buildApp(createPrismaMock("role-1"), "owner"), {
      conversationId: CONVO_ID,
      messages: [{ role: "user", content: "and how did that go" }],
      allowed_tools: POOL,
    });
    expect(res.status).toBe(200);
    expect(agentRequest().prior_tool_names).toEqual([]);
  });
});

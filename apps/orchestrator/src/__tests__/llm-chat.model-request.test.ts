// add-llm-tool:not-a-gate — reads TOOLS only to mock listTools() and to
// compute the expected selection pool; it asserts on chat-request tool
// SELECTION (WARP-2643), not on a site an agent edits when adding a tool.

/**
 * WARP-2643 — the first route-to-model assertion for `/api/llm/chat`.
 *
 * ── the blind spot this closes ─────────────────────────────────────
 *
 * Every other chat route suite mocks `runAgent`. The route does not serialise
 * the tool array — `llm-agent.service.ts` does, from four route-supplied
 * inputs (the RBAC-narrowed pool, `prior_tool_names`, `tool_selection_mode`,
 * `messages`) — so those suites can only assert the INPUTS and derive the
 * advertised set through `effectiveAdvertisedToolNames` (WARP-2631, #1966).
 * `tool-selection.parity.test.ts` asserts the SELECTOR in isolation, and
 * `base-prompt-budget.test.ts` measures a synthetic worst case. Nothing
 * asserted what the model actually receives for a given request: the
 * serialised `tools[]`, its size against the shipped 16,384 window, and
 * whether the fixed system blocks survived `degradeToFit`. That is the gap
 * #1966's "Gaps found" §4 named, and it is where WARP-2552 (`off` no longer
 * fits) and WARP-2547 (15 chars of headroom on the 60,000 tripwire) live.
 *
 * ── how far into production this reaches ───────────────────────────
 *
 * The whole path, from `POST /api/llm/chat` to the object handed to the
 * inference transport. `runAgent` is REAL. `ChatPersistenceService` is real
 * for the continuity read (`getConversationToolNames`) and a double for the
 * write path. `tool-selection.service`, `tool-access.service`,
 * `chat-tool-scope`, the base-prompt composer, `degradeToFit` and the
 * `tools[]` serialisation in `llm-agent.service.ts` all run unmodified. The
 * only fakes are the edges a unit test cannot have: `ai-gateway.client.js`
 * (capturing, so the request never leaves the process), the MCP child
 * (`listTools` fed the REAL `TOOLS` registry, exactly what the stdio server
 * enumerates), and Prisma.
 *
 * So the assertions below are taken on the captured request itself, not
 * derived from route outputs. Where a size is asserted it is measured with
 * `measureToolSpecs` / `toolAdvertisementCeilingTokens` — the shipped
 * functions, so a registry change moves the test and the product together
 * rather than leaving a stale literal behind.
 *
 * ── what is deliberately NOT here ──────────────────────────────────
 *
 * No product code changed. The static chat pool and every tool description
 * are untouched (WARP-2547 owns the 15 chars of headroom), and
 * `base-prompt-budget.test.ts` is unmodified. The single product edit in this
 * PR is exporting `CONTINUITY_TRACE_ROW_LIMIT`, which was the literal `50`
 * inside `chat-persistence.service.ts` — the boundary block below imports it
 * rather than restating it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// The mode is an INPUT to this file's subject, not background: it decides
// whether the loop narrows the pool at all. Pinned to what boxes ship
// (`apps/orchestrator/src/config.ts`), typed as the union so the `off`
// measurement below can assign the rollback value.
const h = vi.hoisted(() => ({
  config: {
    AUTH_ENABLED: false,
    // The SHIPPED window (docker-compose.yml). Every size assertion below is
    // against this number; a synthetic window would measure nothing real.
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "domains" as "off" | "domains",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
    vision: { maxImages: 0, model: "" },
    AGENT_BLANK_TURN_DEBUG: false,
  },
}));
vi.mock("../config.js", () => ({ config: h.config }));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(),
  // `getConversationToolNames` — which runs for real here — filters with
  // Prisma's canonical "JSON column is not SQL NULL" sentinel.
  Prisma: {
    PrismaClientKnownRequestError: class extends Error {},
    DbNull: Symbol.for("test.Prisma.DbNull"),
  },
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
vi.mock("../services/query-enhancement.service.js", () => ({
  createEnhancementDeps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../services/file-citation.service.js", () => ({
  createFileCitationService: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
}));

/**
 * The MCP child. Fed the REAL registry — `mcpClient.listTools()` enumerates
 * `@droplet/tools-core` on a box, so anything smaller would measure a fixture
 * rather than the shipped advertisement. The loop applies the WARP-1424 chat
 * scope to it itself; that filtering is part of what this file asserts.
 */
const mockListTools = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));

/**
 * THE CAPTURE POINT. `deps.aiGateway.chat` in `routes/llm.ts:1250` closes over
 * this module, and `llm-agent.service.ts:1620` calls it with the fully
 * assembled request — `{ model, messages, tools, tool_choice, … }`. That
 * object IS what the model receives; the real client only JSON-stringifies it
 * onto a fetch. Capturing here is therefore the last point that is still the
 * production request rather than a reconstruction of one.
 */
const modelRequests: CapturedModelRequest[] = [];
interface CapturedModelRequest {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: {
    type: "function";
    function: { name: string; description: string; parameters: unknown };
  }[];
  tool_choice?: "auto" | "none";
}
vi.mock("../services/ai-gateway.client.js", () => ({
  chat: vi.fn(async (req: CapturedModelRequest) => {
    modelRequests.push(req);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
      }),
    };
  }),
  chatStream: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  getModelCapabilities: vi.fn().mockResolvedValue(undefined),
  getModelProvider: vi.fn().mockResolvedValue(null),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(true),
  isTimeoutError: () => false,
}));

/**
 * The persistence double, extending #1966's: the WRITE path is inert (no DB),
 * but `getConversationToolNames` delegates to the REAL
 * `ChatPersistenceService` method against the Prisma double below. That is
 * deliberate — a `vi.fn()` returning a canned array would let the boundary
 * block assert its own seed instead of the shipped `take:`, which is the one
 * thing a window test must not do.
 */
const persistence = vi.hoisted(() => ({ sessionId: null as string | null }));
vi.mock("../services/chat-persistence.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/chat-persistence.service.js")
  >("../services/chat-persistence.service.js");
  return {
    ...actual,
    ChatPersistenceService: vi
      .fn()
      .mockImplementation((prisma: ConstructorParameters<
        typeof actual.ChatPersistenceService
      >[0]) => {
        const real = new actual.ChatPersistenceService(prisma);
        return {
          ensureConversation: vi.fn(async () =>
            persistence.sessionId ? { id: persistence.sessionId } : null,
          ),
          createTurnRows: vi.fn().mockResolvedValue(null),
          finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
          updateAssistantStreaming: vi.fn().mockResolvedValue(undefined),
          listConversationsForUser: vi.fn().mockResolvedValue([]),
          getConversationForUser: vi.fn().mockResolvedValue(null),
          deleteConversationForUser: vi.fn().mockResolvedValue(false),
          getConversationToolNames: (id: string, userId: string) =>
            real.getConversationToolNames(id, userId),
        };
      }),
  };
});

import { createLlmRouter } from "../routes/llm.js";
import { TOOLS } from "@droplet/tools-core";
import {
  measureToolSpecs,
  toolAdvertisementCeilingTokens,
  type AdvertisedToolSpec,
} from "../services/tool-budget.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";
import { CONTINUITY_TRACE_ROW_LIMIT } from "../services/chat-persistence.service.js";
import { CORE_TOOL_NAMES } from "../services/tool-selection.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "../services/chat-tool-scope.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";

const SESSION_ID = "3f4d1c22-5b0a-4a7e-9f1e-2c8d6b5a4e30";
const OWNER = { id: "owner-uuid", username: "stefan", role: "owner" };

/** One persisted assistant row, as `getConversationToolNames` selects it. */
interface TraceRow {
  createdAt: Date;
  toolCalls: { id: string; name: string; args: unknown }[] | null;
}

function traceRow(name: string, minutesAgo: number): TraceRow {
  return {
    createdAt: new Date(Date.UTC(2026, 8, 2, 12, 0, 0) - minutesAgo * 60_000),
    toolCalls: [{ id: `c${minutesAgo}`, name, args: {} }],
  };
}

/**
 * Prisma double. `chatMessage.findMany` honours `orderBy.createdAt` and
 * `take` because those two are exactly what the continuity WINDOW is —
 * ignoring them would make the boundary block below unfalsifiable.
 */
function createPrismaMock(trace: TraceRow[] = []) {
  return {
    // WARP-2652's shared three delegates rather than a local copy. #1955 —
    // this was the ONE chat-route suite the sweep missed, and it still carried
    // the exact shape WARP-2642/2652 removed from the other sixteen:
    // `businessProfile.create` and `assistantPersona.create` as bare
    // `vi.fn()`s returning `undefined`. Inert only because `findUnique`
    // happened to return a row — both services are create-on-first-read and
    // hand whatever `create` resolved to straight to the composer, so a
    // `findUnique` that ever returns `null` gives both composers `undefined`,
    // both throw into the route's fail-open, and this file's four cases go
    // green against a prompt missing two blocks. On a suite whose whole
    // subject is what the model RECEIVES, and whose size assertions are taken
    // against the shipped 16,384 window, that is the worst possible direction
    // to be wrong in: a prompt smaller than the real one cannot reproduce a
    // budget the real one blows.
    ...promptBlockPrismaDelegates(),
    memoryFact: { findMany: vi.fn(async () => []) },
    brainMemoryItem: { findMany: vi.fn(async () => []) },
    fileContentChunk: { findMany: vi.fn(async () => []) },
    contextPin: { findMany: vi.fn(async () => []) },
    chatSession: { findFirst: vi.fn(async () => null) },
    chatMessage: {
      findMany: vi.fn(async (args: { orderBy?: { createdAt?: "asc" | "desc" }; take?: number }) => {
        const rows = [...trace]
          .filter((r) => r.toolCalls !== null)
          .sort((a, b) =>
            args.orderBy?.createdAt === "desc"
              ? b.createdAt.getTime() - a.createdAt.getTime()
              : a.createdAt.getTime() - b.createdAt.getTime(),
          );
        return (args.take === undefined ? rows : rows.slice(0, args.take)).map(
          (r) => ({ toolCalls: r.toolCalls }),
        );
      }),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof OWNER }).user = OWNER;
    next();
  });
  app.use("/api", createLlmRouter(prisma as never));
  return app;
}

async function chat(app: express.Express, userMessage: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/llm/chat")
    .send({ model: "m1", messages: [{ role: "user", content: userMessage }], ...body });
}

/** The request the model received. Not derived — captured. */
function capturedRequest(): CapturedModelRequest {
  expect(modelRequests).not.toHaveLength(0);
  return modelRequests.at(-1)!;
}

function advertisedNames(): string[] {
  return (capturedRequest().tools ?? []).map((t) => t.function.name);
}

function systemPrompt(): string {
  const sys = capturedRequest().messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

/**
 * WARP-2652's stderr guard, which this file was outside of (#1955). No case
 * here wants either composer to throw, so no opt-out is declared and every
 * case is guarded — including ones not yet written. Without it the fixture
 * above can regress back to two silently absent blocks and this suite stays
 * green while measuring a prompt no box ever sends.
 */
guardComposerFailOpen();

beforeEach(() => {
  h.config.OLLAMA_CONTEXT_LENGTH = 16384;
  h.config.TOOL_SELECTION_MODE = "domains";
  persistence.sessionId = SESSION_ID;
  modelRequests.length = 0;
  mockListTools.mockReset();
  mockListTools.mockResolvedValue(
    Array.from(TOOLS.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  );
});

describe("POST /api/llm/chat — the request the model actually receives (WARP-2643)", () => {
  it("(a) first turn under `domains`: advertises core + the matched domain, fits the shipped window, and keeps both degradable blocks", async () => {
    const app = buildApp(createPrismaMock());
    const res = await chat(app, "turn off the kitchen lights");
    expect(res.status).toBe(200);

    const req = capturedRequest();
    const names = advertisedNames();

    // The floor: CORE_TOOL_NAMES is unioned in unconditionally.
    for (const core of CORE_TOOL_NAMES) expect(names).toContain(core);
    // The matched domain (smart-home), minus the chat-scope exclusions the
    // loop applies to the pool before selection ever sees it.
    expect(names).toContain("control_device");
    expect(names).toContain("list_smart_home_devices");
    // Unmatched domains are absent. THIS is the assertion the mode gate owns:
    // remove the `tool_selection_mode === "domains"` branch in
    // llm-agent.service.ts and the whole chat pool ships, reddening these.
    expect(names).not.toContain("list_cameras");
    expect(names).not.toContain("list_network_devices");
    expect(names).not.toContain("email_search");

    // Every advertised name came from the pool; selection only ever subsets.
    const pool = new Set(
      Array.from(TOOLS.values())
        .map((t) => t.name)
        .filter((n) => !EXCLUDED_FROM_CHAT_TOOLS.has(n)),
    );
    for (const n of names) expect(pool.has(n)).toBe(true);
    // A count, so a selection change that silently widens the turn is visible
    // as a number rather than only as a missing negative assertion.
    expect(names).toHaveLength(new Set(names).size);
    expect(names.length).toBeGreaterThan(CORE_TOOL_NAMES.size);
    expect(names.length).toBeLessThan(pool.size);

    // SIZE, measured with the shipped measurer rather than a literal.
    const size = measureToolSpecs(req.tools as AdvertisedToolSpec[]);
    expect(size.count).toBe(names.length);
    expect(size.chars).toBeLessThan(h.config.OLLAMA_CONTEXT_LENGTH);
    expect(size.tokens).toBeLessThanOrEqual(
      toolAdvertisementCeilingTokens({
        contextWindow: h.config.OLLAMA_CONTEXT_LENGTH,
      }),
    );

    // …and the blocks `degradeToFit` drops first. Asserting their PRESENCE is
    // the point: a turn that fits keeps them, and WARP-2552's whole cost is
    // that under `off` this same turn does not. Without these two lines the
    // size assertions above would pass just as happily on a prompt that had
    // already been degraded to make room.
    const sys = systemPrompt();
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
  });

  it("(b) second turn: a prior turn's out-of-domain tool is in the serialised array, and its domain with it", async () => {
    // Turn 1 called a CAMERAS tool. Turn 2's sentence names no domain at all —
    // the WARP-1921 sentence. Without the route's continuity read the model
    // gets core-only and burns a WARP-642 self-heal iteration.
    const app = buildApp(createPrismaMock([traceRow("list_cameras", 5)]));
    const res = await chat(app, "and how did that go", { conversationId: SESSION_ID });
    expect(res.status).toBe(200);

    const names = advertisedNames();
    expect(names).toContain("list_cameras");
    // The DOMAIN comes back, not just the one tool — which is why a camera
    // follow-up can also list clips.
    expect(names).toContain("list_camera_events");
    // Control: continuity re-admits one domain, never the pool. If this goes
    // green alongside the two above, the turn stopped narrowing and the
    // assertions above are passing for the wrong reason.
    expect(names).not.toContain("control_device");
    expect(names).not.toContain("email_search");

    // Still a real, budgeted advertisement.
    const size = measureToolSpecs(capturedRequest().tools as AdvertisedToolSpec[]);
    expect(size.chars).toBeLessThan(h.config.OLLAMA_CONTEXT_LENGTH);
    expect(size.tokens).toBeLessThanOrEqual(
      toolAdvertisementCeilingTokens({
        contextWindow: h.config.OLLAMA_CONTEXT_LENGTH,
      }),
    );
  });

  it("(c) `off` ships the whole chat pool — the measurement behind WARP-2552", async () => {
    // Not a duplicate of #1966's degradation case (that reads the system
    // prompt): this measures the WIRE ARRAY the rollback mode puts on it, the
    // number the ENVIRONMENT.md row is asserting about. Recorded rather than
    // bounded — raising a ceiling is WARP-2547's decision, not this file's.
    h.config.TOOL_SELECTION_MODE = "off";
    const app = buildApp(createPrismaMock());
    const res = await chat(app, "turn off the kitchen lights");
    expect(res.status).toBe(200);

    const names = advertisedNames();
    const pool = Array.from(TOOLS.values()).filter(
      (t) => !EXCLUDED_FROM_CHAT_TOOLS.has(t.name),
    );
    expect(names).toHaveLength(pool.length);
    expect(names).toContain("list_cameras"); // unmatched domain, shipped anyway

    // It does NOT fit: that is the documented cost of the rollback lever, and
    // the reason `off` is a diagnostic rather than a second steady state.
    const size = measureToolSpecs(capturedRequest().tools as AdvertisedToolSpec[]);
    expect(size.tokens).toBeGreaterThan(
      toolAdvertisementCeilingTokens({
        contextWindow: h.config.OLLAMA_CONTEXT_LENGTH,
      }),
    );
  });
});

describe("the 50-row continuity window, at its boundary (WARP-2643)", () => {
  /**
   * `getConversationToolNames` reads the `CONTINUITY_TRACE_ROW_LIMIT` most
   * recent assistant rows. That is a SILENT cutoff: past it, a tool used
   * earlier in the thread is indistinguishable from one never used, and the
   * turn self-heals for an iteration with nothing saying why. #1966 named this
   * as gap 1; these two cases are its edge.
   *
   * The seed is `LIMIT` filler rows carrying `search_content`, plus one
   * cameras row placed either just inside or just outside the window. The
   * limit is IMPORTED — a literal `50` here would keep passing if the
   * product's `take` changed, which is the only failure mode a boundary test
   * exists to prevent.
   *
   * #1955 — the filler is NOT domain-free, and the first cut of this comment
   * claimed it was ("a CORE tool, which adds no domain, so it cannot mask the
   * subject"). Core-ness and domain membership are independent:
   * `search_content` is in the `files` domain (`tools-core/src/catalog.ts`
   * `TOOL_DOMAINS.files`) AND in `CORE_TOOL_NAMES`, and
   * `selectAdvertisedTools` adds a domain for EVERY name in
   * `conversationToolNames` regardless of core-ness
   * (`tool-selection.service.ts` — the `for (const name of
   * opts.conversationToolNames)` loop runs before the core check). So the
   * filler admits the whole files domain in both cases below.
   *
   * That does not weaken the boundary — files and cameras are disjoint, so
   * the filler cannot mask `list_cameras` either way — and the OUTSIDE case
   * now DEPENDS on it: an admitted NON-core files tool is the only positive
   * evidence available that the continuity read ran at all.
   */
  function seedWithCameraRowAt(position: number): TraceRow[] {
    // `position` counts back from the newest row (0 = newest). The filler
    // occupies every other slot up to LIMIT + 1 rows total.
    const rows: TraceRow[] = [];
    for (let i = 0; i <= CONTINUITY_TRACE_ROW_LIMIT; i++) {
      rows.push(traceRow(i === position ? "list_cameras" : "search_content", i));
    }
    return rows;
  }

  it(`advertises a tool from the last row INSIDE the window (position ${CONTINUITY_TRACE_ROW_LIMIT - 1})`, async () => {
    const trace = seedWithCameraRowAt(CONTINUITY_TRACE_ROW_LIMIT - 1);
    expect(trace).toHaveLength(CONTINUITY_TRACE_ROW_LIMIT + 1);
    const app = buildApp(createPrismaMock(trace));
    const res = await chat(app, "and how did that go", { conversationId: SESSION_ID });
    expect(res.status).toBe(200);
    expect(advertisedNames()).toContain("list_cameras");
  });

  it(`does NOT advertise a tool from the first row OUTSIDE the window (position ${CONTINUITY_TRACE_ROW_LIMIT})`, async () => {
    const trace = seedWithCameraRowAt(CONTINUITY_TRACE_ROW_LIMIT);
    expect(trace).toHaveLength(CONTINUITY_TRACE_ROW_LIMIT + 1);
    const app = buildApp(createPrismaMock(trace));
    const res = await chat(app, "and how did that go", { conversationId: SESSION_ID });
    expect(res.status).toBe(200);
    const names = advertisedNames();
    expect(names).not.toContain("list_cameras");
    // The filler rows ARE inside the window, so this is a WINDOW boundary and
    // not simply a continuity read that failed — and that distinction needs a
    // name only the read can put on the wire. `search_files` is it: files
    // domain, NOT in `CORE_TOOL_NAMES`, so it is advertised only because the
    // filler rows' `search_content` admitted its domain.
    //
    // #1955 — this line asserted `search_content` itself, which is core and
    // therefore advertised unconditionally. Had the continuity read broken
    // outright (throw → fail-open → `priorToolNames: []`) that assertion
    // passed, `not.toContain("list_cameras")` passed with it, and this whole
    // OUTSIDE case went green for the wrong reason, resting entirely on its
    // INSIDE sibling.
    expect(names).toContain("search_files");
    expect(CORE_TOOL_NAMES.has("search_files")).toBe(false);
    // …and the excluded row's domain is absent WHOLE, not just the one tool.
    expect(names).not.toContain("list_camera_events");
  });
});

/**
 * WARP-1983 — the stored-content egress gate on POST /api/llm/chat.
 *
 * THE CONTRACT: a turn that leaves the LAN carries none of the customer's
 * stored material — no Drive tools advertised, no document text inlined, no
 * attached image bytes. A turn that stays on the box is untouched.
 *
 * This is a DIFFERENT gate from WARP-1530's per-person cloud check
 * (`llm-chat.cloud-access.test.ts`). That one decides whether the person may
 * run off-box at all and 451s when they may not. This one assumes that said
 * yes and constrains what the permitted turn carries. The cases below that
 * matter most are exactly the ones where the two gates DISAGREE — the
 * `service` principal and the anonymous session, which WARP-1530 waves
 * through before it ever resolves a provider.
 *
 * Every assertion here is paired: the cloud case proves the tool/content is
 * GONE, and a local case proves it is PRESENT. A suite that only asserted
 * absence would still pass if the chat route stopped advertising file tools
 * altogether, which would be a regression wearing this gate's clothes.
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
const mockRecordActivity = vi.fn();
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => mockRecordActivity(...a),
}));

// WARP-2746 — the brain block, stubbed to a known string. Its own consent and
// scope gates are pinned by its own suite; what THIS file owns is whether the
// route lets the block reach a cloud provider, which needs it non-empty.
const BRAIN_TEXT = "Brain: Acme Dental is behind on three insurer claims.";
vi.mock("../services/brain/brain-block.service.js", () => ({
  buildBrainBlock: vi.fn(async () => BRAIN_TEXT),
  BRAIN_BLOCK_CHAR_BUDGET: 2000,
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nc-token"),
}));

// The live registry as this box would advertise it: a couple of Drive tools,
// a brain tool, and two that have nothing to do with stored content. The
// non-file pair is what proves the gate SUBTRACTS rather than just emptying
// the list — a gate that returned [] would pass every absence assertion.
const LIVE_TOOLS = [
  { name: "read_file" },
  { name: "search_content" },
  { name: "list_files" },
  { name: "memory_recall" },
  // WARP-2990 — the business profile / CRM / brain-findings door.
  { name: "business_profile_get" },
  { name: "business_find" },
  // WARP-2979 — Security: presence and location data (ADR-059 DS-007).
  { name: "security_list_incidents" },
  { name: "security_zone_status" },
  { name: "get_network_status" },
  { name: "list_smart_home_devices" },
];
const mockListTools = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: (...a: unknown[]) => mockListTools(...a),
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

const mockGetModelProvider = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  // WARP-2851 — ollama publishes no window; `null` keeps these suites on
  // the local default, i.e. byte-for-byte the window they budgeted against
  // before per-model resolution existed.
  getModelContextWindow: vi.fn().mockResolvedValue(null),
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: true }),
  getModelProvider: (...a: unknown[]) => mockGetModelProvider(...a),
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

// Vision routing. `buildImageBlocks` is the path that would put raw image
// bytes in front of a cloud model, so "was it asked for anything at all?" is
// the assertion that matters, not just what it returned.
const mockBuildImageBlocks = vi.fn();
vi.mock("../services/vision-attachments.service.js", () => ({
  buildImageBlocks: (...a: unknown[]) => mockBuildImageBlocks(...a),
  attachImageBlocksToLastUserMessage: vi.fn(),
  decideVisionRoute: () => ({ mode: "image", model: "vision-local" }),
}));

const mockResolveEffectiveAccess = vi.fn();
vi.mock("../services/effective-access.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/effective-access.service.js")>();
  return {
    ...actual,
    resolveEffectiveAccess: (...a: unknown[]) => mockResolveEffectiveAccess(...a),
  };
});

import { createLlmRouter } from "../routes/llm.js";
import {
  OFF_LAN_WITHHELD_DOMAINS,
  OFF_LAN_WITHHELD_NOTICE,
  OFF_LAN_WITHHELD_PROMPT_BLOCKS,
  OFF_LAN_WITHHELD_TOOLS,
  withholdPromptBlocksForOffLan,
  withholdStoredContentTools,
} from "../services/stored-content-egress.service.js";

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — see the helper's header. This file asserts on the WHOLE
// outbound message array, so two blocks that never composed were two blocks
// whose egress was never checked either.
guardComposerFailOpen();

const USER_ID = "person-uuid";
const OWNER_ID = "owner-uuid";

/** WARP-2746 — a stored memory fact, a pinned path, and the business block's
 *  own text: each must reach a local model and never a cloud one. */
const MEMORY_FACT_TEXT = "Front desk alarm code is 4417";
const PINNED_PATH = "/Patients/J Smith/perio-2026-03.pdf";
const BUSINESS_TEXT = "A fixture business.";

/** The document body that must never appear in a cloud request. */
const PHI_TEXT = "Patient J. Smith — perio charting 2026-03-11";

function createPrismaMock() {
  return {
    // WARP-2652 — persona + business + workspace, absent here until now.
    ...promptBlockPrismaDelegates(),
    // WARP-2746 — NON-EMPTY on purpose. This stub was `[]`, which is why the
    // memory block reached cloud turns unnoticed: nothing to leak, nothing to
    // catch. Same for the pin below.
    memoryFact: {
      findMany: vi.fn(async () => [{ category: "ops", fact: MEMORY_FACT_TEXT }]),
    },
    brainMemoryItem: {
      findMany: vi.fn(async () => [
        {
          id: "item-1",
          filename: "smith-perio-chart.pdf",
          mimeType: "application/pdf",
          status: "ready",
        },
      ]),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    fileContentChunk: {
      findMany: vi.fn(async () => [{ text: PHI_TEXT }]),
    },
    contextPin: {
      findMany: vi.fn(async () => [{ id: "pin-1", kind: "file", ref: PINNED_PATH }]),
    },
    chatSession: { findFirst: vi.fn(async () => null) },
  };
}

function buildApp(user: { id?: string; username?: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use("/api", createLlmRouter(createPrismaMock() as never));
  return app;
}

function accessWith(cloud: boolean) {
  return { tier: "family", cloud, connectors: {}, features: [], toolDomains: [] };
}

/**
 * The agent-loop options. `runAgent(deps, opts)` takes TWO arguments — the
 * options are the SECOND. Reading `calls[0][0]` yields the deps bag, whose
 * `messages`/`allowed_tools` are both undefined, so every assertion below
 * would vacuously "pass" against an empty array. Centralised here so that
 * mistake can only be made once.
 */
function runOpts(): { allowed_tools?: string[]; messages?: unknown } {
  expect(mockRunAgent).toHaveBeenCalled();
  return mockRunAgent.mock.calls[0][1] as {
    allowed_tools?: string[];
    messages?: unknown;
  };
}

/** The `allowed_tools` the route handed the agent loop. */
function allowedToolsFromRun(): string[] {
  const opts = runOpts();
  // `undefined` means "the full live registry" — the privileged sentinel.
  // Materialise it the way the route would so assertions read uniformly.
  return opts.allowed_tools ?? LIVE_TOOLS.map((t) => t.name);
}

/** Every scrap of text the turn would have sent to the provider. */
function outboundText(): string {
  const messages = runOpts().messages;
  // A turn that somehow sent nothing must not read as "the PHI was absent".
  expect(messages).toBeDefined();
  return JSON.stringify(messages);
}

beforeEach(() => {
  mockRecordActivity.mockReset().mockResolvedValue(null);
  mockRunAgent.mockReset().mockResolvedValue({
    message: { role: "assistant", content: "hi" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockResolveEffectiveAccess.mockReset().mockResolvedValue(accessWith(true));
  mockGetModelProvider.mockReset().mockResolvedValue("local");
  mockListTools.mockReset().mockResolvedValue(LIVE_TOOLS);
  mockBuildImageBlocks
    .mockReset()
    .mockResolvedValue({ blocks: [{ type: "image" }], usedItemIds: ["item-1"] });
});

describe("the withheld set is DERIVED from the tool catalog", () => {
  // If this drifts, the gate silently narrows. The catalog's own
  // completeness test guarantees a new file tool gets a domain; this
  // guarantees the domain is what this gate reads.
  it("covers the Drive and brain surfaces without naming them literally", () => {
    for (const name of [
      "read_file",
      "search_content",
      "search_files",
      "list_files",
      "list_recent_files",
      "summarize_file",
      "memory_recall",
    ]) {
      expect(OFF_LAN_WITHHELD_TOOLS.has(name)).toBe(true);
    }
  });

  it("WARP-2979: withholds every Security tool, and the notice says Security stays on the Droplet", () => {
    expect(OFF_LAN_WITHHELD_DOMAINS.has("security")).toBe(true);
    // WARP-2980 — the fifth, security_explain_pattern, is withheld by its domain like the four.
    for (const name of ["security_list_incidents", "security_get_incident", "security_search_events", "security_zone_status", "security_explain_pattern"]) {
      expect(OFF_LAN_WITHHELD_TOOLS.has(name), name).toBe(true);
    }
    expect(withholdStoredContentTools(["security_search_events", "get_network_status"])).toEqual(["get_network_status"]);
    expect(OFF_LAN_WITHHELD_NOTICE).toMatch(/Security tools are offered/);
    expect(OFF_LAN_WITHHELD_NOTICE).toMatch(/Security events/);
  });

  it("leaves unrelated domains alone — it subtracts, it does not empty", () => {
    expect(OFF_LAN_WITHHELD_TOOLS.has("get_network_status")).toBe(false);
    expect(OFF_LAN_WITHHELD_TOOLS.has("list_smart_home_devices")).toBe(false);
    expect(withholdStoredContentTools(["read_file", "get_network_status"])).toEqual([
      "get_network_status",
    ]);
  });
});

describe("POST /api/llm/chat — a cloud turn carries no stored content", () => {
  // WARP-2652 — the fixture floor for every outbound-text assertion below.
  it("assembles a base prompt carrying both the persona and the business block", async () => {
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({ model: "llama3:8b", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    const sent = outboundText();
    expect(sent).toContain(PERSONA_BLOCK_PREFIX);
    expect(sent).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });

  it("withholds the Drive and brain tools from a cloud turn", async () => {
    // Owner, so this pairs like-for-like with the local test below: same
    // principal, same registry, only the provider differs. An unprivileged
    // role resolves its allowed-tools through the live access-scope resolver,
    // which this harness does not reproduce and which returns an EMPTY list —
    // every "not.toContain" would then pass vacuously while proving nothing.
    // The paired `toContain` below is what catches that.
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "anthropic",
        messages: [{ role: "user", content: "what's in my files?" }],
      });

    expect(res.status).toBe(200);
    const allowed = allowedToolsFromRun();
    expect(allowed).not.toContain("read_file");
    expect(allowed).not.toContain("search_content");
    expect(allowed).not.toContain("list_files");
    expect(allowed).not.toContain("memory_recall");
    expect(allowed).not.toContain("business_profile_get");
    expect(allowed).not.toContain("business_find");
    // WARP-2979 — Security never goes to a cloud model.
    expect(allowed).not.toContain("security_list_incidents");
    expect(allowed).not.toContain("security_zone_status");
    // The other half of the contract: it subtracted, it didn't nuke.
    expect(allowed).toContain("get_network_status");
  });

  it("keeps the SAME tools on a local turn — the box's own model is unrestricted", async () => {
    // Owner, so the comparison is like-for-like with the cloud owner case
    // below: same principal, same registry, only the provider differs.
    mockGetModelProvider.mockResolvedValue("local");
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "local",
        messages: [{ role: "user", content: "what's in my files?" }],
      });

    expect(res.status).toBe(200);
    const allowed = allowedToolsFromRun();
    expect(allowed).toContain("read_file");
    expect(allowed).toContain("search_content");
    expect(allowed).toContain("memory_recall");
    expect(allowed).toContain("business_profile_get");
    expect(allowed).toContain("business_find");
    expect(allowed).toContain("security_list_incidents");
    expect(allowed).toContain("security_zone_status");
  });

  it("withholds them from the OWNER too — the role most likely to be on a cloud model", async () => {
    // An owner's allowed-tools resolves to `undefined` (the full registry).
    // If the gate forgot to materialise that sentinel it would be a no-op
    // here and nowhere else, which is the worst possible place to miss.
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "anthropic",
        messages: [{ role: "user", content: "summarise the charts" }],
      });

    expect(res.status).toBe(200);
    const arg = runOpts();
    // Materialised, not left as the privileged sentinel.
    expect(arg.allowed_tools).toBeDefined();
    expect(arg.allowed_tools).not.toContain("read_file");
    expect(arg.allowed_tools).not.toContain("memory_recall");
    expect(arg.allowed_tools).toContain("get_network_status");
  });

  it("withholds them from a SERVICE principal, which the per-person cloud gate waves through", async () => {
    // WARP-1530 returns ALLOWED for `service` BEFORE resolving a provider, so
    // this turn's protection comes from this gate alone. The voice loop on a
    // cloud model is the exact shape with no human in the loop to notice.
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ username: "voice", role: "service" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "read me the chart" }],
      });

    expect(res.status).toBe(200);
    const allowed = allowedToolsFromRun();
    expect(allowed).not.toContain("read_file");
    expect(allowed).not.toContain("search_content");
  });

  it("is not fooled by a request that mislabels a cloud model as local", async () => {
    // The catalog is authoritative over the caller's `provider` string —
    // same reasoning as cloudProviderFor. A crafted label must not buy
    // the Drive back.
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "ollama",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(allowedToolsFromRun()).not.toContain("read_file");
  });
});

describe("POST /api/llm/chat — attachments on a cloud turn", () => {
  it("inlines no document text and requests no image bytes", async () => {
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "anthropic",
        messages: [{ role: "user", content: "what does this say?" }],
        attachments: [{ itemId: "item-1" }],
      });

    expect(res.status).toBe(200);
    const sent = outboundText();
    // The document body never left the box…
    expect(sent).not.toContain(PHI_TEXT);
    // …nor did the filename, which is PHI in its own right.
    expect(sent).not.toContain("smith-perio-chart.pdf");
    // …and the vision path was never even asked to render the image.
    const askedFor = mockBuildImageBlocks.mock.calls[0]?.[2] ?? [];
    expect(askedFor).toEqual([]);
    // The user can see they attached something, so the model is told why it
    // cannot read it rather than silently ignoring them.
    expect(sent).toMatch(/withheld|stayed on the Droplet/i);
  });

  it("inlines that same document on a local turn", async () => {
    // No image claimed by the vision route, so the OCR-text path is the one
    // under test. (When vision DOES claim an item the route deliberately
    // stops inlining its text — correct behaviour, but it would mask the
    // assertion this case exists to make.)
    mockBuildImageBlocks.mockResolvedValue({ blocks: [], usedItemIds: [] });
    mockGetModelProvider.mockResolvedValue("local");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "local",
        messages: [{ role: "user", content: "what does this say?" }],
        attachments: [{ itemId: "item-1" }],
      });

    expect(res.status).toBe(200);
    const sent = outboundText();
    expect(sent).toContain(PHI_TEXT);
    // The vision path WAS offered the attachment on a local turn — the
    // mirror of the cloud case above, where it is offered nothing at all.
    expect(mockBuildImageBlocks.mock.calls[0]?.[2]).toEqual(["item-1"]);
  });
});

describe("POST /api/llm/chat — the model is told why", () => {
  it("names the boundary in the system prompt on a cloud turn, and not on a local one", async () => {
    mockGetModelProvider.mockResolvedValue("anthropic");
    const cloudApp = buildApp({ id: USER_ID, username: "reception", role: "family" });
    await request(cloudApp)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "anthropic",
        messages: [{ role: "user", content: "hello" }],
      });
    expect(outboundText()).toMatch(/privacy boundary/i);

    mockRunAgent.mockClear();
    mockGetModelProvider.mockResolvedValue("local");
    const localApp = buildApp({ id: USER_ID, username: "reception", role: "family" });
    await request(localApp)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "local",
        messages: [{ role: "user", content: "hello" }],
      });
    expect(outboundText()).not.toMatch(/privacy boundary/i);
  });
});

describe("POST /api/llm/chat — stored content in the PROMPT (WARP-2746)", () => {
  const send = (app: express.Express, cloud: boolean) =>
    request(app)
      .post("/api/llm/chat")
      .send(
        cloud
          ? {
              model: "claude-opus-4-20250514",
              provider: "anthropic",
              messages: [{ role: "user", content: "what do you know about us?" }],
            }
          : {
              model: "llama3:8b",
              provider: "local",
              messages: [{ role: "user", content: "what do you know about us?" }],
            },
      );

  /** The `refs` of the turn's signed `chat` activity row. */
  function auditRefs(): Record<string, unknown> {
    const call = mockRecordActivity.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "chat",
    );
    expect(call).toBeDefined();
    return (call![0] as { refs: Record<string, unknown> }).refs;
  }

  it("a LOCAL turn carries memory, business, brain and pins — the fixture floor", async () => {
    mockGetModelProvider.mockResolvedValue("local");
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await send(app, false)).status).toBe(200);
    const sent = outboundText();
    expect(sent).toContain(MEMORY_FACT_TEXT);
    expect(sent).toContain(BUSINESS_TEXT);
    expect(sent).toContain(BRAIN_TEXT);
    expect(sent).toContain(PINNED_PATH);
    expect(auditRefs().offLanWithheld).toBeUndefined();
  });

  it("a CLOUD turn carries none of them, and the audit row names what was withheld", async () => {
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await send(app, true)).status).toBe(200);
    const sent = outboundText();
    expect(sent).not.toContain(MEMORY_FACT_TEXT);
    expect(sent).not.toContain(BUSINESS_TEXT);
    expect(sent).not.toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    expect(sent).not.toContain(BRAIN_TEXT);
    expect(sent).not.toContain(PINNED_PATH);
    // Persona is tone, not stored content — it stays. Proves the gate
    // subtracted rather than dropping the whole system prompt.
    expect(sent).toContain(PERSONA_BLOCK_PREFIX);
    // …and the model is told stored content was left out, not just tools.
    expect(sent).toMatch(/business profile/i);

    const refs = auditRefs();
    expect(refs.offLanProvider).toBe("anthropic");
    expect([...(refs.offLanWithheld as string[])].sort()).toEqual(
      ["brain", "business", "context_pins", "memory"],
    );
  });
});

describe("withholdPromptBlocksForOffLan — the one definition", () => {
  it("follows the memory TOOL domain, so the two axes cannot disagree", () => {
    expect(OFF_LAN_WITHHELD_DOMAINS.has("memory")).toBe(true);
    expect(OFF_LAN_WITHHELD_PROMPT_BLOCKS.has("memory")).toBe(true);
    expect(OFF_LAN_WITHHELD_PROMPT_BLOCKS.has("brain")).toBe(true);
    // WARP-2990 — and the profile block follows the business tool domain.
    expect(OFF_LAN_WITHHELD_DOMAINS.has("business")).toBe(true);
    expect(OFF_LAN_WITHHELD_PROMPT_BLOCKS.has("business")).toBe(true);
  });

  it("is a no-op on a local turn and records only non-empty blocks off-LAN", () => {
    const blocks = { memory: "m", business: "", brain: "b" };
    expect(withholdPromptBlocksForOffLan(blocks, false)).toEqual({ blocks, withheld: [] });
    expect(withholdPromptBlocksForOffLan(blocks, true)).toEqual({
      blocks: { memory: "", business: "", brain: "" },
      withheld: ["memory", "brain"],
    });
  });
});

/**
 * WARP-2991 — replaying a conversation's earlier answers to a cloud model.
 *
 * Asserted on what `runAgent` is handed (the outbound payload), for each
 * consent state. Harness shared in shape with llm-chat.stored-content-egress.
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

let sessionRow: {
  cloudHistoryConsent: "not_asked" | "granted" | "declined";
  cloudHistoryConsentAt: Date | null;
} | null = null;
let messageRows: Array<{
  role: string;
  provider: string | null;
  createdAt: Date;
  toolCalls: unknown;
}> = [];

function createPrismaMock() {
  return {
    chatMessage: { findMany: vi.fn(async () => messageRows) },
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
    chatSession: {
      findFirst: vi.fn(async () => sessionRow),
      updateMany: vi.fn(async () => ({ count: sessionRow ? 1 : 0 })),
    },
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
  sessionRow = null;
  messageRows = [];
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


const CONV_ID = "3f0c2a4e-1b7d-4c1e-9a55-2d7e8b6f0c11";
const EARLIER_LOCAL_ANSWER = "Your alarm code is 4417 (from memory).";
const T0 = new Date("2026-09-20T10:00:00Z");
const T1 = new Date("2026-09-21T10:00:00Z");
const T2 = new Date("2026-09-22T10:00:00Z");

/** A thread: an on-box answer earlier, a new question now. */
function sendCloudTurn(app: express.Express) {
  return request(app)
    .post("/api/llm/chat")
    .send({
      model: "claude-opus-4-20250514",
      provider: "anthropic",
      conversationId: CONV_ID,
      messages: [
        { role: "user", content: "what is the alarm code?" },
        { role: "assistant", content: EARLIER_LOCAL_ANSWER },
        { role: "user", content: "and who else knows it?" },
      ],
    });
}

function onBoxAnswerAt(at: Date, provider: string | null = "local") {
  return { role: "assistant", provider, createdAt: at, toolCalls: [{ name: "memory_recall" }] };
}

/** The non-system messages the provider receives. */
function sentConversation(): Array<{ role: string; content: unknown }> {
  const messages = runOpts().messages as Array<{ role: string; content: unknown }>;
  return messages.filter((m) => m.role !== "system");
}

function historyAuditRefs(): Record<string, unknown> {
  const call = mockRecordActivity.mock.calls.find(
    (c) => (c[0] as { kind?: string }).kind === "chat",
  );
  expect(call).toBeDefined();
  return (call![0] as { refs: Record<string, unknown> }).refs;
}

describe("POST /api/llm/chat — history replay on a cloud turn (WARP-2991)", () => {
  beforeEach(() => mockGetModelProvider.mockResolvedValue("anthropic"));

  it("GRANTED after the last on-box answer: the full history goes", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T1 };
    messageRows = [onBoxAnswerAt(T0)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    const sent = sentConversation();
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sent)).toContain(EARLIER_LOCAL_ANSWER);
    expect(historyAuditRefs().historyReplay).toBe("full");
  });

  it("DECLINED: only the user's own messages go, and the model is told", async () => {
    sessionRow = { cloudHistoryConsent: "declined", cloudHistoryConsentAt: T1 };
    messageRows = [onBoxAnswerAt(T0)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    const sent = sentConversation();
    expect(sent.map((m) => m.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
    expect(JSON.stringify(runOpts().messages)).toMatch(/were not sent to you/);
    const refs = historyAuditRefs();
    expect(refs.historyReplay).toBe("user_only");
    expect(refs.historyWithheldMessages).toBe(1);
  });

  it("NO CONSENT RECORDED behaves exactly like decline", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    messageRows = [onBoxAnswerAt(T0)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(sentConversation().map((m) => m.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
  });

  // WARP-2979 (ADR-059 P4 §6.13, D27) — Security never leaves the box, not even with consent.
  it("GRANTED, but an on-box answer used a Security tool: only the user's own messages go", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T1 };
    messageRows = [{ role: "assistant", provider: "local", createdAt: T0, toolCalls: [{ name: "security_list_incidents" }] }];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(sentConversation().map((m) => m.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
    expect(historyAuditRefs().historyReplay).toBe("user_only");
  });

  it("GRANTED, and the Security answer is the OLDEST of several covered ones: still only the user's messages", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T2 };
    messageRows = [
      { role: "assistant", provider: null, createdAt: T0, toolCalls: [{ name: "security_search_events" }] },
      onBoxAnswerAt(T1),
    ];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(sentConversation().map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("a consent does not cover an on-box answer produced AFTER it", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T1 };
    messageRows = [onBoxAnswerAt(T0), onBoxAnswerAt(T2)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
  });

  it("an answer with NO recorded provider counts as on-box (fail closed)", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    messageRows = [onBoxAnswerAt(T0, null)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
  });

  it("a conversation that only ever ran on cloud models replays in full, unasked", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    messageRows = [onBoxAnswerAt(T0, "anthropic")];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    expect((await sendCloudTurn(app)).status).toBe(200);
    expect(JSON.stringify(runOpts().messages)).toContain(EARLIER_LOCAL_ANSWER);
  });

  it("a turn with NO persisted conversation (ephemeral / API) cannot record consent, so it declines", async () => {
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });
    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-opus-4-20250514",
        provider: "anthropic",
        ephemeral: true,
        messages: [
          { role: "user", content: "what is the alarm code?" },
          { role: "assistant", content: EARLIER_LOCAL_ANSWER },
          { role: "user", content: "and who else knows it?" },
        ],
      });
    expect(res.status).toBe(200);
    expect(JSON.stringify(runOpts().messages)).not.toContain(EARLIER_LOCAL_ANSWER);
  });

  it("a LOCAL turn is untouched whatever the consent says", async () => {
    mockGetModelProvider.mockResolvedValue("local");
    sessionRow = { cloudHistoryConsent: "declined", cloudHistoryConsentAt: T1 };
    messageRows = [onBoxAnswerAt(T0)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "local",
        conversationId: CONV_ID,
        messages: [
          { role: "user", content: "what is the alarm code?" },
          { role: "assistant", content: EARLIER_LOCAL_ANSWER },
          { role: "user", content: "and who else knows it?" },
        ],
      });
    expect(res.status).toBe(200);
    expect(JSON.stringify(runOpts().messages)).toContain(EARLIER_LOCAL_ANSWER);
    expect(historyAuditRefs().historyReplay).toBeUndefined();
  });
});

describe("/api/llm/conversations/:id/cloud-history (WARP-2991)", () => {
  it("GET names the uncovered on-box answers and what they drew on", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    messageRows = [
      { role: "user", provider: null, createdAt: T0, toolCalls: null },
      onBoxAnswerAt(T0),
      { role: "assistant", provider: "local", createdAt: T0, toolCalls: [{ name: "read_file" }] },
    ];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app).get(`/api/llm/conversations/${CONV_ID}/cloud-history`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      consent: "not_asked",
      uncoveredOnBoxAnswers: 2,
      unaskedOnBoxAnswers: 2,
      userMessages: 1,
      drewOn: ["documents", "memory"],
    });
  });

  it("WARP-2979: GET says Security answers are never sent — even when the consent covers them", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T1 };
    messageRows = [
      { role: "user", provider: null, createdAt: T0, toolCalls: null },
      { role: "assistant", provider: "local", createdAt: T0, toolCalls: [{ name: "security_zone_status" }] },
    ];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app).get(`/api/llm/conversations/${CONV_ID}/cloud-history`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ consent: "granted", uncoveredOnBoxAnswers: 0, neverSent: ["Security"], drewOn: [] });
  });

  it("WARP-2979: GET's neverSent is empty when no answer used Security", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    messageRows = [onBoxAnswerAt(T0)];
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app).get(`/api/llm/conversations/${CONV_ID}/cloud-history`);
    expect(res.body.neverSent).toEqual([]);
  });

  it("GET 404s a conversation that is not the caller's", async () => {
    sessionRow = null;
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });
    expect((await request(app).get("/api/llm/conversations/x/cloud-history")).status).toBe(404);
  });

  it("PUT records the decision and writes a signed activity row", async () => {
    sessionRow = { cloudHistoryConsent: "not_asked", cloudHistoryConsentAt: null };
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .put(`/api/llm/conversations/${CONV_ID}/cloud-history`)
      .send({ decision: "declined" });
    expect(res.status).toBe(200);
    expect(historyAuditRefs()).toMatchObject({
      conversationId: CONV_ID,
      cloudHistoryConsent: "declined",
    });
  });

  it("PUT rejects anything but granted/declined — not_asked cannot be written back", async () => {
    sessionRow = { cloudHistoryConsent: "granted", cloudHistoryConsentAt: T1 };
    const app = buildApp({ id: OWNER_ID, username: "stefan", role: "owner" });
    const res = await request(app)
      .put(`/api/llm/conversations/${CONV_ID}/cloud-history`)
      .send({ decision: "not_asked" });
    expect(res.status).toBe(400);
  });
});

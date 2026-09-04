/**
 * WARP-1530 (RBAC v2 T6) — per-person cloud gating on POST /api/llm/chat.
 *
 * ADR-032 §3 axis (d) "Cloud": the ORCHESTRATOR consults the resolver's
 * `cloud` before selecting a cloud provider for a person's request.
 * ai-gateway's workspace-level 451 (`off_lan_gating.py`) is deliberately
 * NOT touched — it has no user identity and stays the independent
 * fail-closed backstop. Two layers, both closed.
 *
 * What this file pins:
 *   1. denied by role  → the turn NEVER reaches a cloud provider (runAgent
 *      is never invoked) and the refusal is HONEST — a 451 that names the
 *      channel, not a silent downgrade to the local model;
 *   2. allowed by role → the cloud turn runs exactly as before;
 *   3. local turns are untouched — the resolver is never even consulted
 *      (no per-turn DB read on the hot path every box actually uses);
 *   4. a resolver failure fails CLOSED (503, the email.ts gate-unavailable
 *      posture) — a broken gate never silently opens cloud egress;
 *   5. `service` principals (voice) keep their dedicated path — §3 says
 *      they never resolve through layer 2.
 *
 * The AND-gate itself (workspace escape ∧ role flag) is T3's composition;
 * `cloud-access.service.test.ts` pins that this route consumes the AND-gated
 * field rather than re-deriving either limb.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    vision: { model: "", maxImages: 3 },
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

const mockGetModelProvider = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  getModelCapabilities: vi.fn().mockResolvedValue({ vision: false }),
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

// /llm/complete's single-turn worker. Stubbed so "did the request reach a
// provider?" is a spy assertion rather than a network call.
const mockCompleteOnce = vi.fn();
vi.mock("../services/llm-complete.service.js", () => ({
  completeOnce: (...a: unknown[]) => mockCompleteOnce(...a),
}));

// The T3 resolver is the ONE source of the `cloud` verdict. Only the bound
// fetch wrapper is stubbed; the pure composition stays real for the
// cloud-access service test.
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

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  guardComposerFailOpen,
  promptBlockPrismaDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — see the helper's header: without these three delegates both
// block composers threw on every turn and the route's fail-open swallowed it.
guardComposerFailOpen();

const USER_ID = "person-uuid";

function createPrismaMock() {
  return {
    // WARP-2652 — persona + business + workspace, absent here until now.
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

/** A resolver result with only the fields this route reads. */
function accessWith(cloud: boolean) {
  return { tier: "family", cloud, connectors: {}, features: [], toolDomains: [] };
}

beforeEach(() => {
  mockRunAgent.mockReset().mockResolvedValue({
    message: { role: "assistant", content: "hi" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
  mockCompleteOnce.mockReset().mockResolvedValue({ content: "ok", model: "gpt-4o" });
  mockResolveEffectiveAccess.mockReset();
  mockGetModelProvider.mockReset().mockResolvedValue("openai");
});


/** WARP-2652 — the assembled base prompt the route handed the agent loop. */
function systemPromptText(): string {
  expect(mockRunAgent).toHaveBeenCalled();
  const req = mockRunAgent.mock.calls.at(-1)![1] as {
    messages: { role: string; content: unknown }[];
  };
  const sys = req.messages[0]!;
  expect(sys.role).toBe("system");
  return typeof sys.content === "string" ? sys.content : "";
}

// WARP-2652 — the fixture floor. Not a test of the persona or business
// feature (llm-chat.persona-block.test.ts / llm-chat.business-block.test.ts
// own those); it is the statement that the turns measured in the rest of this
// file run against the prompt the product assembles, blocks included.
describe("POST /api/llm/chat — the prompt blocks this suite assumes (fixture floor)", () => {
  it("assembles a base prompt carrying both the persona and the business block", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(true));
    // Owner, not the `family` reception principal the gate cases use: the
    // business block is role-filtered (§15 audience ladder) and only the
    // owner/admin view carries the structured fields as well as the summary.
    const app = buildApp({ id: USER_ID, username: "stefan", role: "owner" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "local",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    const sys = systemPromptText();
    expect(sys).toContain(PERSONA_BLOCK_PREFIX);
    expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
  });
});

describe("POST /api/llm/chat — per-person cloud gate (WARP-1530)", () => {
  it("refuses a cloud turn for a person whose role denies cloud models, and never reaches a provider", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(false));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o",
        provider: "openai",
        messages: [{ role: "user", content: "hello" }],
      });

    // Honest sovereignty refusal — the same 451 shape the repo already uses
    // for off-LAN blocks (routes/email.ts, ai-gateway off_lan_gating).
    expect(res.status).toBe(451);
    expect(res.body.error).toBe("off_lan_blocked");
    expect(res.body.channel).toBe("cloud_model_escape");
    expect(res.body.provider).toBe("openai");
    // Per-person, so the operator knows this is NOT the workspace toggle.
    expect(res.body.scope).toBe("per_person");
    expect(String(res.body.message)).toMatch(/cloud/i);

    // The load-bearing half: no provider was ever selected. No silent
    // downgrade to the local model either — the turn simply did not run.
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(mockResolveEffectiveAccess).toHaveBeenCalledWith(USER_ID);
  });

  it("refuses when the caller sends a cloud model with NO forwarded provider (catalog is authoritative)", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(false));
    mockGetModelProvider.mockResolvedValue("anthropic");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(451);
    expect(res.body.provider).toBe("anthropic");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("refuses when the forwarded provider claims local but the catalog says cloud", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(false));
    mockGetModelProvider.mockResolvedValue("openai");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o",
        provider: "ollama", // a lying client
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(451);
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("runs the cloud turn when the person's resolved access allows cloud", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(true));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o",
        provider: "openai",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalled();
  });

  it("never consults the resolver for a local turn (no new per-turn DB read)", async () => {
    mockGetModelProvider.mockResolvedValue("ollama");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "llama3:8b",
        provider: "ollama",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(mockRunAgent).toHaveBeenCalled();
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("fails CLOSED with a 503 when the resolver is unavailable — never opens cloud egress", async () => {
    mockResolveEffectiveAccess.mockRejectedValue(new Error("db down"));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o",
        provider: "openai",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("access_gate_unavailable");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("leaves the voice service principal on its dedicated path (never resolves layer 2)", async () => {
    mockGetModelProvider.mockResolvedValue("openai");
    const app = buildApp({ id: "_service:voice", username: "voice", role: "service" });

    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "gpt-4o",
        provider: "openai",
        messages: [{ role: "user", content: "hello" }],
      });

    expect(res.status).toBe(200);
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });
});

// ── the OTHER route that takes a caller-chosen model ────────────────
//
// Gating only /llm/chat would have left /llm/complete as a one-line bypass:
// `model` is caller-supplied there too, the guard admits every human tier
// down to guest, and `.strict()` means there is no `provider` field to
// forward — so the model NAME is the only signal, which is exactly the path
// the PROVIDER_PREFIXES mirror covers. These pin the gate on that route
// specifically; the existing llm-complete.test.ts cannot, because its auth
// stub injects `{username, role}` with no `id` and the gate correctly
// returns before any lookup for an id-less session.
describe("POST /api/llm/complete — the same per-person cloud gate (WARP-1530)", () => {
  it("refuses a cloud model for a denied person and never calls the completion worker", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(false));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "gpt-4o" });

    expect(res.status).toBe(451);
    expect(res.body.error).toBe("off_lan_blocked");
    expect(res.body.scope).toBe("per_person");
    expect(res.body.provider).toBe("openai");
    expect(mockCompleteOnce).not.toHaveBeenCalled();
  });

  it("refuses an UNCATALOGUED cloud model too — model name is the only signal here", async () => {
    // `.strict()` rejects a `provider` field, and the catalogue knows nothing
    // about gpt-5; without the prefix mirror this request would sail through.
    mockGetModelProvider.mockResolvedValue(undefined);
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(false));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "gpt-5" });

    expect(res.status).toBe(451);
    expect(res.body.provider).toBe("openai");
    expect(mockCompleteOnce).not.toHaveBeenCalled();
  });

  it("completes normally when the person's resolved access allows cloud", async () => {
    mockResolveEffectiveAccess.mockResolvedValue(accessWith(true));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "gpt-4o" });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("ok");
    expect(mockCompleteOnce).toHaveBeenCalled();
  });

  it("leaves a local-model completion untouched — the resolver is never consulted", async () => {
    mockGetModelProvider.mockResolvedValue("ollama");
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "llama3:8b" });

    expect(res.status).toBe(200);
    expect(mockCompleteOnce).toHaveBeenCalled();
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("exempts the mcp-server service principal — the route's registered consumer", async () => {
    // translate_text / summarize_file ride this route as `_service:mcp`; §3
    // keeps service principals out of layer 2, and they pay nothing for it.
    const app = buildApp({ id: "_service:mcp", username: "mcp", role: "service" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "gpt-4o" });

    expect(res.status).toBe(200);
    expect(mockCompleteOnce).toHaveBeenCalled();
    expect(mockResolveEffectiveAccess).not.toHaveBeenCalled();
  });

  it("fails CLOSED with a 503 when the resolver is unavailable", async () => {
    mockResolveEffectiveAccess.mockRejectedValue(new Error("db down"));
    const app = buildApp({ id: USER_ID, username: "reception", role: "family" });

    const res = await request(app)
      .post("/api/llm/complete")
      .send({ text: "translate this", model: "gpt-4o" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("access_gate_unavailable");
    expect(mockCompleteOnce).not.toHaveBeenCalled();
  });
});

/**
 * WARP-171 canary: if a future PR removes "service" from
 * requireRole(...) on /api/llm/chat in routes/llm.ts:243, voice-io
 * breaks silently. This test fails first.
 *
 * Why this exists separately from `rbac.test.ts`:
 *
 *   `rbac.test.ts` builds a synthetic Express app (`buildAppWithRealAuth`)
 *   that re-declares the matrix locally — `requireRole("owner", "admin",
 *   "family", "guest", "service")` lives on a hand-rolled router INSIDE the
 *   test file. The production route in `apps/orchestrator/src/routes/llm.ts`
 *   is never imported by that test. So removing `"service"` from the real
 *   `requireRole(...)` call would NOT fail any rbac.test.ts assertion — the
 *   matrix-table claim that the canary protects /api/llm/chat was unenforced.
 *
 *   This file imports the real `createLlmRouter` factory and mounts it with
 *   the real `authMiddleware`. The matrix and the production code are now
 *   bound together: removing "service" from the production call drops the
 *   request at the guard with 403, this test fails, and the regression is
 *   loud at PR time instead of silent at runtime when voice-io next tries
 *   to POST /api/llm/chat.
 *
 * Bonus assertion: a static read of `routes/llm.ts` confirms the literal
 * `"service"` appears in a `requireRole(...)` argument list near the
 * `/llm/chat` route declaration. Belt-and-braces against a future refactor
 * that, say, moves the route to a different file — the dynamic test fails
 * first, but the static one localises the regression to llm.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { readFileSync } from "node:fs";

// ── Config mock — hoisted above ALL route imports. The real
// authMiddleware reads config.AUTH_ENABLED, config.SERVICE_TOKEN_VOICE,
// config.NEXTCLOUD_URL, config.JWT_SECRET; setting them here unlocks the
// service-principal Bearer match without spinning up a Nextcloud OCS stub
// or a JWT signer. SERVICE_TOKEN_VOICE MUST be non-empty — `matchServiceToken`
// in `auth.ts:264` short-circuits on falsy token defs.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// MCP singleton stub — `narrowAllowedToolsForRole` calls `mcpClient.listTools()`
// for non-privileged roles (and `service` is non-privileged per llm.ts:146-148).
// An empty list is fine — the guard runs BEFORE this code path; we only need
// the factory's transitive imports to load without throwing.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));

// ai-gateway is only touched by /llm/models; the chat path goes through
// `runAgent` from llm-agent.service. Either way, the canary never reaches
// the actual upstream — Zod rejects the empty body at the top of the
// handler with a 400, which is the success signal (guard let us through).
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    assistantMessage: { role: "assistant", content: "" },
    trace: [],
    iterations: 0,
    stop_reason: "end_turn",
  }),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1", created: true }),
    createTurnRows: vi.fn().mockResolvedValue({
      conversationId: "conv-1",
      userMessageId: "user-1",
      assistantMessageId: "asst-1",
      created: true,
    }),
    finalizeAssistantMessage: vi.fn().mockResolvedValue(undefined),
    renameConversationForUser: vi.fn(),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
  })),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

// ── Real imports under test. authMiddleware MUST be real (no stub); the
// whole point of this canary is to exercise the production auth chain.
import { authMiddleware } from "../middleware/auth.js";
import { createLlmRouter } from "../routes/llm.js";
import { packagePath } from "./helpers/test-paths.js";

const SERVICE_TOKEN_VOICE = "test-voice-token-32chars-padding-xyz";

/**
 * `apps/orchestrator/src/routes/llm.ts`, anchored to this test file rather
 * than the runner's cwd (WARP-2654). `__dirname` under the hood, not
 * `import.meta.url`, which tsc rejects under CommonJS (this app's target).
 */
const LLM_ROUTE_PATH = packagePath("src", "routes", "llm.ts");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-171 canary — POST /api/llm/chat accepts service principal (voice-io)", () => {
  function buildApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    // PrismaClient stub — createLlmRouter passes it to ChatPersistenceService
    // (mocked above) and never calls into it for /llm/chat path coverage that
    // matters for this canary. Cast through unknown because we don't need a
    // real client; the mock above intercepts the constructor.
    const prismaStub = {} as unknown as import("@prisma/client").PrismaClient;
    app.use("/api", createLlmRouter(prismaStub));
    return app;
  }

  it("POST /api/llm/chat with SERVICE_TOKEN_VOICE Bearer is NOT 403 (guard lets service through)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/llm/chat")
      .set("Authorization", `Bearer ${SERVICE_TOKEN_VOICE}`)
      .send({}); // empty body → Zod 400 from the handler. 400 proves the guard let us through.

    // The critical assertion: we did NOT 403. Anything else (200/400/4xx/5xx)
    // means the request reached the handler, which means requireRole(...) on
    // /api/llm/chat in routes/llm.ts accepts "service".
    expect(res.status).not.toBe(403);
    // Sanity: empty body should fail Zod parse → 400 from the handler at
    // llm.ts:249. If this drifts to a 200/500 it's not a guard regression but
    // worth a heads-up.
    expect(res.status).toBe(400);
  });

  it("static check — routes/llm.ts contains a requireRole(...) call with literal \"service\" near /llm/chat", () => {
    // Belt-and-braces: parse the production route file and confirm "service"
    // is in the requireRole(...) call argument list for the /llm/chat route.
    // Catches a refactor that moves the route to a different file with a
    // weaker guard, or removes "service" from the args while leaving the
    // dynamic test passing for unrelated reasons.
    //
    // Path resolution mirrors `role-enum.schema.test.ts`: walk from cwd
    // because vitest can be invoked from the orchestrator workspace OR from
    // repo root (`npm run test:orchestrator`). We deliberately don't use
    // import.meta.url — the orchestrator compiles to CommonJS, which tsc
    // forbids that property in.
    const llmRoutePath = LLM_ROUTE_PATH;
    const src = readFileSync(llmRoutePath, "utf8");

    // Find the requireRole(...) call attached to "/llm/chat". The route
    // declaration spans a few lines:
    //   router.post(
    //     "/llm/chat",
    //     requireRole("owner", "admin", "family", "guest", "service"),
    //     ...
    // The regex below is intentionally permissive on whitespace and the
    // surrounding role list so a reorder ("service" first vs last) still
    // matches — what we're guarding is the LITERAL presence of "service"
    // in the requireRole call attached to /llm/chat.
    const re = /"\/llm\/chat"[\s\S]{0,200}requireRole\(([^)]*)\)/;
    const match = src.match(re);
    expect(match, "could not find requireRole(...) for /llm/chat in routes/llm.ts").not.toBeNull();
    const argList = match![1];
    expect(argList).toMatch(/"service"/);
  });
});

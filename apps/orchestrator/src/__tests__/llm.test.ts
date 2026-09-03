import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";

import { PERSONA_BLOCK_PREFIX } from "../services/persona.service.js";
import { BUSINESS_BLOCK_DELIMITER_OPEN } from "../services/business-profile.service.js";
import {
  guardComposerFailOpen,
  withPromptBlockDelegates,
} from "./helpers/prompt-block-fixtures.js";

// WARP-2652 — `new PrismaClient()` here resolves to the shared in-memory
// double from src/__tests__/setup.ts, which has no `assistantPersona`,
// `businessProfile` or `workspace` model. Both block composers therefore threw
// on every turn and the route's fail-open swallowed it. See the helper header.
guardComposerFailOpen();

// Stub auth middleware — pulls a role from `x-test-role` so tests can
// exercise both authenticated and unauthenticated paths. Matches the
// pattern in `llm-chat.integration.test.ts` and `llm-tools-route.test.ts`.
// WARP-171: also stub `requireRole` as a no-op so route files that now
// import it (auth, devices, files, …) load cleanly. RBAC coverage for
// these guards lives in `rbac.test.ts` which uses the real middleware.
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: { username: string; role: string } }).user = {
        username: "test",
        role,
      };
    }
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  // BUG-11 follow-up: app.ts now installs requirePasswordChangeGate on
  // every request; stub it as a pass-through like requireRole.
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  // WARP-485: app.ts calls setAuthPrisma() at boot to wire the OCS
  // fallback to Prisma. This mock stubs out auth entirely, so the
  // singleton init is a no-op — but the export must exist or app
  // construction throws "No setAuthPrisma export on the mock".
  setAuthPrisma: () => {},
}));

// Stub ChatPersistenceService so tests can spy on individual methods
// without a live Postgres connection. The factory captures the instance
// so each test can re-configure per-method behaviour via the exported
// mock functions below.
const mockRenameConversationForUser = vi.fn();
const mockCreateTurnRows = vi.fn().mockResolvedValue({
  conversationId: "conv-1",
  userMessageId: "user-1",
  assistantMessageId: "asst-1",
  created: true,
});
const mockFinalizeAssistantMessage = vi.fn().mockResolvedValue(undefined);
const mockListConversationsForUser = vi.fn().mockResolvedValue([]);
const mockGetConversationForUser = vi.fn().mockResolvedValue(null);
const mockDeleteConversationForUser = vi.fn().mockResolvedValue(false);
const mockSetConversationPinned = vi.fn().mockResolvedValue(false);

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    renameConversationForUser: mockRenameConversationForUser,
    createTurnRows: mockCreateTurnRows,
    finalizeAssistantMessage: mockFinalizeAssistantMessage,
    listConversationsForUser: mockListConversationsForUser,
    getConversationForUser: mockGetConversationForUser,
    deleteConversationForUser: mockDeleteConversationForUser,
    setConversationPinned: mockSetConversationPinned,
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1", created: true }),
  })),
}));

// Mock the ai-gateway client with controllable implementations
const mockListModels = vi.fn().mockResolvedValue({
  models: [
    { id: "llama3:8b", provider: "ollama", name: "llama3:8b", context_window: null },
    { id: "gpt-4o", provider: "openai", name: "GPT-4o", context_window: 128000 },
  ],
});
const mockChat = vi.fn();
const mockSaveKey = vi.fn().mockResolvedValue(undefined);
const mockListKeys = vi.fn().mockResolvedValue(["anthropic"]);
const mockDeleteKey = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: (...args: any[]) => mockListModels(...args),
  chat: (...args: any[]) => mockChat(...args),
  saveKey: (...args: any[]) => mockSaveKey(...args),
  listKeys: (...args: any[]) => mockListKeys(...args),
  deleteKey: (...args: any[]) => mockDeleteKey(...args),
}));

// WARP-1511 — stub only the DB read (`readActiveChatModel`) so
// GET /api/llm/models' `defaultModel` resolution is testable without a live
// Postgres connection. `resolveActiveChatModel` / `localModelIdentifiers`
// stay real so the actual fallback logic under test runs for real.
const { readActiveChatModelMock } = vi.hoisted(() => ({
  readActiveChatModelMock: vi.fn(),
}));
vi.mock("../services/active-model.service.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/active-model.service.js")>();
  return {
    ...actual,
    readActiveChatModel: (...args: any[]) => readActiveChatModelMock(...args),
  };
});

// Mock the cache so the model-list cache path is deterministic instead of
// silently depending on REDIS_URL being unset. Keep every other cache export
// (cacheDel, cacheSetNx, getRedis, withSwrCache, …) real — `createApp` mounts
// the whole route tree and many of those importers run during construction /
// per-request, so a bare {cacheGet, cacheSet} factory would hand them
// `undefined`. Only cacheGet/cacheSet are overridden, as controllable spies, so
// the no-cache-on-degrade invariant can be asserted.
vi.mock("../services/cache.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/cache.service.js")
  >("../services/cache.service.js");
  return {
    ...actual,
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn().mockResolvedValue(undefined),
  };
});

// Stub the MCP singleton so /api/llm/chat can drive the (now in-process)
// agent loop without spawning the mcp-server child. Since WARP-101 the
// orchestrator owns the loop and reads tools from this client.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

const mockCacheGet = vi.mocked(cacheGet);
const mockCacheSet = vi.mocked(cacheSet);

describe("LLM routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    // WARP-2652 — the three delegates the prompt-block composers need,
    // layered on for THIS suite only.
    app = createApp(withPromptBlockDelegates(prisma));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockListModels.mockResolvedValue({
      models: [
        { id: "llama3:8b", provider: "ollama", name: "llama3:8b", context_window: null },
      ],
    });
    // Default to a cache miss so /api/llm/models exercises the gateway path.
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    // WARP-1511 — default to "unset", matching the WORKSPACE_SETTING_DEFAULTS
    // seed row (`ai.model.chat` = ""). Individual tests override.
    readActiveChatModelMock.mockResolvedValue(null);
  });

  describe("GET /api/llm/models", () => {
    it("returns model list", async () => {
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.models).toBeDefined();
      expect(Array.isArray(res.body.models)).toBe(true);
    });

    it("calls ai-gateway listModels", async () => {
      await request(app).get("/api/llm/models");
      // listModels may or may not be called depending on cache, but endpoint should not error
      expect(mockListModels).toBeDefined();
    });

    it("degrades to an empty list (not 500) when ai-gateway is unreachable", async () => {
      // Setup wizard / dashboard SWR must not get a 500 when the gateway is
      // down or disabled (dev: AI_GATEWAY_URL=ai-gateway-disabled → ENOTFOUND).
      // WARP-1284: the fallback now carries `degraded: true` so the wizard
      // can distinguish "gateway unreachable" from "no model pulled yet".
      mockListModels.mockRejectedValueOnce(
        new Error("fetch failed: getaddrinfo ENOTFOUND ai-gateway-disabled")
      );
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [], degraded: true, defaultModel: null });
    });

    it("degrades on a timeout (AbortSignal.timeout fired)", async () => {
      mockListModels.mockRejectedValueOnce(
        new Error("AI Gateway timeout after 10000ms during listModels")
      );
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [], degraded: true, defaultModel: null });
    });

    it("does NOT cache the empty fallback (list self-heals next request)", async () => {
      mockListModels.mockRejectedValueOnce(
        new Error("fetch failed: getaddrinfo ENOTFOUND ai-gateway-disabled")
      );
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ models: [], degraded: true, defaultModel: null });
      // The degraded path must not poison the cache — otherwise the empty list
      // would be served for the full TTL even after the gateway recovers.
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it("flags degraded (and skips the cache) when the gateway reports its ollama provider failed", async () => {
      // WARP-1284 case 2: gateway reachable but its Ollama provider raised
      // during listing — router.py used to swallow this into a bare empty
      // list, indistinguishable from a genuine first-boot model pull.
      mockListModels.mockResolvedValueOnce({
        models: [],
        degraded_providers: ["ollama"],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      expect(res.body.models).toEqual([]);
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it("forwards surviving models alongside the degraded flag (ollama down, cloud up)", async () => {
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "gpt-4o", provider: "openai", name: "GPT-4o", context_window: 128000 },
        ],
        degraded_providers: ["ollama"],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      expect(res.body.models).toHaveLength(1);
      expect(res.body.models[0].id).toBe("gpt-4o");
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it("does not flag degraded for a cloud-only provider failure (response still cached)", async () => {
      // Only the LOCAL ollama provider drives the wizard's degraded state; a
      // cloud catalogue hiccup keeps today's behavior (cached, unflagged).
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "llama3:8b", provider: "ollama", name: "llama3:8b", context_window: null },
        ],
        degraded_providers: ["anthropic"],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBeUndefined();
      expect(mockCacheSet).toHaveBeenCalled();
    });

    it("healthy response with an empty degraded_providers stays cached and unflagged", async () => {
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: null },
        ],
        degraded_providers: [],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBeUndefined();
      expect(mockCacheSet).toHaveBeenCalledWith(
        "llm:models",
        expect.objectContaining({ models: expect.any(Array) }),
        expect.any(Number)
      );
    });

    it("re-throws (500) when a reachable gateway returns a 5xx", async () => {
      // A reachable gateway erroring (503/500) or returning malformed JSON is a
      // real failure, NOT an unreachable gateway — it must surface as an error,
      // not be masked as an empty 200.
      mockListModels.mockRejectedValueOnce(
        new Error("AI Gateway error: 503")
      );
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(500);
      expect(mockCacheSet).not.toHaveBeenCalled();
    });

    it("caches a successful model list", async () => {
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(mockCacheSet).toHaveBeenCalledWith(
        "llm:models",
        expect.objectContaining({ models: expect.any(Array) }),
        expect.any(Number)
      );
    });
  });

  describe("GET /api/llm/models — defaultModel resolution (WARP-1511)", () => {
    it("resolves a blank stored value to the sole installed local model", async () => {
      readActiveChatModelMock.mockResolvedValue(null);
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: null },
        ],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.defaultModel).toBe("gpt-oss:20b");
    });

    it("resolves a stale stored tag (since removed) to the first installed model", async () => {
      readActiveChatModelMock.mockResolvedValue("gemma4:26b");
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "gpt-oss:20b", provider: "ollama", name: "gpt-oss:20b", context_window: null },
          { id: "llama3.2:3b", provider: "ollama", name: "llama3.2:3b", context_window: null },
        ],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.defaultModel).toBe("gpt-oss:20b");
    });

    it("leaves a valid stored value unchanged", async () => {
      readActiveChatModelMock.mockResolvedValue("llama3:8b");
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "llama3:8b", provider: "ollama", name: "llama3:8b", context_window: null },
        ],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.defaultModel).toBe("llama3:8b");
    });

    it("passes a previously-valid stored value through unresolved when the gateway is unreachable — never nulls it out", async () => {
      readActiveChatModelMock.mockResolvedValue("gpt-oss:20b");
      mockListModels.mockRejectedValueOnce(
        new Error("fetch failed: getaddrinfo ENOTFOUND ai-gateway-disabled"),
      );
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      expect(res.body.defaultModel).toBe("gpt-oss:20b");
    });

    it("passes a previously-valid stored value through unresolved when the gateway's ollama provider is degraded", async () => {
      readActiveChatModelMock.mockResolvedValue("gpt-oss:20b");
      mockListModels.mockResolvedValueOnce({
        models: [
          { id: "gpt-4o", provider: "openai", name: "GPT-4o", context_window: 128000 },
        ],
        degraded_providers: ["ollama"],
      });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.degraded).toBe(true);
      expect(res.body.defaultModel).toBe("gpt-oss:20b");
    });

    it("stays honestly null when nothing is installed", async () => {
      readActiveChatModelMock.mockResolvedValue(null);
      mockListModels.mockResolvedValueOnce({ models: [] });
      const res = await request(app).get("/api/llm/models");
      expect(res.status).toBe(200);
      expect(res.body.defaultModel).toBeNull();
    });
  });

  describe("POST /api/llm/chat", () => {
    it("rejects missing model", async () => {
      const res = await request(app)
        .post("/api/llm/chat")
        .send({ messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid request");
    });

    it("rejects missing messages", async () => {
      const res = await request(app)
        .post("/api/llm/chat")
        .send({ model: "llama3:8b" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid role", async () => {
      const res = await request(app)
        .post("/api/llm/chat")
        .send({
          model: "llama3:8b",
          messages: [{ role: "invalid", content: "hi" }],
        });
      expect(res.status).toBe(400);
    });

    it("rejects temperature out of range", async () => {
      const res = await request(app)
        .post("/api/llm/chat")
        .send({
          model: "llama3:8b",
          messages: [{ role: "user", content: "hi" }],
          temperature: 5.0,
        });
      expect(res.status).toBe(400);
    });

    it("returns AgentResult shape for valid non-streaming request", async () => {
      // /api/llm/chat now drives the orchestrator agent loop. Non-streaming
      // responses match the AgentResult shape from runAgent (assistant
      // message + trace + iterations + stop_reason), not the raw OpenAI
      // chat-completion shape the route used to forward verbatim.
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: "chatcmpl-abc",
          model: "llama3:8b",
          choices: [
            { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
          ],
        }),
      };
      mockChat.mockResolvedValueOnce(mockResponse);

      const res = await request(app)
        .post("/api/llm/chat")
        .send({
          model: "llama3:8b",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.message?.role).toBe("assistant");
      expect(res.body.message?.content).toBe("Hi!");
      expect(res.body.stop_reason).toBe("model_done");
      expect(Array.isArray(res.body.trace)).toBe(true);
      expect(mockChat).toHaveBeenCalledOnce();
    });

    // WARP-2652 — the fixture floor. Every chat case in this file ran against
    // a prompt missing the persona and business blocks, because the shared
    // Prisma double has no model for either singleton.
    it("assembles a base prompt carrying both the persona and the business block", async () => {
      let sys = "";
      mockChat.mockImplementationOnce(
        async (req: { messages?: { role: string; content: unknown }[] }) => {
          const first = req.messages?.[0];
          sys = first && typeof first.content === "string" ? first.content : "";
          return {
            ok: true,
            json: vi.fn().mockResolvedValue({
              choices: [
                { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
              ],
            }),
          };
        },
      );

      const res = await request(app)
        .post("/api/llm/chat")
        .set("x-test-role", "owner")
        .send({
          model: "llama3:8b",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(sys).toContain(PERSONA_BLOCK_PREFIX);
      expect(sys).toContain(BUSINESS_BLOCK_DELIMITER_OPEN);
    });

    it("persists an empty completion as a FAILED turn (WARP-854)", async () => {
      // Zero output + zero tool calls used to finalize `completed`, leaving
      // an invisible ghost turn in history. It must persist as `failed` so
      // the rehydrated UI shows the retry chip.
      mockChat.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [
            { index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" },
          ],
        }),
      });

      const res = await request(app)
        .post("/api/llm/chat")
        .set("x-test-role", "owner")
        .send({
          model: "llama3:8b",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.stop_reason).toBe("error");
      expect(mockFinalizeAssistantMessage).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });
  });

  describe("Key management", () => {
    it("POST /api/llm/keys/:provider stores key", async () => {
      const res = await request(app)
        .post("/api/llm/keys/anthropic")
        .send({ api_key: "sk-ant-test" });
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe("anthropic");
    });

    it("POST /api/llm/keys/:provider rejects missing key", async () => {
      const res = await request(app)
        .post("/api/llm/keys/anthropic")
        .send({});
      expect(res.status).toBe(400);
    });

    it("GET /api/llm/keys lists configured providers", async () => {
      const res = await request(app).get("/api/llm/keys");
      expect(res.status).toBe(200);
      expect(res.body.providers).toBeDefined();
    });

    it("DELETE /api/llm/keys/:provider removes key", async () => {
      const res = await request(app).delete("/api/llm/keys/anthropic");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("deleted");
    });
  });

  describe("PATCH /api/llm/conversations/:id", () => {
    it("renames a conversation owned by the caller", async () => {
      mockRenameConversationForUser.mockResolvedValue("Frigate ports");

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: "  Frigate ports  " });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "abc", title: "Frigate ports" });
      expect(res.body).not.toHaveProperty("updatedAt");
      expect(mockRenameConversationForUser).toHaveBeenCalledWith(
        "abc",
        "test",
        "  Frigate ports  ",
      );
    });

    it("returns 400 when neither title nor projectId is provided", async () => {
      const res1 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({});
      expect(res1.status).toBe(400);
      // WARP-845 widened the PATCH to also accept projectId moves.
      expect(res1.body).toMatchObject({ error: "title_or_project_required" });

      const res2 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: 42 });
      expect(res2.status).toBe(400);
      // A non-string title with no projectId falls through to the same
      // "nothing actionable in the body" rejection.
      expect(res2.body).toMatchObject({ error: "title_or_project_required" });
    });

    it("rejects an empty-string projectId outright (review fix)", async () => {
      // "" would skip setConversationProject's truthiness-guarded
      // ownership check and then violate the FK → 500. 400 instead.
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ projectId: "" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_project_id" });
      expect(mockRenameConversationForUser).not.toHaveBeenCalled();
    });

    it("rejects a malformed title even when a projectId rides along (review fix)", async () => {
      // Previously the title leg was silently dropped and the move
      // applied — a half-honored request. Now the whole PATCH 400s
      // before mutating anything.
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: 42, projectId: "11111111-1111-1111-1111-111111111111" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "title_or_project_required" });
      expect(mockRenameConversationForUser).not.toHaveBeenCalled();
    });

    it("returns 400 when service rejects an empty title", async () => {
      mockRenameConversationForUser.mockRejectedValue(new Error("title_required"));

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: "   " });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "title_required" });
    });

    it("returns 404 when the row doesn't belong to the caller", async () => {
      mockRenameConversationForUser.mockResolvedValue(null);

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: "Whatever" });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "conversation_not_found" });
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .send({ title: "Whatever" });
      expect(res.status).toBe(401);
    });

    // ── WARP-1917: pin / unpin ──

    it("pins a conversation owned by the caller", async () => {
      mockSetConversationPinned.mockResolvedValue(true);

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ pinned: true });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "abc", pinned: true });
      expect(mockSetConversationPinned).toHaveBeenCalledWith(
        "abc",
        "test",
        true,
      );
      // Pin-only PATCH must not touch the other legs.
      expect(mockRenameConversationForUser).not.toHaveBeenCalled();
    });

    it("unpins a conversation owned by the caller", async () => {
      mockSetConversationPinned.mockResolvedValue(true);

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ pinned: false });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "abc", pinned: false });
      expect(mockSetConversationPinned).toHaveBeenCalledWith(
        "abc",
        "test",
        false,
      );
    });

    it("rejects a non-boolean pinned outright (nothing half-applied)", async () => {
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ pinned: "yes" });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_pinned" });
      expect(mockSetConversationPinned).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean pinned even when a valid title rides along", async () => {
      // Same posture as the malformed-title-with-projectId case above:
      // the whole PATCH 400s before mutating anything.
      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: "Fine title", pinned: 1 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_pinned" });
      expect(mockRenameConversationForUser).not.toHaveBeenCalled();
      expect(mockSetConversationPinned).not.toHaveBeenCalled();
    });

    it("returns 404 when pinning a row that doesn't belong to the caller", async () => {
      mockSetConversationPinned.mockResolvedValue(false);

      const res = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ pinned: true });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "conversation_not_found" });
    });
  });
});

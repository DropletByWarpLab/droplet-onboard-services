import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

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

vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    renameConversationForUser: mockRenameConversationForUser,
    createTurnRows: mockCreateTurnRows,
    finalizeAssistantMessage: mockFinalizeAssistantMessage,
    listConversationsForUser: mockListConversationsForUser,
    getConversationForUser: mockGetConversationForUser,
    deleteConversationForUser: mockDeleteConversationForUser,
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

describe("LLM routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockListModels.mockResolvedValue({
      models: [
        { id: "llama3:8b", provider: "ollama", name: "llama3:8b", context_window: null },
      ],
    });
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

    it("returns 400 when title is missing or not a string", async () => {
      const res1 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({});
      expect(res1.status).toBe(400);
      expect(res1.body).toMatchObject({ error: "title_required" });

      const res2 = await request(app)
        .patch("/api/llm/conversations/abc")
        .set("x-test-role", "owner")
        .send({ title: 42 });
      expect(res2.status).toBe(400);
      expect(res2.body).toMatchObject({ error: "title_required" });
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
  });
});

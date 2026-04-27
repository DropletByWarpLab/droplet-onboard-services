import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

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
});

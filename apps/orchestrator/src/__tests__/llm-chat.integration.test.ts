import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import type express from "express";
import type { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";

// Stub auth middleware so the request reaches the route handler. The
// real middleware validates against Nextcloud OCS which we don't run in
// unit tests.
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Stub the MCP singleton so /api/llm/chat doesn't try to spawn the
// mcp-server child process inside a unit test. Both ensureMcpStarted
// and the singleton's listTools/callTool are replaced with controllable
// fakes.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([
      {
        name: "list_network_devices",
        description: "List devices",
        inputSchema: { type: "object", properties: {} },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ devices: [] }) }],
      isError: false,
    }),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
}));

// Stub the ai-gateway client so we control what the agent loop sees.
const mockChat = vi.fn();
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: (...args: unknown[]) => mockChat(...args),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

describe("/api/llm/chat (orchestrator agent loop)", () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createApp } = await import("../app.js");
    const prisma = new PrismaClient();
    app = createApp(prisma);
  });

  it("non-streaming returns AgentResult shape (assistant message + trace)", async () => {
    mockChat.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "no devices" } }],
      }),
    });
    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "show devices" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.message?.role).toBe("assistant");
    expect(res.body.message?.content).toBe("no devices");
    expect(Array.isArray(res.body.trace)).toBe(true);
    expect(res.body.stop_reason).toBe("model_done");
    expect(typeof res.body.iterations).toBe("number");
  });

  it("streaming emits content_delta + done events", async () => {
    mockChat.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "hi back" } }],
      }),
    });
    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      })
      .buffer(true)
      .parse((stream, cb) => {
        let data = "";
        stream.on("data", (chunk: Buffer | string) => (data += chunk.toString()));
        stream.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    const text = (res.body as string) ?? res.text ?? "";
    expect(text).toMatch(/event: content_delta/);
    expect(text).toMatch(/event: done/);
  });

  it("streaming emits tool_call + tool_result events when the model dispatches a tool", async () => {
    mockChat
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: { name: "list_network_devices", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "no devices" } }],
        }),
      });
    const res = await request(app)
      .post("/api/llm/chat")
      .send({
        model: "ollama/qwen3",
        messages: [{ role: "user", content: "show devices" }],
        stream: true,
      })
      .buffer(true)
      .parse((stream, cb) => {
        let data = "";
        stream.on("data", (chunk: Buffer | string) => (data += chunk.toString()));
        stream.on("end", () => cb(null, data));
      });
    const text = (res.body as string) ?? res.text ?? "";
    expect(text).toMatch(/event: tool_call/);
    expect(text).toMatch(/event: tool_result/);
    expect(text).toMatch(/event: done/);
    expect(text).toMatch(/"name":"list_network_devices"/);
  });

  it("rejects invalid request body with 400", async () => {
    const res = await request(app)
      .post("/api/llm/chat")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

// Stub ai-gateway so the orchestrator boots without a live FastAPI process.
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn(),
  deleteKey: vi.fn(),
}));

const mockListTools = vi.fn();
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

describe("GET /api/llm/tools", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns tools from MCP listTools, projecting inputSchema → parameters", async () => {
    mockListTools.mockResolvedValueOnce([
      {
        name: "list_files",
        description: "list files",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "get_network_status",
        description: "network status",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const res = await request(app).get("/api/llm/tools");
    expect(res.status).toBe(200);
    expect(mockListTools).toHaveBeenCalledOnce();
    expect(res.body.tools).toEqual([
      {
        name: "list_files",
        description: "list files",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "get_network_status",
        description: "network status",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("surfaces an MCP failure as a 500", async () => {
    mockListTools.mockRejectedValueOnce(new Error("MCP child crashed"));

    const res = await request(app).get("/api/llm/tools");
    expect(res.status).toBe(500);
  });
});

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";

// Stub auth middleware — pulls a role from `x-test-role` so RBAC tests
// can pretend to be different users without rebuilding the middleware
// chain. Matches the pattern in `llm-chat.integration.test.ts`.
// WARP-171: also stub `requireRole` as a no-op so route files that now
// import it (auth, devices, files, …) load cleanly. RBAC coverage for
// these guards lives in `rbac.test.ts` which uses the real middleware.
vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: { username: string; role: string } }).user =
        { username: "test", role };
    }
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  // BUG-11 follow-up: app.ts now installs requirePasswordChangeGate on
  // every request; stub it as a pass-through like requireRole.
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  // WARP-485: app.ts wires the OCS-fallback Prisma reference via
  // setAuthPrisma at boot. Stub the export so the mock isn't missing
  // a symbol app.ts now imports.
  setAuthPrisma: () => {},
}));

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

  // RBAC: the route filters write tools by role so unprivileged users
  // can't enumerate the destructive surface (info-disclosure that would
  // help craft prompt-injection attempts). Execution is gated
  // separately on `/api/llm/chat`. Both are needed.

  it("filters write tools out of the advertised list for family role", async () => {
    mockListTools.mockResolvedValueOnce([
      {
        name: "list_network_devices",
        description: "list devices",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "block_network_device",
        description: "block a device",
        inputSchema: { type: "object", properties: { mac: { type: "string" } } },
      },
      {
        name: "write_file",
        description: "write a file",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const res = await request(app)
      .get("/api/llm/tools")
      .set("x-test-role", "family");
    expect(res.status).toBe(200);
    const names = (res.body.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).not.toContain("block_network_device");
    expect(names).not.toContain("write_file");
  });

  it("filters write tools out for guest role", async () => {
    mockListTools.mockResolvedValueOnce([
      {
        name: "list_files",
        description: "list",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "delete_file",
        description: "delete",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const res = await request(app)
      .get("/api/llm/tools")
      .set("x-test-role", "guest");
    expect(res.status).toBe(200);
    const names = (res.body.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["list_files"]);
  });

  it("admin role sees write tools advertised", async () => {
    mockListTools.mockResolvedValueOnce([
      {
        name: "list_network_devices",
        description: "list",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "block_network_device",
        description: "block",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const res = await request(app)
      .get("/api/llm/tools")
      .set("x-test-role", "admin");
    expect(res.status).toBe(200);
    const names = (res.body.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("list_network_devices");
    expect(names).toContain("block_network_device");
  });

  it("owner role sees write tools advertised", async () => {
    mockListTools.mockResolvedValueOnce([
      {
        name: "list_files",
        description: "list",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "send_notification",
        description: "send",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const res = await request(app)
      .get("/api/llm/tools")
      .set("x-test-role", "owner");
    expect(res.status).toBe(200);
    const names = (res.body.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("send_notification");
  });
});

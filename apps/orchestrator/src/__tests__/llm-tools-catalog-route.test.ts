/**
 * WARP-555 — GET /api/llm/tools/catalog
 *
 * Read-only capability catalog for the dashboard `/tools` surface. Unlike
 * `GET /api/llm/tools` (which proxies the live MCP child's `tools/list`
 * and so can 500 if the child crashed), this route reads the in-process
 * `TOOL_CATALOG` from `@droplet/tools-core`. That gives it three things
 * the JSON-RPC shape omits — `domain`, `requiresWrite`,
 * `requiresConfirmation` — and makes it robust enough to back a
 * page that should always render.
 *
 * RBAC mirrors `GET /api/llm/tools`: owner/admin see every tool;
 * family/guest/unauthenticated see only read-only tools (no
 * information-disclosure of the destructive surface).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { TOOL_CATALOG } from "@droplet/tools-core";

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
  setAuthPrisma: () => {},
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn(),
  deleteKey: vi.fn(),
}));

// The catalog route must NOT touch the MCP child. If it does, this mock
// throwing makes the dependency obvious.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn(() => {
      throw new Error("catalog route must not call mcpClient.listTools");
    }),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

const WRITE_TOOL = TOOL_CATALOG.find((t) => t.requiresWrite)!.name;
const READ_TOOL = TOOL_CATALOG.find((t) => !t.requiresWrite)!.name;

describe("GET /api/llm/tools/catalog (WARP-555)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("returns the full catalog with domain + safety flags for owner", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "owner");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tools)).toBe(true);
    // Owner sees every registered tool.
    expect(res.body.tools.length).toBe(TOOL_CATALOG.length);

    const sample = res.body.tools.find(
      (t: { name: string }) => t.name === READ_TOOL,
    );
    expect(sample).toBeDefined();
    expect(sample).toHaveProperty("name");
    expect(sample).toHaveProperty("description");
    expect(sample).toHaveProperty("domain");
    expect(sample).toHaveProperty("requiresWrite");
    expect(sample).toHaveProperty("requiresConfirmation");
  });

  it("includes the ordered domain list so the client can build filters", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "owner");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.domains)).toBe(true);
    expect(res.body.domains[0]).toBe("network");
    // every domain on a tool is present in the list
    const domainsOnTools = new Set(
      res.body.tools.map((t: { domain: string }) => t.domain),
    );
    for (const d of domainsOnTools) {
      expect(res.body.domains).toContain(d);
    }
  });

  it("hides write tools from family role", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "family");
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain(READ_TOOL);
    expect(names).not.toContain(WRITE_TOOL);
    // and every returned tool is read-only
    for (const t of res.body.tools as { requiresWrite: boolean }[]) {
      expect(t.requiresWrite).toBe(false);
    }
  });

  it("hides write tools from guest role", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "guest");
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain(WRITE_TOOL);
  });

  it("hides write tools from an unauthenticated request (no role)", async () => {
    const res = await request(app).get("/api/llm/tools/catalog");
    expect(res.status).toBe(200);
    for (const t of res.body.tools as { requiresWrite: boolean }[]) {
      expect(t.requiresWrite).toBe(false);
    }
  });

  it("admin sees the write tool", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "admin");
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: { name: string }) => t.name);
    expect(names).toContain(WRITE_TOOL);
  });
});

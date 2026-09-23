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
// WARP-2969 — asserted against the SHIPPED list, never a restated copy.
import { EXCLUDED_FROM_CHAT_TOOLS } from "../services/chat-tool-scope.js";

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

/**
 * WARP-2969 — per-tool `reach`.
 *
 * The catalog filters on ONE predicate (`requiresWrite`) and so reported
 * every registered tool as if a chat turn could reach it. The chat-scope
 * policy list says otherwise for 54 of them long before the model sees a
 * schema: they are reachable from their own screen or over MCP, never by
 * asking. `/tools` listed all 142 and named no reason for any of it.
 *
 * `reach` ANNOTATES, it never filters — an MCP client can still call a tool
 * chat withholds, so dropping it here would be a second, wrong answer. The
 * verdict is `EXCLUDED_FROM_CHAT_TOOLS` itself, called, not re-derived; the
 * same list `tool-inspect.service.ts` reports as its `chat_policy` gate.
 *
 * ONE AXIS ON PURPOSE. An earlier cut of this shipped a `module` axis too,
 * from `domainsForFeatures`. It would have LIED: §6 module gating is not
 * applied to the chat pool for an owner or anybody holding no AccessRole —
 * `resolveToolAccessScope` returns a null scope for them
 * (tool-access.service.ts), `narrowToolsToScope` passes a null scope through
 * untouched, and `llm-agent.service.ts` narrows the pool by
 * EXCLUDED_FROM_CHAT_TOOLS alone. `list_cameras` reaches the model on a box
 * with `cameras` switched off. Wiring that gate for everyone is WARP-2972;
 * the axis comes back here once it is true.
 */
describe("GET /api/llm/tools/catalog reach (WARP-2969)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  async function reachFor(name: string) {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "owner");
    expect(res.status).toBe(200);
    const tool = (res.body.tools as { name: string; reach?: unknown }[]).find(
      (t) => t.name === name,
    );
    expect(tool, `${name} missing from the catalog`).toBeDefined();
    return tool!.reach as { chat: string };
  }

  it("marks a chat-excluded tool as chat:excluded", async () => {
    // The switch fabric is a dashboard/installer surface — every one of its
    // tools sits in EXCLUDED_FROM_CHAT_TOOLS.
    expect(await reachFor("get_switch_ports")).toEqual({ chat: "excluded" });
  });

  it("marks a tool a turn can reach as chat:allowed", async () => {
    expect(await reachFor("get_system_health")).toEqual({ chat: "allowed" });
  });

  it("agrees with EXCLUDED_FROM_CHAT_TOOLS for every tool, not just the samples", async () => {
    // The whole point is that the route calls the shipped list rather than
    // keeping its own. Pin that for all 142 rather than trusting two names.
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "owner");
    for (const t of res.body.tools as { name: string; reach: { chat: string } }[]) {
      expect(t.reach.chat, t.name).toBe(
        EXCLUDED_FROM_CHAT_TOOLS.has(t.name) ? "excluded" : "allowed",
      );
    }
  });

  it("carries NO module axis — that gate is not enforced on chat yet (WARP-2972)", async () => {
    expect(await reachFor("list_cameras")).not.toHaveProperty("module");
  });

  it("keeps the response additive — the WARP-555 fields are untouched", async () => {
    const res = await request(app)
      .get("/api/llm/tools/catalog")
      .set("x-test-role", "owner");
    expect(res.body.tools.length).toBe(TOOL_CATALOG.length);
    const sample = res.body.tools[0];
    for (const k of ["name", "description", "homeDescription", "domain", "requiresWrite", "requiresConfirmation"]) {
      expect(sample).toHaveProperty(k);
    }
  });
});

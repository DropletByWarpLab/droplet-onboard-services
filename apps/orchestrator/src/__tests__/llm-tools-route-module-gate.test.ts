/**
 * WARP-2972 — GET /api/llm/tools is module-gated.
 *
 * The route lists the live MCP child's `tools/list`, narrowed by the caller's
 * write tier alone. It applied NO module axis and no §3 scope, so a disabled
 * module's tools were offered to everyone — including the owner and every
 * person with no AccessRole, for whom the §3 scope is null. Now a tool whose
 * domain a module toggle (the box) or the caller's own grants withhold is
 * ABSENT: the list is shorter, the request is not an error, and the rest of the
 * list is untouched.
 *
 * The person axis is driven through the REAL verdict resolver and the real §3
 * composition, so "a role-less user with a deny exception" is the shipped
 * answer, not a fixture's.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient, type ModuleId } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { FAIL_CLOSED_MODULE_VERDICT, TOOL_CATALOG } from "@droplet/tools-core";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    const id = req.headers["x-test-id"];
    if (typeof role === "string" && role.length > 0) {
      (req as unknown as { user?: Record<string, string> }).user = {
        id: typeof id === "string" ? id : "u-anon",
        username: typeof id === "string" ? id : "anon",
        role,
      };
    }
    next();
  },
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
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

// The live MCP child's list: every registered tool, as its `tools/list` returns them.
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn(async () =>
      (await import("@droplet/tools-core")).TOOL_CATALOG.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object" },
      })),
    ),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { GATEABLE_MODULE_IDS } from "../services/access-catalog.js";
import { computeEffectiveAccess } from "../services/effective-access.service.js";
import {
  _setToolModuleVerdictForTests,
  createModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";

const ALL: ModuleId[] = ["chat", ...GATEABLE_MODULE_IDS];
const without = (...off: ModuleId[]) => new Set(ALL.filter((m) => !off.includes(m)));
const inDomain = (domain: string) =>
  TOOL_CATALOG.filter((t) => t.domain === domain && !t.requiresWrite).map((t) => t.name);

const CAMERA_READ = inDomain("cameras");
const EMAIL_READ = inDomain("email");
const NETWORK_READ = inDomain("network");
const UNCLAIMED_READ = inDomain("system");

/** A resolver over an in-memory directory: the real resolver, the real §3 composition. */
function bindResolver(opts: {
  box: Set<ModuleId>;
  people?: Record<string, { role: "owner" | "admin" | "family" | "guest"; deny?: ModuleId[] }>;
}) {
  const people = opts.people ?? {};
  _setToolModuleVerdictForTests(
    createModuleVerdictResolver({
      prisma: {
        user: {
          findMany: vi.fn(async ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
            const wanted = new Set(where.OR.flatMap((c) => Object.values(c)));
            return Object.entries(people)
              .filter(([id]) => wanted.has(id))
              .map(([id, p]) => ({
                id,
                username: id,
                role: p.role,
                displayName: id,
                email: null,
                directoryStatus: "ACTIVE",
              }));
          }),
        },
      } as never,
      boxModuleIds: async () => opts.box,
      personModuleIds: async (userId) => {
        const p = people[userId];
        if (!p) return null;
        return new Set(
          computeEffectiveAccess({
            user: { id: userId, role: p.role, accessRole: null },
            exceptions: (p.deny ?? []).map((moduleId, i) => ({
              id: `x${i}`,
              moduleId,
              effect: "deny" as const,
              level: null,
            })),
            workspaceModuleIds: opts.box,
            cloudEscapeEnabled: false,
            connections: [],
            usagePolicy: null,
            deptRights: [],
          }).features.map((f) => f.moduleId),
        );
      },
    }),
  );
}

describe("GET /api/llm/tools — module gating (WARP-2972)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => bindResolver({ box: without(), people: { olive: { role: "owner" } } }));
  afterEach(() => _setToolModuleVerdictForTests(async () => ({ withheldDomains: new Set() })));

  async function listFor(role: string, id?: string) {
    const req = request(app).get("/api/llm/tools").set("x-test-role", role);
    const res = await (id ? req.set("x-test-id", id) : req);
    expect(res.status).toBe(200);
    return (res.body.tools as { name: string }[]).map((t) => t.name);
  }

  it("baseline: every module on, the owner is offered the cameras and email tools", async () => {
    bindResolver({ box: without(), people: { olive: { role: "owner" } } });
    const names = await listFor("owner", "olive");
    for (const n of [...CAMERA_READ, ...EMAIL_READ]) expect(names, n).toContain(n);
  });

  describe("module off for the BOX", () => {
    it("the OWNER (null §3 scope) no longer sees the module's tools; the rest are untouched", async () => {
      bindResolver({ box: without("cameras"), people: { olive: { role: "owner" } } });
      const names = await listFor("owner", "olive");
      for (const n of CAMERA_READ) expect(names, n).not.toContain(n);
      for (const n of [...NETWORK_READ, ...EMAIL_READ, ...UNCLAIMED_READ]) expect(names, n).toContain(n);
    });

    it("a role-less ADMIN and a role-less FAMILY member lose them too", async () => {
      bindResolver({
        box: without("cameras"),
        people: { ada: { role: "admin" }, fay: { role: "family" } },
      });
      for (const [role, id] of [["admin", "ada"], ["family", "fay"]] as const) {
        const names = await listFor(role, id);
        for (const n of CAMERA_READ) expect(names, `${role}/${n}`).not.toContain(n);
        for (const n of NETWORK_READ) expect(names, `${role}/${n}`).toContain(n);
      }
    });

    it("a module UNAVAILABLE on the box reads the same (the box set is what the route gate reads)", async () => {
      bindResolver({ box: without("smart_home") });
      const names = await listFor("owner", "olive");
      for (const n of inDomain("smart-home")) expect(names, n).not.toContain(n);
    });

    it("a caller with no principal id is the box", async () => {
      bindResolver({ box: without("email") });
      const names = await listFor("owner");
      for (const n of EMAIL_READ) expect(names, n).not.toContain(n);
    });
  });

  describe("module off for the PERSON", () => {
    it("a role-less admin with a DENY exception loses that module's tools; the owner keeps them", async () => {
      bindResolver({
        box: without(),
        people: { carol: { role: "admin", deny: ["email"] }, olive: { role: "owner" } },
      });
      const carol = await listFor("admin", "carol");
      const olive = await listFor("owner", "olive");
      for (const n of EMAIL_READ) {
        expect(carol, `carol/${n}`).not.toContain(n);
        expect(olive, `olive/${n}`).toContain(n);
      }
      for (const n of CAMERA_READ) expect(carol, `carol/${n}`).toContain(n);
    });

    it("the exception moves nothing for someone else", async () => {
      bindResolver({
        box: without(),
        people: { carol: { role: "admin", deny: ["email"] }, dave: { role: "admin" } },
      });
      const dave = await listFor("admin", "dave");
      for (const n of EMAIL_READ) expect(dave, n).toContain(n);
    });
  });

  describe("absent, not empty and not erroring", () => {
    it("even with EVERY module off the request succeeds with a list, and the unclaimed domains remain", async () => {
      bindResolver({ box: new Set<ModuleId>(["chat"]) });
      const names = await listFor("owner", "olive");
      expect(names.length).toBeGreaterThan(0);
      for (const n of UNCLAIMED_READ) expect(names, n).toContain(n);
    });

    it("an unwired process fails CLOSED: module-owned tools withheld, unclaimed kept, still a 200", async () => {
      _setToolModuleVerdictForTests(null);
      const names = await listFor("owner", "olive");
      for (const n of [...CAMERA_READ, ...EMAIL_READ, ...NETWORK_READ]) expect(names, n).not.toContain(n);
      for (const n of UNCLAIMED_READ) expect(names, n).toContain(n);
    });

    it("a resolver that THROWS fails closed the same way", async () => {
      _setToolModuleVerdictForTests(async () => {
        throw new Error("resolver exploded");
      });
      const names = await listFor("owner", "olive");
      for (const n of CAMERA_READ) expect(names, n).not.toContain(n);
      for (const n of UNCLAIMED_READ) expect(names, n).toContain(n);
      expect(FAIL_CLOSED_MODULE_VERDICT.withheldDomains.has("cameras")).toBe(true);
    });
  });

  it("does not widen the write tier: a family caller still sees no write tool", async () => {
    bindResolver({ box: without(), people: { fay: { role: "family" } } });
    const names = await listFor("family", "fay");
    const write = TOOL_CATALOG.find((t) => t.requiresWrite)!.name;
    expect(names).not.toContain(write);
  });
});

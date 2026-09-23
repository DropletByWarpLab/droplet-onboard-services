/**
 * WARP-2988 — the `_service:mcp` principal is narrowed on the CRM / PM routes by
 * the ACTING user's §3 tool scope: `business` must be in reach (CRM or
 * Projects), and a write needs `use`. Mounted through the real registry
 * prefixes (`mountMcpActingUserGates`), so a prefix the registry adds is
 * covered without editing this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { MODULES } from "../modules/module-registry.js";
import {
  MCP_ACTING_USER_GATED_DOMAINS,
  mountMcpActingUserGates,
} from "../modules/module-mounts.js";
import {
  actingUserAccessResolver,
  MCP_PRINCIPAL_ID,
  type ActingUserAccessResolver,
} from "./mcp-acting-user-gate.js";
import type { AttributedToolAccess, ToolAccessScope } from "../services/tool-access.service.js";

const scope = (domains: string[], writeDomains: string[] = []): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks: false,
});
const ok = (s: ToolAccessScope | null): AttributedToolAccess => ({ scope: s, tier: "admin", unresolved: null });

const resolveMock = vi.fn<ActingUserAccessResolver>();

function appAs(
  user: { id: string; role: string },
  resolve: ActingUserAccessResolver = resolveMock,
): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { ...user, username: user.id, displayName: user.id };
    next();
  });
  mountMcpActingUserGates(app, resolve);
  for (const path of ["/api/crm/companies", "/api/pm/work-items", "/api/mobile/pm/projects", "/api/files/x"]) {
    app.get(path, (_q, res) => { res.json({ hit: path }); });
    app.post(path, (_q, res) => { res.json({ hit: path }); });
  }
  return app;
}

const MCP = { id: MCP_PRINCIPAL_ID, role: "service" };

beforeEach(() => resolveMock.mockReset());

describe("mcp acting-user gate — who it applies to", () => {
  it("never touches a human, whatever header they send", async () => {
    const res = await request(appAs({ id: "u-1", role: "family" }))
      .get("/api/crm/companies")
      .set("X-Nextcloud-User", "someone");
    expect(res.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("passes an mcp call that names nobody (internal stdio, pre-flighted upstream)", async () => {
    const res = await request(appAs(MCP)).get("/api/crm/companies");
    expect(res.status).toBe(200);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("is not mounted on a module that does not claim `business`", async () => {
    resolveMock.mockResolvedValue(ok(scope([])));
    const res = await request(appAs(MCP)).get("/api/files/x").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(200);
  });
});

describe("mcp acting-user gate — the acting user's scope decides", () => {
  it("owner / no custom role (null scope) passes, reads and writes", async () => {
    resolveMock.mockResolvedValue(ok(null));
    const app = appAs(MCP);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it("business in reach: reads pass; a write needs `use`", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"])));
    const app = appAs(MCP);
    expect((await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    const write = await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(write.status).toBe(404);
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it.each([
    ["/api/crm/companies", "crm"],
    ["/api/pm/work-items", "projects"],
    ["/api/mobile/pm/projects", "projects"],
  ])("business NOT in reach: %s is 404 module_disabled (%s)", async (path, module) => {
    resolveMock.mockResolvedValue(ok(scope(["files", "crm", "pm"], ["files"])));
    const res = await request(appAs(MCP)).get(path).set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module });
  });

  it("fails closed on an unresolved acting user and on a resolver throw", async () => {
    resolveMock.mockResolvedValue({ scope: scope([]), tier: null, unresolved: "user_missing" });
    expect((await request(appAs(MCP)).get("/api/crm/companies").set("X-Nextcloud-User", "ghost")).status).toBe(404);
    // A plain throwing resolver, not a spy: vitest reports a spy's thrown
    // error as the test's failure even when the code under test catches it.
    const throwing: ActingUserAccessResolver = async () => {
      throw new Error("db down");
    };
    const res = await request(appAs(MCP, throwing)).get("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(404);
  });
});

describe("actingUserAccessResolver — fail closed on identity", () => {
  it("an unknown Nextcloud username resolves to unresolved `user_missing`", async () => {
    const prisma = { user: { findUnique: vi.fn(async () => null) } } as never;
    const access = await actingUserAccessResolver(prisma)("ghost");
    expect(access.unresolved).toBe("user_missing");
  });

  it("a lookup error resolves to unresolved `read_failed`", async () => {
    const prisma = { user: { findUnique: vi.fn(async () => { throw new Error("db"); }) } } as never;
    const access = await actingUserAccessResolver(prisma)("sam");
    expect(access.unresolved).toBe("read_failed");
  });
});

// The gate refuses by route prefix, not by tool name, so it is only sound if
// every tool hop under a gated module's prefixes belongs to the gated domain —
// otherwise it would silently kill another domain's tool — and if reads are
// GET and writes are not, since the write check keys off the method.
describe("mcp acting-user gate — the route manifest agrees with it", () => {
  const catalog = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
  for (const domain of MCP_ACTING_USER_GATED_DOMAINS) {
    const prefixes = MODULES.filter((m) => m.toolDomains.includes(domain)).flatMap((m) => m.routePrefixes);
    const under = (p: string) => prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
    const hops = TOOL_ROUTES.flatMap((e) => e.hops.map((h) => ({ tool: e.tool, ...h }))).filter((h) =>
      under(h.pathPattern),
    );

    it(`${domain}: there are tool hops under ${prefixes.join(", ")}`, () => {
      expect(hops.length).toBeGreaterThan(0);
    });

    it(`${domain}: every such hop is a ${domain} tool, reads GET and writes non-GET`, () => {
      for (const h of hops) {
        const entry = catalog.get(h.tool);
        expect(entry?.domain, `${h.tool} ${h.method} ${h.pathPattern}`).toBe(domain);
        expect(h.method === "get", `${h.tool} ${h.method} ${h.pathPattern}`).toBe(!entry!.requiresWrite);
      }
    });
  }
});

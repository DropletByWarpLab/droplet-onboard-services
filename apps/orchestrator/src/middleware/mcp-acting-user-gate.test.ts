/**
 * WARP-2988 — the `_service:mcp` principal is narrowed on the CRM / PM routes by
 * the ACTING user's §3 tool scope: `business` must be in reach (CRM or
 * Projects), and a write needs `use`. Mounted through the real registry
 * prefixes (`mountMcpActingUserGates`), so a prefix the registry adds is
 * covered without editing this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  FEATURE_GATED_MODULES,
  MCP_ACTING_USER_GATED_DOMAINS,
  mountMcpActingUserGates,
} from "../modules/module-mounts.js";
import {
  actingUserAccessResolver,
  MCP_PRINCIPAL_ID,
  type ActingUserAccess,
  type ActingUserAccessResolver,
} from "./mcp-acting-user-gate.js";
import type { ToolAccessScope } from "../services/tool-access.service.js";
import type { EffectiveAccessResolver } from "./feature-gate.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import type { ModuleId } from "@prisma/client";

const scope = (domains: string[], writeDomains: string[] = []): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks: false,
});
const ok = (s: ToolAccessScope | null): ActingUserAccess => ({
  scope: s,
  tier: "admin",
  unresolved: null,
  userId: "u-sam",
});

const resolveMock = vi.fn<ActingUserAccessResolver>();

/** The acting person's §9 features; both business modules held unless a case says otherwise. */
let heldFeatures: ModuleId[] = ["crm", "projects"];
const featuresOf: EffectiveAccessResolver = async () =>
  ({ features: heldFeatures.map((moduleId) => ({ moduleId, level: "view" })) }) as unknown as EffectiveAccessResult;

function appAs(
  user: { id: string; role: string },
  resolve: ActingUserAccessResolver = resolveMock,
  features: EffectiveAccessResolver = featuresOf,
): Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { ...user, username: user.id, displayName: user.id };
    next();
  });
  mountMcpActingUserGates(app, resolve, features);
  for (const path of ["/api/crm/companies", "/api/pm/work-items", "/api/mobile/pm/projects", "/api/files/x"]) {
    app.get(path, (_q, res) => { res.json({ hit: path }); });
    app.post(path, (_q, res) => { res.json({ hit: path }); });
  }
  return app;
}

const MCP = { id: MCP_PRINCIPAL_ID, role: "service" };

beforeEach(() => {
  resolveMock.mockReset();
  heldFeatures = ["crm", "projects"];
});

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
    resolveMock.mockResolvedValue({ scope: scope([]), tier: null, unresolved: "user_missing", userId: null });
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

// Stefan's review of #2298: `business` passes on CRM OR Projects, but the data
// under a prefix belongs to ONE module, and a person who cannot open that
// module in the browser must not read it through the assistant either.
// Browser parity (Romain: "the assistant never reaches more than the person
// could in the browser"): the feature check runs exactly where
// `mountModuleGates` puts `requireFeatureAccess` for a human —
// FEATURE_GATED_MODULES — and nowhere else.
describe("mcp acting-user gate — the feature check mirrors the browser's", () => {
  it("Projects only: PM routes answer, CRM routes are 404 module_disabled (crm)", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    heldFeatures = ["projects"];
    const app = appAs(MCP);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/mobile/pm/projects").set("X-Nextcloud-User", "sam")).status).toBe(200);
    const crm = await request(app).get("/api/crm/companies").set("X-Nextcloud-User", "sam");
    expect(crm.status).toBe(404);
    expect(crm.body).toEqual({ error: "module_disabled", module: "crm" });
  });

  it("CRM only: CRM AND PM routes answer — projects is not feature-gated in the browser", async () => {
    // Stefan's re-review: a per-module `projects` check here refused the
    // `/api/pm/projects` enrichment of `business_find({entity:"customer"})`
    // and failed the whole call for a CRM-only person who CAN open /api/pm
    // in the browser. MUTATION: pass `features` for every module in
    // mountMcpActingUserGates -> the PM calls are 404.
    resolveMock.mockResolvedValue(ok(scope(["business"], ["business"])));
    heldFeatures = ["crm"];
    const app = appAs(MCP);
    expect((await request(app).post("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).post("/api/pm/work-items").set("X-Nextcloud-User", "sam")).status).toBe(200);
    expect((await request(app).get("/api/mobile/pm/projects").set("X-Nextcloud-User", "sam")).status).toBe(200);
  });

  it("the feature check runs on exactly the business modules the browser feature-gates", () => {
    const business = MODULES.filter((m) => m.toolDomains.includes("business")).map((m) => m.id);
    expect(business.filter((id) => FEATURE_GATED_MODULES.has(id))).toEqual(["crm"]);
  });

  it("applies to a null tool scope too (the owner bypass is question 1 only)", async () => {
    resolveMock.mockResolvedValue(ok(null));
    heldFeatures = ["projects"];
    expect((await request(appAs(MCP)).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status).toBe(404);
  });

  it("no local row (resolver null) passes, as requireFeatureAccess does; a throw fails closed", async () => {
    resolveMock.mockResolvedValue(ok(scope(["business"])));
    expect(
      (await request(appAs(MCP, resolveMock, async () => null)).get("/api/crm/companies").set("X-Nextcloud-User", "sam"))
        .status,
    ).toBe(200);
    const throwing: EffectiveAccessResolver = async () => {
      throw new Error("db down");
    };
    expect(
      (await request(appAs(MCP, resolveMock, throwing)).get("/api/crm/companies").set("X-Nextcloud-User", "sam")).status,
    ).toBe(404);
  });
});

describe("actingUserAccessResolver — fail closed on identity", () => {
  // A Prisma double that HONOURS `where`, with the account shape that broke:
  // SSO / SCIM users have no `nextcloudUsername`.
  const SSO_USER = {
    id: "3f1c2a9e-0000-4000-8000-000000000001",
    username: "sam",
    nextcloudUsername: null,
    role: "owner",
    directoryStatus: "ACTIVE",
    accessRoleId: null,
    accessRole: null,
  };
  const prismaWithUsers = () =>
    ({
      user: {
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          const [[col, val]] = Object.entries(where);
          return (SSO_USER as Record<string, unknown>)[col] === val ? SSO_USER : null;
        }),
      },
    }) as never;

  it("stdio names the acting user by username — an SSO user with no nextcloudUsername resolves", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())("sam");
    expect(access).toMatchObject({ unresolved: null, scope: null, userId: SSO_USER.id });
  });

  it("the HTTP transport names them by User.id (claims.sub) — that resolves too", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())(SSO_USER.id);
    expect(access).toMatchObject({ unresolved: null, userId: SSO_USER.id });
  });

  it("a name matching neither column is `user_missing`", async () => {
    const access = await actingUserAccessResolver(prismaWithUsers())("ghost");
    expect(access).toMatchObject({ unresolved: "user_missing", userId: null });
  });

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

describe("mcp acting-user gate — app.ts wiring", () => {
  it("app.ts mounts it with the real resolver, after the module gates and before the CRM / PM / Security-assistant routers", () => {
    const src = readFileSync(join(__dirname, "..", "app.ts"), "utf8");
    const gates = src.indexOf("mountModuleGates(app, moduleGate)");
    const acting = src.indexOf("mountMcpActingUserGates(app, actingUserAccessResolver(prisma))");
    const routers = [
      'app.use("/api", createPmNativeRouter(prisma))',
      'app.use("/api", createCrmRouter(prisma))',
      "app.use(createPmMobileRouter(prisma))",
      // WARP-2979 — the `security` domain's only hops.
      'app.use("/api", createSecurityAssistantRouter(prisma))',
    ].map((r) => [r, src.indexOf(r)] as const);
    expect(gates).toBeGreaterThan(-1);
    expect(acting).toBeGreaterThan(gates);
    for (const [r, i] of routers) {
      expect(i, r).toBeGreaterThan(-1);
      expect(acting, r).toBeLessThan(i);
    }
  });
});

// The gate refuses by route prefix, not by tool name, so it is only sound if
// every tool hop under a gated module's prefixes belongs to the gated domain —
// otherwise it would silently kill another domain's tool — and if reads are
// GET and writes are not, since the write check keys off the method.
const OUTSIDE_GATED_PREFIXES: Record<string, string[]> = {
  business: ["business_find GET /api/brain/digests", "business_find GET /api/brain/findings"],
  // WARP-2979 — every security hop is under /api/security/assistant/, inside the gated prefix.
  security: [],
};

describe("mcp acting-user gate — which domains it narrows", () => {
  // Pinned by name: the suite below iterates the list, so a domain dropped
  // from it would take its own checks with it and nothing would go red.
  // WARP-2979: `security` — its tools' routes resolve the person too, but the
  // mcp-server's HTTP transport runs only write-tier RBAC (ADR-059 P4 §6.12.2).
  it("narrows exactly business and security", () => {
    expect([...MCP_ACTING_USER_GATED_DOMAINS].sort()).toEqual(["business", "security"]);
  });
});

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

    // The other direction: a ${domain} hop OUTSIDE the gated prefixes is not
    // narrowed by this gate. Each one is named in module-mounts.ts beside
    // MCP_ACTING_USER_GATED_DOMAINS; a new one must be added there first.
    it(`${domain}: its hops outside the gated prefixes are exactly the documented ones`, () => {
      const outside = TOOL_ROUTES.filter((e) => catalog.get(e.tool)?.domain === domain)
        .flatMap((e) => e.hops.map((h) => `${e.tool} ${h.method.toUpperCase()} ${h.pathPattern}`))
        .filter((h) => !under(h.split(" ")[2]!))
        .sort();
      expect(outside).toEqual(OUTSIDE_GATED_PREFIXES[domain]);
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

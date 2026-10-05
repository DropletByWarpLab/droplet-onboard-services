/**
 * WARP-3365 / WARP-3369 (Romain, 2026-09-30) — an external guest (role `guest`)
 * gets NOTHING from the company's customers or work unless it is explicitly
 * shared with them, and the box enforces it on every route. Nothing in the CRM
 * or in Projects is shared per record, so both modules refuse `view` below the
 * family floor (`refuseBelowFloor`): a guest holds no grant, and the tier
 * floor refuses them at the module's prefix.
 *
 * What is pinned here, all through the REAL mount (`mountModuleGates`) and the
 * REAL catalog rather than a hand-rolled replica:
 *
 *   1. Every route the CRM, Projects and Money routers register (found by scanning the
 *      router SOURCE, so a route added tomorrow is covered the day it lands) is
 *      404 `module_disabled` for a guest, reachable for a member, an admin and
 *      an owner, and reachable for the `service` principal (the tool paths).
 *      `projects` is deliberately not in FEATURE_GATED_MODULES, so the tier
 *      floor is the ONLY thing between a guest and /api/pm — this is its test.
 *   2. The floor touches exactly the modules the catalog refuses: a guest still
 *      reaches every other module's prefix (their shared files, Messages, own
 *      chats and the rest), with the guest's real role-less catalog resolving.
 *   3. The CRM's WRITE routes name their §9 level (WARP-3365, second half): a
 *      member whose role holds `crm: view` cannot write, `act` cannot delete
 *      or edit the pipeline, `manage` can.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { ModuleId } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: false } };
});
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

// The route-level `requireFeatureAccess(...)` calls (routes/crm.ts) read the
// boot-bound singleton by default; hand them a controllable resolver.
const h = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../services/effective-access.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/effective-access.service.js")>();
  return { ...actual, resolveEffectiveAccess: (userId: string) => h.resolve(userId) };
});

import { mountModuleGates } from "../modules/module-mounts.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { GUEST_SHARES } from "../modules/guest-shares.js";
import {
  fullCatalogFeatures,
  tierRefusingModuleIds,
  type FeatureLevel,
} from "../services/access-catalog.js";
import { createCrmRouter } from "../routes/crm.js";
import { createCrmEntityLinksRouter } from "../routes/crm-entity-links.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { isRoleGuard, type AuthUser } from "../middleware/auth.js";
import type { EffectiveAccessResult } from "../services/effective-access.service.js";
import { readPackageFile } from "./helpers/test-paths.js";

type Role = "owner" | "admin" | "family" | "guest" | "service";

const PRINCIPAL: Record<Role, AuthUser> = {
  owner: { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" },
  admin: { id: "u-admin", username: "admin", displayName: "Admin", role: "admin" },
  family: { id: "u-member", username: "member", displayName: "Member", role: "family" },
  guest: { id: "u-guest", username: "guest", displayName: "Guest", role: "guest" },
  service: { id: "_service:mcp", username: "_service:mcp", displayName: "mcp", role: "service" },
};

/** Every availability signal satisfied — availability is not what is under test. */
const CFG: AvailabilityConfig = {
  AI_GATEWAY_URL: "http://ai:8000",
  FILE_INDEXER_URL: "http://fi:8090",
  NEXTCLOUD_URL: "http://nc:8080",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docs",
  SERVICE_TOKEN_EMAIL: "tok",
  SERVICE_TOKEN_VOICE: "tok",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter:8083",
  ROUTING_SERVICE_URL: "http://routing:8080",
  SWITCH_SERVICE_URL: "http://switch:8081",
};

/** Every module switched ON box-wide: the workspace toggle is not what is under test. */
const ALL_ON = {
  moduleSetting: {
    findMany: async () => MODULES.map((m) => ({ moduleId: m.id, enabled: true })),
  },
} as never;

function access(tier: Role, features: Array<[ModuleId, FeatureLevel]>): EffectiveAccessResult {
  return {
    tier,
    features: features.map(([moduleId, level]) => ({ moduleId, level })),
    toolDomains: [],
    locks: false,
    cloud: false,
    connectors: {},
    connectorGrants: null,
    usage: {
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      source: "default",
      sources: {
        storageQuotaBytes: "default",
        maxUploadSizeMb: "default",
        llmDailyMessageCap: "default",
      },
    },
    deptRights: [],
    exceptions: [],
  };
}

/** What a person with NO custom role resolves to — the catalog's own answer for their tier. */
function roleLess(tier: Role): EffectiveAccessResult {
  return access(
    tier,
    fullCatalogFeatures(tier).map((f) => [f.moduleId, f.level] as [ModuleId, FeatureLevel]),
  );
}

function withPrincipal(role: Role): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = PRINCIPAL[role];
    next();
  });
  return app;
}

// ── 1. every CRM and Projects route, through the real mount ─────────────────

type Method = "get" | "post" | "put" | "patch" | "delete";
interface RouteRow {
  method: Method;
  path: string;
}

/** The `router.<method>("/path"` registrations in a route file's SOURCE. */
function scanRoutes(...file: string[]): RouteRow[] {
  const source = readPackageFile("src", ...file);
  return [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => ({
    method: m[1] as Method,
    path: m[2],
  }));
}

/** Routers mount at `/api`, except mobile/pm.ts, which spells the whole path. */
const mountedAt = (path: string): string => (path.startsWith("/api/") ? path : `/api${path}`);
const concrete = (path: string): string => mountedAt(path).replace(/:[A-Za-z]+/g, "x");

const SURFACES: ReadonlyArray<{ module: ModuleId; label: string; files: string[][]; atLeast: number }> = [
  {
    module: "crm",
    label: "CRM",
    files: [
      ["routes", "crm.ts"],
      ["routes", "crm-entity-links.ts"],
      ["routes", "crm-filing.ts"],
    ],
    atLeast: 45,
  },
  {
    module: "projects",
    label: "Projects",
    files: [
      ["routes", "pm", "native.ts"],
      ["routes", "pm", "relations.ts"],
      // WARP-3522 — the query API, by-key lookup and saved views.
      ["routes", "pm", "query.ts"],
      ["routes", "pm", "views.ts"],
      ["routes", "mobile", "pm.ts"],
    ],
    atLeast: 30,
  },
  // WARP-3365 review: what the business is owed and owes is the company's own.
  {
    module: "money",
    label: "Money",
    files: [["routes", "money.ts"]],
    atLeast: 2,
  },
  // WARP-3528: a ticket is a customer's own words.
  {
    module: "support",
    label: "Support",
    files: [["routes", "support", "support.routes.ts"]],
    atLeast: 14,
  },
];

/** The real mount, with a stub standing where each real route answers. */
function mountedWithStubs(role: Role, routes: RouteRow[]): Express {
  const app = withPrincipal(role);
  mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => roleLess(role));
  const stub: RequestHandler = (_req, res) => {
    res.json({ hit: true });
  };
  for (const r of routes) {
    (app as unknown as Record<Method, (path: string, h: RequestHandler) => void>)[r.method](
      mountedAt(r.path),
      stub,
    );
  }
  return app;
}

/** Every route as `METHOD path -> status error`, for one principal. */
async function probeAll(app: Express, routes: RouteRow[]): Promise<string[]> {
  const rows: string[] = [];
  for (const r of routes) {
    const res = await request(app)[r.method](concrete(r.path));
    rows.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status} ${res.body?.error ?? ""}`.trim());
  }
  return rows;
}

describe.each(SURFACES)("$label: every route, through the real module mount", (surface) => {
  const routes = surface.files.flatMap((file) => scanRoutes(...file));

  it("scans the real routers (never a pass over an empty list)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(surface.atLeast);
  });

  it("an external guest is refused on EVERY route: 404 module_disabled, and the handler never runs — bar the requests declared as shared", async () => {
    const app = mountedWithStubs("guest", routes);
    const rows = await probeAll(app, routes);
    // WARP-3369: a work item assigned to a guest is shared with them. The six
    // requests in modules/guest-shares.ts (five per record, plus their own list,
    // WARP-3407) get past the prefix floor to the route's own guard (proved in
    // guest-work-item-share.test.ts);
    // nothing else does, for Projects or for any other module.
    const shares = GUEST_SHARES[surface.module] ?? [];
    const isShared = (r: RouteRow): boolean =>
      shares.some((s) => s.method === r.method.toUpperCase() && s.path.test(concrete(r.path).toLowerCase()));
    const unexpected = routes.flatMap((r, i) =>
      rows[i].endsWith(isShared(r) ? "-> 200" : "-> 404 module_disabled") ? [] : [rows[i]],
    );
    expect(unexpected).toEqual([]);
    expect(routes.filter(isShared)).toHaveLength(shares.length);
    const sample = await request(app).get(concrete(routes.find((r) => !isShared(r))!.path));
    expect(sample.body).toEqual({ error: "module_disabled", module: surface.module });
  });

  it.each(["family", "admin", "owner", "service"] as const)(
    "a %s is NOT refused by the floor on any route",
    async (role) => {
      const app = mountedWithStubs(role, routes);
      const rows = await probeAll(app, routes);
      expect(rows.filter((row) => !row.endsWith("-> 200"))).toEqual([]);
    },
  );
});

describe("the floor is exactly the catalog's refusal", () => {
  it("is crm, projects, money and support — the modules a guest holds nothing on", () => {
    expect([...tierRefusingModuleIds()].sort()).toEqual(["crm", "money", "projects", "support"]);
  });

  it("a guest still reaches every OTHER module's prefix (their shared files, Messages, own chats, the rest)", async () => {
    const refused = new Set<ModuleId>(tierRefusingModuleIds());
    const reached: ModuleId[] = [];
    const app = withPrincipal("guest");
    mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => roleLess("guest"));
    const targets: Array<[ModuleId, string]> = [];
    for (const def of MODULES) {
      if (def.core || refused.has(def.id)) continue;
      for (const prefix of def.routePrefixes) targets.push([def.id, `${prefix}/x`]);
    }
    for (const [, path] of targets) {
      app.get(path, (_req, res) => {
        res.json({ hit: true });
      });
    }
    const failures: string[] = [];
    for (const [id, path] of targets) {
      const res = await request(app).get(path);
      if (res.status === 200) reached.push(id);
      else failures.push(`${path} -> ${res.status} ${res.body?.error ?? ""}`.trim());
    }
    expect(failures).toEqual([]);
    // files (shared files) and team_chat (Messages) are among them, not skipped.
    expect(reached).toEqual(expect.arrayContaining(["files", "team_chat", "voice"]));
  });

  it("the tier floor answers by ROLE, so it holds where the per-person gate has nothing to narrow (no local User row)", async () => {
    // `projects` is not feature-gated and a null resolver means "no row, nothing to narrow":
    // only the tier floor can refuse this guest.
    const app = withPrincipal("guest");
    mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => null);
    app.get("/api/pm/projects", (_req, res) => {
      res.json({ hit: true });
    });
    app.get("/api/crm/companies", (_req, res) => {
      res.json({ hit: true });
    });
    expect((await request(app).get("/api/pm/projects")).status).toBe(404);
    expect((await request(app).get("/api/crm/companies")).status).toBe(404);
  });
});

// ── 2. the CRM's writes name their §9 level ─────────────────────────────────

type Handle = (req: unknown, res: unknown, next: () => void) => unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> };
}

const CRM_ROUTES = (() => {
  const stack = (createCrmRouter({} as never) as unknown as { stack: Layer[] }).stack;
  const out: Array<{ key: string; method: string; handles: Handle[] }> = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods).filter((k) => layer.route!.methods[k])) {
      out.push({
        key: `${m.toUpperCase()} ${layer.route.path}`,
        method: m.toUpperCase(),
        handles: layer.route.stack.map((s) => s.handle),
      });
    }
  }
  return out;
})();

/**
 * WARP-3365 — the level each CRM write needs. `manage` is the pipeline and its
 * stages and deleting a customer or a deal; `act` is everything else that
 * writes (a link or an unlink is an association, not a record).
 */
const CRM_WRITE_LEVELS: ReadonlyArray<readonly [string, FeatureLevel]> = [
  ["POST /crm/pipelines", "manage"],
  ["PATCH /crm/pipelines/:id", "manage"],
  ["DELETE /crm/pipelines/:id", "manage"],
  ["POST /crm/pipelines/:id/stages", "manage"],
  ["PATCH /crm/stages/:id", "manage"],
  ["DELETE /crm/stages/:id", "manage"],
  ["POST /crm/companies", "act"],
  ["PATCH /crm/companies/:id", "act"],
  ["DELETE /crm/companies/:id", "manage"],
  ["POST /crm/companies/:id/contacts", "act"],
  ["DELETE /crm/companies/:id/contacts/:contactId", "act"],
  ["POST /crm/deals", "act"],
  ["PATCH /crm/deals/:id", "act"],
  ["POST /crm/deals/:id/stage", "act"],
  ["DELETE /crm/deals/:id", "manage"],
  ["POST /crm/deals/:id/contacts", "act"],
  ["DELETE /crm/deals/:id/contacts/:contactId", "act"],
  ["POST /crm/activities", "act"],
  ["POST /crm/party-links", "act"],
  ["PATCH /crm/party-links/:id/archive", "act"],
];

describe("CRM writes name their §9 level (WARP-3365)", () => {
  const writes = CRM_ROUTES.filter((r) => r.method !== "GET");

  it("the write routes are exactly the table — a new write must name its level here", () => {
    expect(writes.map((r) => r.key).sort()).toEqual(CRM_WRITE_LEVELS.map(([key]) => key).sort());
    expect(writes).toHaveLength(20);
  });

  it.each(CRM_WRITE_LEVELS)("%s carries exactly one crm gate, at %s, after the role guard", (key, level) => {
    const route = CRM_ROUTES.find((r) => r.key === key)!;
    const metas = route.handles.map(readFeatureGateMeta).filter((m) => m !== null);
    expect(metas, key).toEqual([{ moduleId: "crm", level }]);
    const guard = route.handles.findIndex(isRoleGuard);
    const gate = route.handles.findIndex((fn) => readFeatureGateMeta(fn) !== null);
    expect(guard, key).toBeGreaterThanOrEqual(0);
    expect(gate, key).toBeGreaterThan(guard);
  });

  it("no CRM read carries a gate above view (the prefix gate is the read gate)", () => {
    for (const r of CRM_ROUTES.filter((x) => x.method === "GET")) {
      const levels = r.handles.map(readFeatureGateMeta).filter((m) => m !== null).map((m) => m!.level);
      expect(levels, r.key).toEqual([]);
    }
  });
});

describe("CRM writes: what a member's role actually holds decides (WARP-3365)", () => {
  beforeEach(() => {
    h.resolve.mockReset();
  });

  function crmApp(role: Role): Express {
    const app = withPrincipal(role);
    // `{}` for prisma: a request that clears the gates and reaches the handler
    // fails inside it (400 or 500) — anything but the gate's own refusal.
    app.use("/api", createCrmRouter({} as never));
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: "handler_error" });
    });
    return app;
  }

  const refusedByGate = (res: { status: number; body: { error?: string; module?: string } }): boolean =>
    res.status === 404 && res.body.error === "module_disabled" && res.body.module === "crm";

  const asRole = (tier: Role, level: FeatureLevel | null): void => {
    h.resolve.mockResolvedValue(access(tier, level === null ? [] : [["crm", level]]));
  };

  it("crm: view can read but cannot create, edit, move or delete anything", async () => {
    asRole("family", "view");
    const app = crmApp("family");
    for (const [method, path] of [
      ["post", "/api/crm/companies"],
      ["patch", "/api/crm/companies/x"],
      ["delete", "/api/crm/companies/x"],
      ["post", "/api/crm/deals"],
      ["post", "/api/crm/deals/x/stage"],
      ["post", "/api/crm/activities"],
      ["post", "/api/crm/pipelines"],
      ["delete", "/api/crm/stages/x"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(refusedByGate(res), `${method} ${path} -> ${res.status}`).toBe(true);
    }
  });

  it("crm: act logs a call and moves a deal, but cannot delete a record or edit the pipeline", async () => {
    asRole("family", "act");
    const app = crmApp("family");
    for (const [method, path] of [
      ["post", "/api/crm/companies"],
      ["patch", "/api/crm/deals/x"],
      ["post", "/api/crm/deals/x/stage"],
      ["post", "/api/crm/activities"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(refusedByGate(res), `${method} ${path} -> ${res.status}`).toBe(false);
    }
    for (const [method, path] of [
      ["delete", "/api/crm/companies/x"],
      ["delete", "/api/crm/deals/x"],
      ["post", "/api/crm/pipelines"],
      ["patch", "/api/crm/pipelines/x"],
      ["post", "/api/crm/pipelines/x/stages"],
      ["delete", "/api/crm/stages/x"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(refusedByGate(res), `${method} ${path} -> ${res.status}`).toBe(true);
    }
  });

  it("crm: manage may do all of it", async () => {
    asRole("family", "manage");
    const app = crmApp("family");
    for (const [method, path] of [
      ["delete", "/api/crm/companies/x"],
      ["delete", "/api/crm/deals/x"],
      ["post", "/api/crm/pipelines"],
      ["delete", "/api/crm/stages/x"],
      ["post", "/api/crm/companies"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(refusedByGate(res), `${method} ${path} -> ${res.status}`).toBe(false);
    }
  });

  it("a person with no custom role (the full member catalog) is unchanged: manage", async () => {
    h.resolve.mockResolvedValue(roleLess("family"));
    const app = crmApp("family");
    const res = await request(app).delete("/api/crm/companies/x");
    expect(refusedByGate(res), `${res.status}`).toBe(false);
  });

  it("a principal with no local User row has nothing to narrow, and the role floor still runs", async () => {
    h.resolve.mockResolvedValue(null);
    const app = crmApp("family");
    expect(refusedByGate(await request(app).post("/api/crm/companies").send({}))).toBe(false);
    // the guest never gets past the ROLE floor on a write, whatever the resolver says
    h.resolve.mockResolvedValue(roleLess("owner"));
    const guest = await request(crmApp("guest")).post("/api/crm/companies").send({});
    expect(guest.status).toBe(403);
  });

  it("the assistant's service principal passes the level gate on the routes the crm_* tools use", async () => {
    asRole("family", "view"); // whatever a resolver would say about a person, a service is not one
    const app = crmApp("service");
    for (const [method, path] of [
      ["post", "/api/crm/companies"],
      ["patch", "/api/crm/companies/x"],
      ["post", "/api/crm/deals"],
      ["post", "/api/crm/deals/x/stage"],
      ["post", "/api/crm/activities"],
    ] as const) {
      const res = await request(app)[method](path).send({});
      expect(refusedByGate(res), `${method} ${path} -> ${res.status}`).toBe(false);
      expect(res.status, `${method} ${path}`).not.toBe(403);
    }
  });

  it("through the real mount too: a guest is refused a CRM write before any level is asked", async () => {
    h.resolve.mockResolvedValue(roleLess("guest"));
    const app = withPrincipal("guest");
    mountModuleGates(app, createModuleGate(ALL_ON, CFG, 0), async () => roleLess("guest"));
    app.use("/api", createCrmRouter({} as never));
    const res = await request(app).post("/api/crm/companies").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "crm" });
    expect(h.resolve).not.toHaveBeenCalled();
  });
});

// ── 3. the entity-link writes name their level too (WARP-3365 review) ───────

describe("CRM entity-link writes name their §9 level (WARP-3365 review)", () => {
  const LINK_LEVELS: ReadonlyArray<readonly [string, FeatureLevel, "post" | "patch" | "delete", string]> = [
    ["POST /crm/entity-links", "act", "post", "/api/crm/entity-links"],
    ["PATCH /crm/entity-links/:id", "act", "patch", "/api/crm/entity-links/x"],
    ["DELETE /crm/entity-links/:id", "manage", "delete", "/api/crm/entity-links/x"],
  ];

  const stack = (createCrmEntityLinksRouter({} as never) as unknown as { stack: Layer[] }).stack;
  const routes = stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => layer.route!.methods[m])
          .map((m) => ({ key: `${m.toUpperCase()} ${layer.route!.path}`, method: m.toUpperCase(), handles: layer.route!.stack.map((x) => x.handle) }))
      : [],
  );

  it("the writes are exactly the table, each with one crm gate at its level after the role guard; the reads carry none", () => {
    expect(routes.filter((r) => r.method !== "GET").map((r) => r.key).sort()).toEqual(
      LINK_LEVELS.map(([key]) => key).sort(),
    );
    for (const [key, level] of LINK_LEVELS) {
      const route = routes.find((r) => r.key === key)!;
      expect(route.handles.map(readFeatureGateMeta).filter((m) => m !== null), key).toEqual([{ moduleId: "crm", level }]);
      expect(route.handles.findIndex((h) => readFeatureGateMeta(h) !== null), key).toBeGreaterThan(
        route.handles.findIndex(isRoleGuard),
      );
    }
    for (const r of routes.filter((x) => x.method === "GET")) {
      expect(r.handles.map(readFeatureGateMeta).filter((m) => m !== null), r.key).toEqual([]);
    }
  });

  it("crm: view cannot link, relink or unlink a file; act cannot delete a link; manage can", async () => {
    const app = withPrincipal("family");
    app.use("/api", createCrmEntityLinksRouter({} as never));
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: "handler_error" });
    });
    const refused = (res: { status: number; body: { error?: string; module?: string } }) =>
      res.status === 404 && res.body.error === "module_disabled" && res.body.module === "crm";
    for (const [held, expected] of [
      ["view", { act: true, manage: true }],
      ["act", { act: false, manage: true }],
      ["manage", { act: false, manage: false }],
    ] as const) {
      h.resolve.mockReset().mockResolvedValue(access("family", [["crm", held]]));
      for (const [key, level, method, url] of LINK_LEVELS) {
        const res = await request(app)[method](url).send({});
        expect(refused(res), `${held} ${key} -> ${res.status}`).toBe(expected[level as "act" | "manage"]);
      }
    }
  });
});

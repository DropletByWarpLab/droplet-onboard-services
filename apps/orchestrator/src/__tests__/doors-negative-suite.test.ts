// add-llm-tool:not-a-gate — reads the registry to pin ADR-055 §11.5 (no doors_*
// tool writes), not to gate adding a tool: it edits nothing an agent adds a tool
// through, and its imports are not add-a-tool sites.
/**
 * ADR-055 (P4a) — the §14 cross-cutting NEGATIVE SUITE, the items that can
 * fail a build today:
 *
 *   1. no `doors_*` tool can unlock or write (P4a ships none; the guard is forward);
 *   2. no `/api/doors` route lacks the RBAC grant;
 *   3. no in-place AccessEvent UPDATE or DELETE — here, as source (the trigger
 *      itself is proved on real Postgres in doors.pg.test.ts);
 *   4. no forced-door or held-open claim on a door whose doorPositionSource is
 *      `none` — the pure rule is door-derivations.test.ts and the database's
 *      is doors.pg.test.ts; here, that no surface advertises one;
 *   5. the module is ABSENT when DOORS_ENABLED is off.
 *
 * Deferred (each needs something this slice does not build — see ADR-055): a
 * UID accepted as a credential (no credential model, AC-017); a fail-safe
 * device commissioned on cells (no AccessDevice); a lock that stops opening
 * from the inside under any software state (a mechanical property); an
 * outside-lever turn registering as request-to-exit (device firmware).
 *
 * These read the REAL router stack, the REAL registry and the REAL gates —
 * not restatements of them — so a new route, a new tool or a moved list fails
 * here instead of passing over a name list.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ModuleId, PrismaClient } from "@prisma/client";
import { TOOLS, TOOL_CATALOG, TOOL_ROUTES } from "@droplet/tools-core";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import { createDoorsRouter } from "../routes/doors.js";
import { FEATURE_GATED_MODULES, mountModuleGates } from "../modules/module-mounts.js";
import { MODULE_BY_ID, MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { isRoleGuard } from "../middleware/auth.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { computeEffectiveIds, computeModuleStates, setModuleEnabled, ModuleToggleError } from "../services/modules.service.js";
import { WRITE_TOOLS, VOICE_WRITE_TOOLS } from "../services/tool-access.service.js";
import { alarmClaimsFor } from "../services/door-derivations.js";

// ── the router, walked ────────────────────────────────────────────────────

type Handle = (req: unknown, res: unknown, next: () => void) => unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> };
}
interface RouteInfo {
  method: string;
  path: string;
  key: string;
  handles: Handle[];
}

const DOOR_ID = "6f0d5d4e-2b1c-4f7a-9d6e-0a1b2c3d4e5f";
const ROUTER = createDoorsRouter({} as PrismaClient);

const ROUTES: RouteInfo[] = ((ROUTER as unknown as { stack: Layer[] }).stack).flatMap((layer) => {
  if (!layer.route) throw new Error("a non-route layer (router.use) in the doors router: it would bypass the per-route pins");
  return Object.keys(layer.route.methods)
    .filter((m) => layer.route!.methods[m])
    .map((m) => ({
      method: m.toUpperCase(),
      path: layer.route!.path,
      key: `${m.toUpperCase()} ${layer.route!.path}`,
      handles: layer.route!.stack.map((s) => s.handle),
    }));
});
const READS = ROUTES.filter((r) => r.method === "GET");
const WRITES = ROUTES.filter((r) => r.method !== "GET");

const PRINCIPALS: ReadonlyArray<readonly [label: string, user: { id: string; role: string } | undefined]> = [
  ["owner", { id: "u-owner", role: "owner" }],
  ["admin", { id: "u-admin", role: "admin" }],
  ["family", { id: "u-family", role: "family" }],
  ["guest", { id: "u-guest", role: "guest" }],
  ["service:mcp", { id: "_service:mcp", role: "service" }],
  ["service:voice", { id: "_service:voice", role: "service" }],
  ["no role", { id: "u-norole", role: "" }],
  ["no user", undefined],
];

function admitted(guard: Handle): string[] {
  const out: string[] = [];
  for (const [label, user] of PRINCIPALS) {
    let passed = false;
    const res = { status: () => res, json: () => res };
    guard({ user, method: "GET", path: "/probe", headers: {} }, res, () => {
      passed = true;
    });
    if (passed) out.push(label);
  }
  return out;
}

// ── 1. no doors_* tool can unlock or write ────────────────────────────────

describe("negative 1 — no doors_* tool can unlock or write (§11.5)", () => {
  // P4a ships NO doors_* tool (the two reads arrive in P4b, when the module goes
  // live), so these pass over an empty set today. They fail the day a tool in
  // the namespace writes, or a tool route reaches /api/doors with anything but
  // a GET. packages/tools-core/__tests__/doors-read-only.test.ts proves the
  // same rule rejects a synthetic writing tool, so an empty pass is not vacuous.
  const doorsNames = [...TOOLS.keys()].filter((n) => n.startsWith("doors_")).sort();

  it("none is a write tool, in the registry, the catalog or the derived WRITE_TOOLS set the RBAC tiers read", () => {
    for (const name of doorsNames) {
      expect(TOOLS.get(name)!.requiresWrite, name).toBe(false);
      expect(TOOLS.get(name)!.requiresConfirmation, name).toBe(false);
      expect(WRITE_TOOLS.has(name), name).toBe(false);
      expect(VOICE_WRITE_TOOLS.has(name), name).toBe(false);
    }
    for (const entry of TOOL_CATALOG.filter((e) => e.name.startsWith("doors_"))) {
      expect(entry.requiresWrite, entry.name).toBe(false);
    }
  });

  it("every route hop any tool makes to /api/doors is a GET, and to a GET route that exists", () => {
    const hops = TOOL_ROUTES.flatMap((e) => e.hops.map((h) => ({ tool: e.tool, ...h }))).filter((h) => h.pathPattern.startsWith("/api/doors"));
    for (const hop of hops) {
      expect(hop.method, `${hop.tool} ${hop.pathPattern}`).toBe("get");
      expect(READS.map((r) => `/api${r.path}`), hop.tool).toContain(hop.pathPattern);
    }
  });
});

// ── 2. no /api/doors route lacks the RBAC grant ───────────────────────────

describe("negative 2 — no /api/doors route lacks the RBAC grant", () => {
  it("the router is exactly the five documented routes (never a pass over an empty stub)", () => {
    expect(ROUTES.map((r) => r.key)).toEqual([
      "GET /doors",
      "GET /doors/events",
      "POST /doors",
      "PATCH /doors/:id",
      "POST /doors/:id/retire",
    ]);
    expect(READS).toHaveLength(2);
    expect(WRITES).toHaveLength(3);
  });

  it.each(ROUTES.map((r) => [r.key, r] as const))("%s has exactly one role guard of its own", (_key, route) => {
    expect(route.handles.filter(isRoleGuard), route.key).toHaveLength(1);
  });

  it.each(READS.map((r) => [r.key, r] as const))("%s admits owner and admin — nobody else, and no service principal", (_key, route) => {
    expect(admitted(route.handles.find(isRoleGuard)!), route.key).toEqual(["owner", "admin"]);
  });

  it.each(WRITES.map((r) => [r.key, r] as const))(
    "%s admits the OWNER ALONE — not admin (§11.4), and never a service principal (§11.5)",
    (_key, route) => {
      expect(admitted(route.handles.find(isRoleGuard)!), route.key).toEqual(["owner"]);
    },
  );

  it.each(WRITES.map((r) => [r.key, r] as const))("%s runs sensitiveRateLimit first, then the role guard", (_key, route) => {
    expect(route.handles[0], route.key).toBe(sensitiveRateLimit);
    expect(isRoleGuard(route.handles[1]), route.key).toBe(true);
  });

  it("no router-level gate is used, and no route admits the MCP service principal (source)", () => {
    const code = readFileSync(resolve(__dirname, "../routes/doors.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // P4a has no doors tool, so nothing has a reason to reach these routes as the
    // assistant. The reads join the MCP path in P4b, with their own gate.
    expect(code).not.toMatch(/requireRoleOrMcpService/);
    expect(code).not.toMatch(/router\.use\(/);
  });

  it("the module carries a per-person grant: feature-gated and in the access catalog", () => {
    expect(FEATURE_GATED_MODULES.has("doors")).toBe(true);
  });

  // The composition, driven for real: every route, through the real gates.
  const CFG_ON = { DOORS_ENABLED: true } as AvailabilityConfig;
  const CFG_OFF = { DOORS_ENABLED: false } as AvailabilityConfig;

  function features(has: Array<{ moduleId: string; level: string }>) {
    return (async () => ({ tier: "admin", features: has, toolDomains: [], locks: false })) as never;
  }

  function buildApp(opts: {
    cfg: AvailabilityConfig;
    toggle?: boolean | "none";
    grants: Array<{ moduleId: string; level: string }>;
    user: { id: string; role: string; username?: string };
  }) {
    const prisma = {
      moduleSetting: {
        findMany: async () =>
          opts.toggle === "none" || opts.toggle === undefined ? [] : [{ moduleId: "doors" as ModuleId, enabled: opts.toggle }],
      },
      accessPoint: { findMany: async () => [], findUnique: async () => null, create: async () => ({}), updateMany: async () => ({ count: 0 }) },
      accessEvent: { findMany: async () => [] },
      $queryRaw: async () => [],
    } as unknown as PrismaClient;
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: unknown }).user = { username: opts.user.id, displayName: opts.user.id, ...opts.user } as never;
      next();
    });
    const resolve = features(opts.grants);
    mountModuleGates(app, createModuleGate(prisma, opts.cfg, 0), resolve);
    app.use("/api", createDoorsRouter(prisma));
    return app;
  }

  const concrete = (r: RouteInfo) => `/api${r.path.replace(":id", DOOR_ID)}`;
  const call = (app: express.Express, r: RouteInfo) => {
    const agent = request(app);
    const url = concrete(r);
    const body = r.method === "POST" && r.path === "/doors" ? { name: "X", doorPositionSource: "lock" } : r.method === "PATCH" ? { name: "X" } : {};
    switch (r.method) {
      case "GET":
        return agent.get(url);
      case "POST":
        return agent.post(url).send(body);
      default:
        return agent.patch(url).send(body);
    }
  };

  it.each(ROUTES.map((r) => [r.key, r] as const))(
    "%s: a person whose role has no `doors` grant gets 404 module_disabled — the surface reads as absent, not forbidden",
    async (_key, route) => {
      const app = buildApp({
        cfg: CFG_ON,
        toggle: true,
        grants: [{ moduleId: "files", level: "manage" }],
        user: { id: "u-owner", role: "owner" },
      });
      const res = await call(app, route);
      expect(res.status, route.key).toBe(404);
      expect(res.body).toEqual({ error: "module_disabled", module: "doors" });
    },
  );

  it.each(ROUTES.map((r) => [r.key, r] as const))(
    "%s: an EMPTIED grant set denies — it never reads as 'no restrictions configured' (§11.4)",
    async (_key, route) => {
      const app = buildApp({ cfg: CFG_ON, toggle: true, grants: [], user: { id: "u-owner", role: "owner" } });
      const res = await call(app, route);
      expect(res.status, route.key).toBe(404);
    },
  );

  it.each(ROUTES.map((r) => [r.key, r] as const))(
    "%s: the MCP service principal is refused (403) even with the module on and the grant held — the assistant has no doors surface in P4a",
    async (_key, route) => {
      const app = buildApp({
        cfg: CFG_ON,
        toggle: true,
        grants: [{ moduleId: "doors", level: "view" }],
        user: { id: "_service:mcp", role: "service" },
      });
      const res = await call(app, route);
      expect(res.status, route.key).toBe(403);
    },
  );

  it("with the grant held, an admin reads but the door-changing routes still refuse them (403, not 404: the module is theirs, the authority is not)", async () => {
    const app = buildApp({
      cfg: CFG_ON,
      toggle: true,
      grants: [{ moduleId: "doors", level: "view" }],
      user: { id: "u-admin", role: "admin" },
    });
    for (const r of READS) expect((await call(app, r)).status, r.key).toBe(200);
    for (const r of WRITES) expect((await call(app, r)).status, r.key).toBe(403);
  });
});

// ── 3. no in-place AccessEvent UPDATE or DELETE ───────────────────────────

/** Every non-test .ts file under `dir`, as [repo-relative path, source with comments stripped]. */
function sourcesUnder(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        const code = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        out.push([relative(REPO, full), code]);
      }
    }
  };
  walk(dir);
  return out;
}

const REPO = resolve(__dirname, "../../../..");
const PRODUCTION = [
  ...sourcesUnder(resolve(REPO, "apps/orchestrator/src")),
  ...sourcesUnder(resolve(REPO, "packages/tools-core/src")),
  ...sourcesUnder(resolve(REPO, "services/mcp-server/src")),
];
const PURGE_FILE = "apps/orchestrator/src/services/doors.service.ts";

describe("negative 3 — no in-place AccessEvent UPDATE or DELETE (source; the trigger itself is doors.pg.test.ts)", () => {
  it("scans real production source (not vacuous)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(300);
    expect(PRODUCTION.map(([f]) => f)).toContain(PURGE_FILE);
  });

  it("no code calls a Prisma update/upsert/delete on accessEvent", () => {
    const offenders = PRODUCTION.filter(([, code]) => /\baccessEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(code)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('no raw SQL updates AccessEvent, and the ONE raw DELETE is the retention purge', () => {
    const updaters = PRODUCTION.filter(([, code]) => /UPDATE\s+"AccessEvent"/i.test(code)).map(([f]) => f);
    expect(updaters).toEqual([]);
    const deleters = PRODUCTION.filter(([, code]) => /DELETE\s+FROM\s+"AccessEvent"/i.test(code)).map(([f]) => f);
    expect(deleters).toEqual([PURGE_FILE]);
  });

  it("only the purge names the transaction-local gate the trigger looks for", () => {
    const namers = PRODUCTION.filter(([, code]) => code.includes("droplet.access_event_retention")).map(([f]) => f);
    expect(namers).toEqual([PURGE_FILE]);
  });

  it("nothing turns the triggers off: no DISABLE TRIGGER, no session_replication_role, no DROP TRIGGER on AccessEvent", () => {
    const off = PRODUCTION.filter(([, code]) => /DISABLE\s+TRIGGER|session_replication_role|DROP\s+TRIGGER[^;]*AccessEvent/i.test(code)).map(([f]) => f);
    expect(off).toEqual([]);
  });

  it("no migration other than the one that creates them drops or disables the AccessEvent triggers", () => {
    const dir = resolve(REPO, "apps/orchestrator/prisma/migrations");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "migration.sql");
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, "utf8");
      if (/AccessEvent_append_only|AccessEvent_derived_guard|access_event_append_only|access_event_derived_guard/.test(sql) && !name.endsWith("_adr_055_doors_tables")) {
        offenders.push(name);
      }
      if (/(DISABLE|DROP)\s+TRIGGER[^;]*AccessEvent/i.test(sql.replace(/DROP TRIGGER IF EXISTS "AccessEvent_(append_only|derived_guard)" ON "AccessEvent";/g, "")) ) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the only route on events is the list", () => {
    expect(ROUTES.filter((r) => r.path.includes("events")).map((r) => r.key)).toEqual(["GET /doors/events"]);
  });
});

// ── 4. no forced-door claim without a position source ─────────────────────

describe("negative 4 — no forced-door or held-open claim for a door with no position source", () => {
  it("what a `none` door is allowed to advertise is nothing", () => {
    expect(alarmClaimsFor("none")).toEqual({ forcedDoor: null, heldOpen: false });
  });
});

// ── 5. the module is absent when DOORS_ENABLED is off ─────────────────────

describe("negative 5 — the module is ABSENT when DOORS_ENABLED is off", () => {
  const MINIMAL = { DOORS_ENABLED: false } as AvailabilityConfig;
  const REGISTRY_CFG = (flag: boolean): AvailabilityConfig =>
    ({
      AI_GATEWAY_URL: "http://ai:8000",
      FILE_INDEXER_URL: "http://fi",
      NEXTCLOUD_URL: "http://nc",
      DOCS_ENABLED: true,
      DOCS_INTERNAL_URL: "http://docs",
      SERVICE_TOKEN_EMAIL: "t",
      SERVICE_TOKEN_VOICE: "t",
      FRIGATE_URL: "http://frigate",
      DROPLET_MATTER_SERVICE_URL: "http://matter",
      ROUTING_SERVICE_URL: "http://routing",
      SWITCH_SERVICE_URL: "http://switch",
      DOORS_ENABLED: flag,
    }) as AvailabilityConfig;

  it("reads as unavailable and not effective — even when an operator has stored `enabled: true` for it", () => {
    const overrides = new Map<ModuleId, boolean>([["doors" as ModuleId, true]]);
    const state = computeModuleStates(overrides, REGISTRY_CFG(false)).find((m) => m.id === ("doors" as ModuleId))!;
    expect(state).toMatchObject({ available: false, enabled: true, effective: false });
    expect(computeEffectiveIds(overrides, REGISTRY_CFG(false)).has("doors" as ModuleId)).toBe(false);
  });

  it("cannot be switched on in Settings: 409 module_unavailable", async () => {
    const prisma = { moduleSetting: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue([]) } } as never;
    await expect(setModuleEnabled(prisma, REGISTRY_CFG(false), "doors" as ModuleId, true, "owner")).rejects.toMatchObject({
      status: 409,
      code: "module_unavailable",
    });
    expect((prisma as { moduleSetting: { upsert: ReturnType<typeof vi.fn> } }).moduleSetting.upsert).not.toHaveBeenCalled();
    expect(ModuleToggleError).toBeDefined();
  });

  it("is off by default even with the flag on: the operator toggle is a second switch", () => {
    const state = computeModuleStates(new Map(), REGISTRY_CFG(true)).find((m) => m.id === ("doors" as ModuleId))!;
    expect(state).toMatchObject({ available: true, enabled: false, effective: false });
  });

  it.each(ROUTES.map((r) => [r.key, r] as const))("%s: 404 module_disabled for EVERYONE, the owner included, when the flag is off", async (_key, route) => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: unknown }).user = { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" };
      next();
    });
    // The operator HAS stored `enabled: true` — the flag still wins.
    const prisma = { moduleSetting: { findMany: async () => [{ moduleId: "doors", enabled: true }] } } as never;
    const resolve = (async () => ({ tier: "owner", features: MODULES.map((m) => ({ moduleId: m.id, level: "manage" })), toolDomains: [], locks: false })) as never;
    mountModuleGates(app, createModuleGate(prisma, MINIMAL, 0), resolve);
    app.use("/api", createDoorsRouter({} as PrismaClient));
    const url = `/api${route.path.replace(":id", DOOR_ID)}`;
    const agent = request(app);
    const res =
      route.method === "GET" ? await agent.get(url) : route.method === "POST" ? await agent.post(url).send({}) : await agent.patch(url).send({});
    expect(res.status, route.key).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "doors" });
  });

  it("the registry's own `available` is the only thing that reads the flag (no second derivation)", () => {
    const doors = MODULE_BY_ID.get("doors" as ModuleId)!;
    expect(doors.available(REGISTRY_CFG(false))).toBe(false);
    expect(doors.available(REGISTRY_CFG(true))).toBe(true);
  });
});

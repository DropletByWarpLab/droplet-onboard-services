// add-llm-tool:not-a-gate — reads the registry to pin ADR-055 §11.5 (no doors_*
// tool writes), not to gate adding a tool: it edits nothing an agent adds a tool
// through, and its imports are not add-a-tool sites.
/**
 * ADR-055 (P4a) — the §14 cross-cutting NEGATIVE SUITE, the items that can
 * fail a build today:
 *
 *   1. no `doors_*` tool can unlock or write (the two real reads, and the dispatch guard);
 *   2. no `/api/doors` route lacks the RBAC grant;
 *   3. no in-place AccessEvent UPDATE or DELETE — here, as source, and that no
 *      .ts file names the retention setting (the trigger itself is proved on
 *      real Postgres in doors.pg.test.ts);
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
import { TOOLS, TOOL_CATALOG, TOOL_ROUTES, isToolWithheldByModule } from "@droplet/tools-core";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import { createDoorsRouter } from "../routes/doors.js";
import { FEATURE_GATED_MODULES, MCP_ACTING_USER_GATED_DOMAINS, mountMcpActingUserGates, mountModuleGates } from "../modules/module-mounts.js";
import { MODULE_BY_ID, MODULES, type AvailabilityConfig } from "../modules/module-registry.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { isRoleGuard } from "../middleware/auth.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import { computeEffectiveIds, computeModuleStates, setModuleEnabled, ModuleToggleError } from "../services/modules.service.js";
import { WRITE_TOOLS, VOICE_WRITE_TOOLS } from "../services/tool-access.service.js";
import { withheldDomainsFor } from "../services/tool-module-verdict.service.js";
import { EXCLUDED_FROM_CHAT_TOOLS } from "../services/chat-tool-scope.js";
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
  const doorsNames = [...TOOLS.keys()].filter((n) => n.startsWith("doors_")).sort();

  it("the doors tools are exactly the two reads (not vacuous)", () => {
    expect(doorsNames).toEqual(["doors_list", "doors_recent_events"]);
  });

  it("none is a write tool, in the registry, the catalog or the derived WRITE_TOOLS set the RBAC tiers read", () => {
    for (const name of doorsNames) {
      expect(TOOLS.get(name)!.requiresWrite, name).toBe(false);
      expect(TOOLS.get(name)!.requiresConfirmation, name).toBe(false);
      expect(WRITE_TOOLS.has(name), name).toBe(false);
      expect(VOICE_WRITE_TOOLS.has(name), name).toBe(false);
    }
    for (const entry of TOOL_CATALOG.filter((e) => e.domain === "doors")) {
      expect(entry.requiresWrite, entry.name).toBe(false);
    }
  });

  it("every route hop a doors tool makes is a GET, and to a GET route that exists", () => {
    for (const name of doorsNames) {
      const entry = TOOL_ROUTES.find((e) => e.tool === name)!;
      expect(entry.hops.length, name).toBeGreaterThan(0);
      for (const hop of entry.hops) {
        expect(hop.method, `${name} ${hop.pathPattern}`).toBe("get");
        expect(READS.map((r) => `/api${r.path}`), name).toContain(hop.pathPattern);
      }
    }
  });

  it("the doors tools are the only tools in the doors domain, and are NOT excluded from chat: the module gate keeps them off a box without doors (WARP-2972)", () => {
    expect(TOOL_CATALOG.filter((e) => e.domain === "doors").map((e) => e.name).sort()).toEqual(doorsNames);
    // The old workaround (an EXCLUDED_FROM_CHAT_TOOLS line "until WARP-2972") is
    // gone; the domain is claimed by the `doors` module instead, so a module off
    // withholds both tools from the chat pool, /api/llm/tools and MCP.
    for (const name of doorsNames) expect(EXCLUDED_FROM_CHAT_TOOLS.has(name), name).toBe(false);
    expect(MODULE_BY_ID.get("doors" as never)!.toolDomains).toEqual(["doors"]);
  });

  it("the dispatch guard is not the deny tier: it lives in the interceptor itself (proved in tools-core and mcp-server)", () => {
    const src = readFileSync(resolve(__dirname, "../../../../packages/tools-core/src/interceptor.ts"), "utf8");
    // The namespace check runs inside `intercept`, before the deny tier is consulted.
    const intercept = src.slice(src.indexOf("intercept(tool, args, meta, now = Date.now())"));
    expect(intercept.indexOf("readOnlyNamespaceBreach(tool)")).toBeGreaterThan(-1);
    expect(intercept.indexOf("readOnlyNamespaceBreach(tool)")).toBeLessThan(intercept.indexOf("denyTier.evaluate"));
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

  it.each(READS.map((r) => [r.key, r] as const))("%s admits owner, admin and the MCP service principal — nobody else", (_key, route) => {
    expect(admitted(route.handles.find(isRoleGuard)!), route.key).toEqual(["owner", "admin", "service:mcp"]);
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

  it("no router-level gate is used, and no route is `requireRoleOrMcpService` on a write (source)", () => {
    const code = readFileSync(resolve(__dirname, "../routes/doors.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The one MCP-admitting guard is bound to `read` and used only by the two GETs.
    expect(code.match(/requireRoleOrMcpService\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/const read = requireRoleOrMcpService\(/);
    expect(code).not.toMatch(/router\.(post|patch|put|delete)\([^)]*\bread\b/);
    expect(code).not.toMatch(/router\.use\(/);
  });

  it("the module carries a per-person grant: feature-gated, in the access catalog, and acting-user gated for the MCP path", () => {
    expect(FEATURE_GATED_MODULES.has("doors")).toBe(true);
    expect(MCP_ACTING_USER_GATED_DOMAINS).toContain("doors");
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
    acting?: { domains: string[] } | null;
    actingTier?: string;
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
    mountMcpActingUserGates(
      app,
      (async () => ({
        scope: opts.acting === null || opts.acting === undefined ? null : { domains: new Set(opts.acting.domains), writeDomains: new Set(), locks: false },
        tier: opts.actingTier ?? "admin",
        unresolved: null,
        userId: "u-1",
      })) as never,
      resolve,
    );
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

  it.each(READS.map((r) => [r.key, r] as const))(
    "%s: the MCP principal acting for a person without the doors domain gets 404; with it, the read goes through",
    async (_key, route) => {
      const denied = buildApp({
        cfg: CFG_ON,
        toggle: true,
        grants: [{ moduleId: "doors", level: "view" }],
        user: { id: "_service:mcp", role: "service" },
        acting: { domains: ["files"] },
      });
      const deniedRes = await request(denied).get(concrete(route)).set("X-Nextcloud-User", "sam");
      expect(deniedRes.status).toBe(404);

      const allowed = buildApp({
        cfg: CFG_ON,
        toggle: true,
        grants: [{ moduleId: "doors", level: "view" }],
        user: { id: "_service:mcp", role: "service" },
        acting: { domains: ["doors"] },
      });
      const okRes = await request(allowed).get(concrete(route)).set("X-Nextcloud-User", "sam");
      expect(okRes.status).toBe(200);
    },
  );

  it("the MCP principal acting for a STAFF person (family tier) is refused even holding the doors grant and domain — the assistant never reads what the browser would 403", async () => {
    const staff = buildApp({
      cfg: CFG_ON,
      toggle: true,
      grants: [{ moduleId: "doors", level: "view" }],
      user: { id: "_service:mcp", role: "service" },
      acting: { domains: ["doors"] },
      actingTier: "family",
    });
    for (const r of READS) {
      const res = await request(staff).get(concrete(r)).set("X-Nextcloud-User", "sam");
      expect(res.status, r.key).toBe(404);
    }
  });

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

/** Every .ts / .tsx file in the repo's three code roots, as [repo-relative path, raw text]. Tests and comments included. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".git", "coverage", "__pycache__", "venv", ".venv"]);
function allTsUnder(dir: string, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) allTsUnder(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push([relative(REPO, full), readFileSync(full, "utf8")]);
  }
  return out;
}
const ALL_TS = ["apps", "packages", "services"].flatMap((root) => allTsUnder(resolve(REPO, root)));

describe("negative 3 — no in-place AccessEvent UPDATE or DELETE (source; the trigger itself is doors.pg.test.ts)", () => {
  it("scans real production source (not vacuous)", () => {
    expect(PRODUCTION.length).toBeGreaterThan(300);
    expect(PRODUCTION.map(([f]) => f)).toContain(PURGE_FILE);
  });

  it("no code calls a Prisma update/upsert/delete on accessEvent", () => {
    const offenders = PRODUCTION.filter(([, code]) => /\baccessEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(code)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("no raw SQL updates or deletes AccessEvent: the retention purge is a database function, and only the doors service calls it", () => {
    const updaters = PRODUCTION.filter(([, code]) => /UPDATE\s+"AccessEvent"/i.test(code)).map(([f]) => f);
    expect(updaters).toEqual([]);
    const deleters = PRODUCTION.filter(([, code]) => /DELETE\s+FROM\s+"AccessEvent"/i.test(code)).map(([f]) => f);
    expect(deleters).toEqual([]);
    // Calls, not mentions: the boot assertion looks the function up by name.
    const purgers = PRODUCTION.filter(([, code]) => /SELECT\s+"access_event_purge"\s*\(/i.test(code)).map(([f]) => f);
    expect(purgers).toEqual([PURGE_FILE]);
  });

  it("NO .ts file names the setting the append-only trigger looks for — the purge function sets it itself", () => {
    // Built from two halves so this file does not name it either. Raw text,
    // comments and tests included: a comment that names it is a hint to the
    // next person, and a test that sets it is a second way in.
    const needle = "droplet." + "access_event_retention";
    const namers = ALL_TS.filter(([, text]) => text.includes(needle)).map(([f]) => f);
    expect(namers).toEqual([]);
    // Not vacuous: the walk reaches the doors service and this file, and its
    // needle is a real setting name (the migration is what carries it).
    expect(ALL_TS.map(([f]) => f)).toEqual(expect.arrayContaining([PURGE_FILE, "apps/orchestrator/src/__tests__/doors-negative-suite.test.ts"]));
    const migration = readFileSync(resolve(REPO, "apps/orchestrator/prisma/migrations/20261002110200_adr_055_doors_tables/migration.sql"), "utf8");
    expect(migration.includes(needle)).toBe(true);
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
      if (/AccessEvent_append_only|AccessEvent_derived_guard|access_event_append_only|access_event_derived_guard|access_event_purge/.test(sql) && !name.endsWith("_adr_055_doors_tables")) {
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

  it("absent means absent everywhere: not in Features, not in the nav, and in no tool list the assistant or MCP could build", () => {
    const doors = MODULE_BY_ID.get("doors" as ModuleId)!;
    // Settings → Features: the module opts out of the "Not installed" row.
    expect(doors.listedWhenUnavailable).toBe(false);
    // Its nav entry is gated on this module in the dashboard (nav-config.ts, and
    // pinned there), and no preset switches the module on.
    expect(doors.navHrefs).toEqual(["/doors"]);
    // /tools, /api/llm/tools, the chat pool and MCP tools/list are all built from
    // the tools-core registry and catalog (P4b adds the two read tools). The module
    // CLAIMS their domain, so WARP-2972's one predicate withholds both whenever the
    // module is not effective. The surfaces themselves are driven in
    // doors.tools-module-gate.test.ts and mcp-server's doors-dispatch.test.ts; here,
    // that the flag off puts the domain, and with it BOTH tools, in the withheld set.
    expect(doors.toolDomains).toEqual(["doors"]);
    const names = TOOL_CATALOG.filter((e) => (e.domain as string) === "doors").map((e) => e.name).sort();
    expect(names).toEqual(["doors_list", "doors_recent_events"]);
    for (const on of [true, false] as const) {
      // An enabling Settings row does not matter while the flag is off: the module is unavailable.
      const box = computeEffectiveIds(new Map<ModuleId, boolean>([["doors" as ModuleId, on]]), REGISTRY_CFG(false));
      expect(box.has("doors" as ModuleId), `flag off, row ${on}`).toBe(false);
      const verdict = { withheldDomains: withheldDomainsFor(box) };
      for (const name of names) expect(isToolWithheldByModule(name, verdict), `${name} / row ${on}`).toBe(true);
    }
  });

  it("the registry's own `available` is the only thing that reads the flag (no second derivation)", () => {
    const doors = MODULE_BY_ID.get("doors" as ModuleId)!;
    expect(doors.available(REGISTRY_CFG(false))).toBe(false);
    expect(doors.available(REGISTRY_CFG(true))).toBe(true);
  });
});

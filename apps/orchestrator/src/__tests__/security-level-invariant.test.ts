/**
 * WARP-2977 P2b (spec §7, §9 "Invariant") — the act / manage level table of
 * every Security route, read off the REAL router stacks.
 *
 * The four routers mounted at "/api" in app.ts (createSecurityRouter,
 * createSecurityZonesRouter, createSecuritySiteRouter and — WARP-2980 —
 * createSecurityPatternsRouter) are walked layer by layer, so what is pinned
 * is the middleware that actually runs, not what a comment claims:
 *
 *   · the exact method + path → level + role table below (§7). Every write
 *     carries `requireFeatureAccess('security', act|manage)` — a write with
 *     no readable meta, or one at the wrong level, fails. No GET carries a
 *     gate above view (the module-wide view gate is mountModuleGates' off
 *     /api/security, pinned in security-prefix-composition.test.ts), so a
 *     page load can never produce the denial the threat mirror turns into a
 *     "threat";
 *   · on every write: `sensitiveRateLimit` first, then the role guard, then
 *     the feature gate (the role floor answers 403 before the resolver is
 *     ever asked);
 *   · each route's role guard, PROBED with a fake request per role: it
 *     admits exactly the roles in the table — and never the MCP service
 *     principal, so no route is `requireRoleOrMcpService` (checked in the
 *     source too);
 *   · no parameterised path precedes a literal sibling it would swallow,
 *     across the routers in app.ts's mount order;
 *   · the write-route count is 9 and the GET count 9 (P2b's 6 + WARP-2980's
 *     routes 29–31, all view), so the table cannot pass over empty stubs or a
 *     dropped route. P3, P4 and P5 PR-B each add their own rows.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import { createSecurityRouter } from "../routes/security.js";
import { createSecurityZonesRouter } from "../routes/security-zones.js";
import { createSecuritySiteRouter } from "../routes/security-site.js";
import { createSecurityPatternsRouter } from "../routes/security-patterns.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { isRoleGuard } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";

type Level = "view" | "act" | "manage";
type Role = "owner" | "admin" | "family";

const VIEW_ROLES: readonly Role[] = ["owner", "admin", "family"];
const ACT_ROLES: readonly Role[] = ["owner", "admin", "family"];
const MANAGE_ROLES: readonly Role[] = ["owner", "admin"];

/** Spec §7, in app.ts mount order (security, zones, site, patterns), each router in declaration order. */
const TABLE: ReadonlyArray<readonly [key: string, level: Level, roles: readonly Role[]]> = [
  // createSecurityRouter (P2a)
  ["GET /security/events", "view", VIEW_ROLES],
  ["GET /security/health", "view", VIEW_ROLES],
  // createSecurityZonesRouter (routes 3, 4, 8–12)
  ["GET /security/zones", "view", VIEW_ROLES],
  ["GET /security/sources", "view", VIEW_ROLES],
  ["POST /security/zones", "manage", MANAGE_ROLES],
  ["PATCH /security/zones/:id", "manage", MANAGE_ROLES],
  ["POST /security/zones/:id/archive", "manage", MANAGE_ROLES],
  ["POST /security/zones/:id/unarchive", "manage", MANAGE_ROLES],
  ["PUT /security/zones/:id/links", "manage", MANAGE_ROLES],
  // createSecuritySiteRouter (routes 5, 6, 7, 13–15)
  ["GET /security/mode", "view", VIEW_ROLES],
  ["GET /security/hours", "view", VIEW_ROLES],
  ["POST /security/mode", "act", ACT_ROLES],
  ["PUT /security/hours", "manage", MANAGE_ROLES],
  ["PUT /security/hours/exceptions/:date", "manage", MANAGE_ROLES],
  ["DELETE /security/hours/exceptions/:date", "manage", MANAGE_ROLES],
  // createSecurityPatternsRouter (WARP-2980, routes 29–31): read-only; all literal paths
  ["GET /security/patterns", "view", VIEW_ROLES],
  ["GET /security/patterns/cells", "view", VIEW_ROLES],
  ["GET /security/patterns/explain", "view", VIEW_ROLES],
];

/** The real number of Security write routes (P2b spec §9 says 9 — and it is; P5 PR-A adds none). */
const WRITE_ROUTES = 9;
/** P2b's 6 plus WARP-2980's routes 29–31. */
const GET_ROUTES = 9;

type Handle = (req: unknown, res: unknown, next: () => void) => unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> };
}
interface RouteInfo {
  router: string;
  method: string;
  path: string;
  key: string;
  handles: Handle[];
}

const PRISMA = {} as PrismaClient;
const ROUTERS = [
  ["createSecurityRouter", createSecurityRouter(PRISMA, {})],
  ["createSecurityZonesRouter", createSecurityZonesRouter(PRISMA, {})],
  ["createSecuritySiteRouter", createSecuritySiteRouter(PRISMA, {})],
  ["createSecurityPatternsRouter", createSecurityPatternsRouter(PRISMA, {})],
] as const;

function routesOf(name: string, router: unknown): RouteInfo[] {
  const stack = (router as { stack: Layer[] }).stack;
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (!layer.route) {
      // A router-level `router.use(...)` would apply to every route below it
      // and is invisible to the per-route pins — refuse it outright.
      throw new Error(`${name}: a non-route layer (router.use) in the Security router stack`);
    }
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]);
    for (const m of methods) {
      const method = m.toUpperCase();
      out.push({ router: name, method, path: layer.route.path, key: `${method} ${layer.route.path}`, handles: layer.route.stack.map((s) => s.handle) });
    }
  }
  return out;
}

const ROUTES: RouteInfo[] = ROUTERS.flatMap(([name, router]) => routesOf(name, router));
const WRITES = ROUTES.filter((r) => r.method !== "GET");
const GETS = ROUTES.filter((r) => r.method === "GET");

/** Which of these principals a role guard lets through — probed, not read off a comment. */
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
    guard({ user, method: "POST", path: "/probe", headers: {} }, res, () => {
      passed = true;
    });
    if (passed) out.push(label);
  }
  return out;
}

/** Express-style path → a regex over concrete paths (`:param` = one segment). */
function pathRegex(path: string): RegExp {
  const body = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}$`);
}

describe("Security level invariant — the four routers' real stacks (spec §7, §9)", () => {
  it("the routes are exactly the §7 table, in mount order", () => {
    expect(ROUTES.map((r) => r.key)).toEqual(TABLE.map(([key]) => key));
  });

  it(`there are exactly ${WRITE_ROUTES} write routes and ${GET_ROUTES} GETs — never a pass over empty stubs`, () => {
    expect(WRITES).toHaveLength(WRITE_ROUTES);
    expect(GETS).toHaveLength(GET_ROUTES);
    expect(TABLE.filter(([, level]) => level !== "view")).toHaveLength(WRITE_ROUTES);
  });

  it.each(TABLE.filter(([key]) => !key.startsWith("GET ")))(
    "%s carries requireFeatureAccess('security', '%s') — exactly one gate",
    (key, level) => {
      const route = ROUTES.find((r) => r.key === key)!;
      const metas = route.handles.map(readFeatureGateMeta).filter((m) => m !== null);
      expect(metas, key).toEqual([{ moduleId: "security", level }]);
    },
  );

  it.each(TABLE.filter(([key]) => key.startsWith("GET ")))("%s carries no gate above view", (key) => {
    const route = ROUTES.find((r) => r.key === key)!;
    const levels = route.handles.map(readFeatureGateMeta).filter((m) => m !== null).map((m) => m!.level);
    expect(levels.filter((l) => l !== "view"), key).toEqual([]);
  });

  it.each(WRITES.map((r) => [r.key, r] as const))("%s: sensitiveRateLimit first, then the role guard, then the feature gate", (key, route) => {
    const guard = route.handles.findIndex(isRoleGuard);
    const gate = route.handles.findIndex((h) => readFeatureGateMeta(h) !== null);
    expect(route.handles[0], key).toBe(sensitiveRateLimit);
    expect(guard, key).toBeGreaterThan(0);
    expect(gate, key).toBeGreaterThan(guard);
    // Nothing that could write runs before the gate: only the limiter and the guard.
    expect(gate, key).toBe(2);
  });

  it.each(TABLE)("%s: its one role guard admits exactly its roles — never a service principal", (key, _level, roles) => {
    const route = ROUTES.find((r) => r.key === key)!;
    const guards = route.handles.filter(isRoleGuard);
    expect(guards, key).toHaveLength(1);
    expect(admitted(guards[0]!), key).toEqual([...roles]);
  });

  it("no route source uses requireRoleOrMcpService / requireRoleOrService (comments aside)", () => {
    for (const file of ["security.ts", "security-zones.ts", "security-site.ts", "security-patterns.ts"]) {
      const code = readFileSync(resolve(__dirname, "../routes", file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\brequireRoleOr\w*/);
    }
  });

  it("no parameterised path precedes a literal sibling it would swallow (app.ts mount order)", () => {
    const shadowed: string[] = [];
    ROUTES.forEach((later, j) => {
      ROUTES.slice(0, j).forEach((earlier) => {
        if (earlier.method !== later.method || earlier.path === later.path) return;
        if (!earlier.path.includes(":")) return;
        if (pathRegex(earlier.path).test(later.path)) shadowed.push(`${earlier.key} shadows ${later.key}`);
      });
    });
    expect(shadowed).toEqual([]);
  });

  it("app.ts mounts the Security routers at /api in the order this table assumes", () => {
    const app = readFileSync(resolve(__dirname, "../app.ts"), "utf8");
    const mounts = [...app.matchAll(/app\.use\(\s*"\/api"\s*,\s*(createSecurity\w*Router)\(/g)].map((m) => m[1]);
    expect(mounts).toEqual(ROUTERS.map(([name]) => name));
  });

  // Guards the probes themselves: a check that cannot fail proves nothing.
  it("the probes can see a violation", () => {
    expect(pathRegex("/security/zones/:id").test("/security/zones/archived")).toBe(true);
    expect(pathRegex("/security/zones/:id").test("/security/zones/a/links")).toBe(false);
    expect(readFeatureGateMeta(sensitiveRateLimit)).toBeNull();
    expect(isRoleGuard(sensitiveRateLimit)).toBe(false);
  });
});

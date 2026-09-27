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
 *   · the write-route count is 15 and the GET count 14 (P2b's 9 writes and 6
 *     GETs, WARP-2978's 3 writes and 4 GETs, WARP-2980 PR-A's 3 GETs, PR-B's 3
 *     writes and 1 GET), so the table cannot pass over empty stubs or a
 *     dropped route. P4 adds its own rows.
 *
 * WARP-2978 (P3 §7): createSecurityIncidentsRouter (routes 16–22), mounted
 * after the site router. Acknowledge and resolve are act; choosing who is told
 * is manage (and family can never pass its role floor, even with a manage
 * resolver); every GET stays at view, and the literal `/incidents/summary` is
 * declared before `/incidents/:id`. WARP-2980 (P5 PR-A):
 * createSecurityPatternsRouter (routes 29–31, all view), mounted last. P5
 * PR-B: expected activity in the same router — the list (32) is view; adding
 * (33) and removing (34) are manage, so family never passes their role floor
 * and neither does Droplet's AI (§4.9: it never creates, extends or widens a
 * suppression). The verdict (35, in the incidents router after resolve) is
 * act with an owner/admin floor (review item 2): nobody overwrites a
 * judgement about cameras they cannot see, and the AI gives none.
 *
 * WARP-2981 (P6): P6-3, the rack panel's count (routes/panel-security.ts), is
 * NOT a Security router and is not in the table: it lives under /api/panel,
 * before the module gates, and no person may call it. Its own block below
 * walks its stack the same way and probes its guard over the same
 * principals — `service:display` joins them, and every row above still
 * refuses it (`requireRole` never admits the `service` role).
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
import { createSecurityIncidentsRouter } from "../routes/security-incidents.js";
import { createSecurityPatternsRouter } from "../routes/security-patterns.js";
import { createPanelSecurityRouter } from "../routes/panel-security.js";
import { readFeatureGateMeta } from "../middleware/feature-gate.js";
import { isRoleGuard } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";

type Level = "view" | "act" | "manage";
type Role = "owner" | "admin" | "family";

const VIEW_ROLES: readonly Role[] = ["owner", "admin", "family"];
const ACT_ROLES: readonly Role[] = ["owner", "admin", "family"];
const MANAGE_ROLES: readonly Role[] = ["owner", "admin"];

/** Spec §7, in app.ts mount order (security, zones, site, incidents, patterns), each router in declaration order. */
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
  // createSecurityIncidentsRouter (WARP-2978, routes 16–22)
  ["GET /security/incidents", "view", VIEW_ROLES],
  ["GET /security/incidents/summary", "view", VIEW_ROLES],
  ["GET /security/incidents/:id", "view", VIEW_ROLES],
  ["POST /security/incidents/:id/acknowledge", "act", ACT_ROLES],
  ["POST /security/incidents/:id/resolve", "act", ACT_ROLES],
  // WARP-2980 P5 PR-B — route 35: act, floored at owner/admin.
  ["POST /security/incidents/:id/verdict", "act", MANAGE_ROLES],
  ["GET /security/alert-routing", "view", VIEW_ROLES],
  ["PUT /security/alert-routing/:userId", "manage", MANAGE_ROLES],
  // createSecurityPatternsRouter (WARP-2980, routes 29–31): read-only; all literal paths
  ["GET /security/patterns", "view", VIEW_ROLES],
  ["GET /security/patterns/cells", "view", VIEW_ROLES],
  ["GET /security/patterns/explain", "view", VIEW_ROLES],
  // WARP-2980 P5 PR-B — expected activity (routes 32–34); the literal path before `/:id/remove`.
  ["GET /security/suppressions", "view", VIEW_ROLES],
  ["POST /security/suppressions", "manage", MANAGE_ROLES],
  ["POST /security/suppressions/:id/remove", "manage", MANAGE_ROLES],
];

/**
 * P2b spec §9's 9 write routes and 6 GETs; WARP-2978 adds 3 writes (19, 20, 22)
 * and 4 GETs (16, 17, 18, 21); WARP-2980 PR-A adds 3 GETs (29–31) and no
 * write; PR-B adds 3 writes (33, 34, 35) and 1 GET (32).
 */
const WRITE_ROUTES = 15;
const GET_ROUTES = 14;

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
  // WARP-2978 (P3) — mounted after the site router.
  ["createSecurityIncidentsRouter", createSecurityIncidentsRouter(PRISMA, {})],
  // WARP-2980 (P5 PR-A) — the last Security router.
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
  // WARP-2981 — the rack panel's principal: admitted by P6-3 alone.
  ["service:display", { id: "_service:display", role: "service" }],
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
    for (const file of ["security.ts", "security-zones.ts", "security-site.ts", "security-incidents.ts", "security-patterns.ts"]) {
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

  it("WARP-2978: `/incidents/summary` is declared before `/incidents/:id`, which would swallow it", () => {
    const keys = ROUTES.map((r) => r.key);
    expect(keys.indexOf("GET /security/incidents/summary")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("GET /security/incidents/summary")).toBeLessThan(keys.indexOf("GET /security/incidents/:id"));
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

describe("WARP-2981 — P6-3, the rack panel's count", () => {
  const PANEL = routesOf("createPanelSecurityRouter", createPanelSecurityRouter(PRISMA, {}));

  it("the router is exactly GET /panel/security — outside the Security prefix", () => {
    expect(PANEL.map((r) => r.key)).toEqual(["GET /panel/security"]);
    expect(PANEL[0]!.path.startsWith("/security")).toBe(false);
  });

  it("its guard admits exactly the panel's own principal — no person, no other service", () => {
    const [guard, handler, ...rest] = PANEL[0]!.handles;
    expect(rest).toEqual([]);
    expect(handler).toBeTypeOf("function");
    expect(admitted(guard!)).toEqual(["service:display"]);
  });

  it("no feature gate and no role-guard marker (requireRoleOrService carries none; nothing here is a person's route)", () => {
    expect(PANEL[0]!.handles.map(readFeatureGateMeta).filter((m) => m !== null)).toEqual([]);
    expect(PANEL[0]!.handles.filter(isRoleGuard)).toEqual([]);
  });

  it("app.ts mounts it once, at /api — and the Security mount pin above still lists only the five Security routers", () => {
    const app = readFileSync(resolve(__dirname, "../app.ts"), "utf8");
    expect(app.split('app.use("/api", createPanelSecurityRouter(prisma))').length - 1).toBe(1);
    const mounts = [...app.matchAll(/app\.use\(\s*"\/api"\s*,\s*(createSecurity\w*Router)\(/g)].map((m) => m[1]);
    expect(mounts).not.toContain("createPanelSecurityRouter");
  });
});

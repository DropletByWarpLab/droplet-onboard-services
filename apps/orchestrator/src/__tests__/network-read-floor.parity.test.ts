/**
 * WARP-3632 — who may read network configuration, through the browser routes
 * and through the assistant tools.
 *
 *  1. Every GET under /network, /switch and /aps carries a role guard that
 *     refuses an external guest, except an explicit allowlist (status, summary,
 *     throughput, and the caller's own audit trail).
 *  2. Every read tool of the network domain enforces the same minimum role as
 *     the route it reads. The tools reach those routes as the `_service:mcp`
 *     principal, which the route guards admit before any role check, and the
 *     acting-user tool-domain gate does not cover `network`, so the tool's own
 *     `ctx.role` check is the only one that sees the person in the chat.
 *
 * The route floor is measured, not declared: each real route's role guards are
 * replayed for every role. A new network GET with no guard, or a tool whose
 * floor drifts from its route's, fails here.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, { type Request, type RequestHandler, type Response, type NextFunction } from "express";
import { TOOL_ROUTES, TOOLS, type ToolContext } from "@droplet/tools-core";

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { isRoleGuard, type AuthUser } from "../middleware/auth.js";
import { createNetworkRouter } from "../routes/network.js";
import { createNetworkThroughputRouter } from "../routes/network-throughput.js";
import { createSwitchRouter } from "../routes/switch.js";
import { createApsRouter } from "../routes/aps.js";

type Role = AuthUser["role"];
const HUMAN_ROLES = ["owner", "admin", "family", "guest"] as const satisfies readonly Role[];

/** Reads a guest may make: status/summary/throughput (WARP-3091) and one's own audit trail. */
const GUEST_READABLE = new Set([
  "/network/status",
  "/network/summary",
  "/network/throughput",
  "/network/audit",
]);
/** The only GETs allowed to carry no role guard at all. */
const UNGUARDED = new Set(["/network/status", "/network/audit"]);

interface GetRoute {
  path: string;
  guards: RequestHandler[];
}

function getRoutes(): GetRoute[] {
  const prisma = {} as never;
  const routers = [
    createNetworkRouter(prisma),
    createNetworkThroughputRouter(prisma),
    createSwitchRouter(prisma),
    createApsRouter(prisma),
  ] as unknown as Array<{
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }>;
  }>;
  return routers.flatMap((r) =>
    r.stack
      .map((l) => l.route)
      .filter((rt): rt is NonNullable<typeof rt> => Boolean(rt) && rt!.methods.get === true)
      .filter((rt) => /^\/(network|switch|aps)(\/|$)/.test(rt.path))
      .map((rt) => ({
        path: rt.path,
        guards: rt.stack.map((h) => h.handle).filter((h) => isRoleGuard(h)),
      })),
  );
}

const ROUTES = getRoutes();
const shape = (p: string) => p.replace(/^\/api/, "").replace(/:[A-Za-z_]+/g, ":p");
const ROUTE_BY_SHAPE = new Map(ROUTES.map((r) => [shape(r.path), r]));

/** The roles whose session gets past the route's role guards (the MCP principal is not one). */
async function routeFloor(route: GetRoute): Promise<Set<Role>> {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = req.header("x-test-role") as Role;
    req.user = { id: `u-${role}`, username: role, displayName: role, role } as AuthUser;
    next();
  });
  app.get(route.path.replace(/:[A-Za-z_]+/g, "x"), ...route.guards, (_req, res) => {
    res.json({ ok: true });
  });
  const allowed = new Set<Role>();
  for (const role of HUMAN_ROLES) {
    const res = await request(app).get(route.path.replace(/:[A-Za-z_]+/g, "x")).set("x-test-role", role);
    if (res.status === 200) allowed.add(role);
  }
  return allowed;
}

describe("network, switch and aps reads: the route floor (WARP-3632)", () => {
  it("sweeps the whole surface (guards against a vacuous run)", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    for (const p of ["/network/firewall", "/network/topology", "/switch/vlans", "/aps", "/network/status"]) {
      expect(ROUTE_BY_SHAPE.has(p), p).toBe(true);
    }
  });

  it("only status and the caller's own audit trail go without a role guard", () => {
    const unguarded = ROUTES.filter((r) => r.guards.length === 0).map((r) => shape(r.path));
    expect(unguarded.sort()).toEqual([...UNGUARDED].sort());
  });

  it("an external guest is refused everywhere except the explicit allowlist", async () => {
    const guestCanRead: string[] = [];
    for (const r of ROUTES) {
      if ((await routeFloor(r)).has("guest") || r.guards.length === 0) guestCanRead.push(shape(r.path));
    }
    expect(guestCanRead.sort()).toEqual([...GUEST_READABLE].sort());
  });

  it("a member keeps the Simple view's reads; the Wi-Fi settings stay owner/admin", async () => {
    for (const p of ["/network/devices", "/aps", "/network/firewall", "/switch/ports"]) {
      expect((await routeFloor(ROUTE_BY_SHAPE.get(p)!)).has("family"), p).toBe(true);
    }
    expect([...(await routeFloor(ROUTE_BY_SHAPE.get("/network/wifi")!))].sort()).toEqual(["admin", "owner"]);
  });
});

// ── tools ────────────────────────────────────────────────────────────────

/** Read tools that read Prisma directly: the route that serves the same rows. */
const PRISMA_TOOL_ROUTE: Record<string, string> = {
  list_network_devices: "/network/devices",
  list_ap_devices: "/aps",
};

const NETWORK_PREFIXES = ["/api/network/", "/api/switch/", "/api/aps"];

/** tool -> the routes it reads. */
function networkReadTools(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of TOOL_ROUTES) {
    if (TOOLS.get(e.tool)?.requiresWrite !== false) continue;
    if (e.tool in PRISMA_TOOL_ROUTE) {
      out.set(e.tool, [PRISMA_TOOL_ROUTE[e.tool]]);
    } else if (
      e.hops.length > 0 &&
      e.hops.every((h) => h.method === "get" && NETWORK_PREFIXES.some((p) => h.pathPattern.startsWith(p)))
    ) {
      out.set(e.tool, e.hops.map((h) => shape(h.pathPattern)));
    }
  }
  return out;
}

async function toolFloor(name: string): Promise<Set<Role>> {
  const allowed = new Set<Role>();
  for (const role of HUMAN_ROLES) {
    const get = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const findMany = vi.fn().mockResolvedValue([]);
    const ctx = {
      http: { orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
      prisma: { networkDevice: { findMany }, apDevice: { findMany } },
      matter: {},
      signal: new AbortController().signal,
      role,
    } as unknown as ToolContext;
    try {
      const r = await TOOLS.get(name)!.handler({}, ctx);
      if (r.ok || r.error.code !== "FORBIDDEN") allowed.add(role);
    } catch {
      // Past the role gate, then tripped over the stub's empty body.
      allowed.add(role);
    }
  }
  return allowed;
}

describe("network read tools enforce their route's floor (WARP-3632)", () => {
  const tools = networkReadTools();

  it("covers every read tool of the domain, including the two that read Prisma", () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        "list_network_devices",
        "list_ap_devices",
        "list_dhcp_leases",
        "get_wifi_settings",
        "get_firewall_rules",
        "get_router_system_info",
        "scan_wifi_networks",
        "get_switch_ports",
        "get_switch_vlans",
        "get_switch_poe",
        "get_network_status",
      ]),
    );
  });

  it.each([...tools.entries()])("%s allows exactly the roles its route allows", async (name, routes) => {
    let expected: Set<Role> = new Set(HUMAN_ROLES);
    for (const p of routes) {
      const route = ROUTE_BY_SHAPE.get(p);
      expect(route, `${name}: no route ${p}`).toBeDefined();
      const floor = await routeFloor(route!);
      // A route with no guard of its own (status) is open to every role.
      expected = new Set([...expected].filter((r) => route!.guards.length === 0 || floor.has(r)));
    }
    expect([...(await toolFloor(name))].sort()).toEqual([...expected].sort());
  });

  it("a guest chat turn gets FORBIDDEN from the four tools named in the finding", async () => {
    for (const name of ["list_network_devices", "list_ap_devices", "list_dhcp_leases", "get_wifi_settings"]) {
      expect((await toolFloor(name)).has("guest"), name).toBe(false);
    }
    expect((await toolFloor("get_wifi_settings")).has("family")).toBe(false);
  });
});

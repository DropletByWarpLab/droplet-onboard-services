/**
 * Contract test: @droplet/tools-core network handlers ↔ orchestrator routes.
 *
 * The drift class this pins shut: network tool handlers hardcoded HTTP paths
 * the backing service never exposed (POST /wifi/ssid against a routing
 * service that only has /wireless/ssid, GET /status against nothing), and the
 * only end-to-end coverage — the mcp-server stdio roundtrip — faked its HTTP
 * server at the handler-side paths, so every network tool 404'd in production
 * while the suite stayed green.
 *
 * Two assertions, both against the real artifacts:
 *
 *  1. No network handler calls `ctx.http.routing`. The routing service sits
 *     behind the orchestrator's network-safety layer (llm-safety-tiers.md
 *     §Service-to-Service Auth) and the mcp-server holds no
 *     ROUTING_SERVICE_TOKEN — a direct call bypasses tier enforcement AND
 *     401s on a provisioned box.
 *  2. Every `ctx.http.orchestrator` path a network handler references
 *     resolves, method and all, against the REAL route registrations
 *     (the same modules app.ts mounts at /api), introspected from the
 *     Express route stack — not a hand-maintained list.
 *
 * Handler sources are read from the workspace at test time, so a new or
 * edited handler is covered the moment it lands.
 */

import { describe, it, expect, vi } from "vitest";
import { Router } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/network.service.js", () => ({
  getWifiSettings: vi.fn(),
  scanWifiNetworks: vi.fn(),
  setWifiSsid: vi.fn(),
  setWifiPassword: vi.fn(),
  setWifiChannel: vi.fn(),
  getFirewallConfig: vi.fn(),
  blockDevice: vi.fn(),
  unblockDevice: vi.fn(),
  addPortForward: vi.fn(),
  getNetworkOverview: vi.fn(),
  getConnectedDevices: vi.fn(),
  getDhcpLeases: vi.fn(),
  getSystemInfo: vi.fn(),
  addStaticDhcpLease: vi.fn(),
  rebootRouter: vi.fn(),
  getRouterOperation: vi.fn(),
}));

vi.mock("../services/egress.service.js", () => ({
  getPhoneHomeSettings: vi.fn(),
  getPhoneHomeView: vi.fn(),
  setPhoneHomeSetting: vi.fn(),
  MASTER_SETTING_KEY: "phone_home_master",
  CAMERAS_SETTING_KEY: "phone_home_cameras",
}));

vi.mock("../services/ap-onboard.service.js", () => ({
  approveAp: vi.fn(),
  decommissionAp: vi.fn(),
  ApOnboardError: class ApOnboardError extends Error {},
  DISCOVERED_AP_LRU_CAP: 25,
  // WARP-1703: imported by network-wifi.routes.ts.
  getBandSteering: vi.fn().mockResolvedValue({ supported: false, enabled: false }),
  setBandSteering: vi.fn().mockResolvedValue({ operationId: null }),
  // WARP-1712: imported by network-wifi.routes.ts (getApWifi/setApWifi),
  // network-status.routes.ts (setApWifi) and aps.ts (getApWirelessForMac).
  getApWifi: vi.fn().mockResolvedValue({
    supported: false, ssid: null, fiveGhzSsid: null, key: null,
    encryption: null, bandSteering: null, apCount: 0, inSync: true,
  }),
  setApWifi: vi
    .fn()
    .mockResolvedValue({ operationId: null, ssid: null, fiveGhzSsid: null }),
  getApWirelessForMac: vi
    .fn()
    .mockResolvedValue({ mac: "AA:BB:CC:DD:EE:FF", supported: false, radios: [] }),
}));

import { registerStatusRoutes, type StatusDeps } from "../routes/network-status.routes.js";
import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { registerFirewallRoutes } from "../routes/network-firewall.routes.js";
import { registerPhoneHomeRoutes } from "../routes/network-phone-home.routes.js";
import { registerDeviceRoutes, type DeviceDeps } from "../routes/network-devices.routes.js";
import { createNetworkThroughputRouter } from "../routes/network-throughput.js";
import { createApsRouter } from "../routes/aps.js";
// WARP-1443 tools (list_threat_events / list_vpn_peers / set_device_schedule)
// dispatch to these three routers; without them mounted the contract asserts
// against an incomplete table and false-reds those tools' paths.
import { createActivityRouter } from "../routes/activity.js";
import { createVpnRouter } from "../routes/vpn.js";
import { registerScheduleRoutes, type ScheduleDeps } from "../routes/network-schedules.routes.js";
import { repoPath } from "./helpers/test-paths.js";

// Anchored to this test file, not to the runner's cwd (WARP-2654). The old
// candidate list took the first entry that existed, so a cwd inside another
// checkout resolved to that tree's handlers. `__dirname` under the hood, not
// import.meta, which is a tsc error in this CommonJS package.
const HANDLERS_DIR = repoPath("packages/tools-core/src/handlers/network");

interface HandlerCall {
  file: string;
  target: "orchestrator" | "routing";
  method: string;
  path: string;
}

/** Every ctx.http.<target>.<method>("<literal>" | `<template>`) in the network handlers. */
function scanHandlerCalls(): HandlerCall[] {
  const calls: HandlerCall[] = [];
  const callRe =
    /ctx\.http\.(orchestrator|routing)\.(get|post|patch|put|delete)\(\s*(?:"([^"]+)"|`([^`]+)`)/g;
  for (const file of readdirSync(HANDLERS_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(HANDLERS_DIR, file), "utf8");
    for (const m of src.matchAll(callRe)) {
      calls.push({
        file,
        target: m[1] as HandlerCall["target"],
        method: m[2],
        path: m[3] ?? m[4],
      });
    }
  }
  return calls;
}

/** Flatten an Express router's registered (method, path) pairs. */
function collectRoutes(router: Router): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method, path: layer.route.path });
    }
  }
  return out;
}

/**
 * Match a handler-side path (mounted under /api, may contain `${...}`
 * interpolations) against a registered route path (`:param` segments).
 */
function resolvesToRoute(
  call: HandlerCall,
  routes: Array<{ method: string; path: string }>,
): boolean {
  const withoutApi = call.path.replace(/^\/api(?=\/|$)/, "");
  const handlerSegs = withoutApi.split("/").filter((s) => s.length > 0);
  return routes.some((r) => {
    if (r.method !== call.method) return false;
    const routeSegs = r.path.split("/").filter((s) => s.length > 0);
    if (routeSegs.length !== handlerSegs.length) return false;
    return routeSegs.every(
      (seg, i) => seg.startsWith(":") || seg === handlerSegs[i],
    );
  });
}

function buildRouteTable(): Array<{ method: string; path: string }> {
  const prisma = {} as PrismaClient;
  const router = Router();
  registerStatusRoutes(router, {
    prisma,
    networkDeviceService: {} as StatusDeps["networkDeviceService"],
  });
  registerWifiRoutes(router, { prisma });
  registerFirewallRoutes(router, { prisma });
  registerPhoneHomeRoutes(router, { prisma });
  registerDeviceRoutes(router, {
    networkDeviceService: {} as DeviceDeps["networkDeviceService"],
  });
  // WARP-1443: schedules register onto the same router; deps are handler-time
  // only, so a stub scheduleApi is fine for route-stack introspection.
  registerScheduleRoutes(router, {
    scheduleApi: {} as ScheduleDeps["scheduleApi"],
  });
  return [
    ...collectRoutes(router),
    ...collectRoutes(createNetworkThroughputRouter(prisma)),
    ...collectRoutes(createApsRouter(prisma)),
    // WARP-1443: list_threat_events → /api/activity, list_vpn_peers → /api/vpn/peers.
    ...collectRoutes(createActivityRouter(prisma)),
    ...collectRoutes(createVpnRouter(prisma)),
  ];
}

describe("network tool handler paths resolve against the orchestrator route table", () => {
  const calls = scanHandlerCalls();
  const routes = buildRouteTable();

  it("the source scan actually finds the handlers (anti-rot guard)", () => {
    // 11 repointed handlers + summary + phone-home + AP tools. If a refactor
    // changes the call idiom this floor fails loudly instead of the contract
    // silently asserting nothing.
    expect(calls.length).toBeGreaterThanOrEqual(14);
  });

  it("no network handler calls ctx.http.routing directly", () => {
    const direct = calls.filter((c) => c.target === "routing");
    expect(
      direct,
      `network tools must go through the orchestrator's safety-tiered /api/network surface, ` +
        `not the routing service (no tier enforcement, no service token on the MCP hop): ` +
        direct.map((c) => `${c.file}: ${c.method.toUpperCase()} ${c.path}`).join(", "),
    ).toEqual([]);
  });

  it.each(
    calls
      .filter((c) => c.target === "orchestrator")
      .map((c) => [`${c.file}: ${c.method.toUpperCase()} ${c.path}`, c] as const),
  )("%s is a registered orchestrator route", (_label, call) => {
    expect(
      resolvesToRoute(call, routes),
      `no registered route matches — routes under the same prefix:\n` +
        routes
          .filter((r) => r.path.split("/")[1] === call.path.replace(/^\/api/, "").split("/")[1])
          .map((r) => `  ${r.method.toUpperCase()} ${r.path}`)
          .join("\n"),
    ).toBe(true);
  });
});

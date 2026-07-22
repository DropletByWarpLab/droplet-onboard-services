/**
 * WARP-826 — `getNetworkOverview().routerConnected` must be DERIVED from real
 * router reachability, not hardcoded `true`.
 *
 * Bug (static analysis + ADR-018 / the 2026-05-31 single-box diagnosis):
 * network.service.ts set `routerConnected: true` literally whenever the four
 * status fetches resolved. On the single-box the OpenWrt has no `wan` logical
 * interface (WAN is handled by the host), and the routing SDK now degrades that
 * absent WAN to a `present:false` stub — so the fetches resolve fine, but the
 * old code still couldn't represent "fetches returned cached/partial data while
 * the router is actually unreachable", and conversely a transient summary error
 * dropped the whole overview to a 503 the dashboard reads as OFFLINE.
 *
 * The fix derives `routerConnected` from `openwrt.healthCheck()` — which mirrors
 * the routing service's `/health` `connected` flag (a live ubus `board_info()`
 * probe). The WAN-absent single-box reports `connected:true` there, so it is
 * ONLINE; an unreachable router reports `connected:false`, so it is OFFLINE —
 * an honest, reachability-derived signal instead of a constant. Crucially the
 * overview still succeeds (200, not 503) for a reachable WAN-less box: WAN
 * absence must never read as offline.
 *
 * Mirrors network.service.hostapd.test.ts: mock openwrt.client + cache, assert
 * the derivation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

// config is read for DROPLET_AP_MODE on the write paths; harmless default here.
vi.mock("../config.js", () => ({ config: { DROPLET_AP_MODE: "uci", agentMaxIter: { defaultIter: 5, capIter: 10 } } }));

// Cache must MISS so getNetworkOverview recomputes (it short-circuits on a hit).
vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// hostapd-bridge isn't exercised by the read path, but network.service imports it.
vi.mock("./hostapd-bridge.service.js", () => ({
  stageSsid: vi.fn(),
  applyWifi: vi.fn(),
}));

const {
  healthCheck,
  fetchInterfaces,
  fetchWirelessStatus,
  fetchSystemInfo,
  fetchDhcpLeases,
} = vi.hoisted(() => ({
  healthCheck: vi.fn(),
  fetchInterfaces: vi.fn(),
  fetchWirelessStatus: vi.fn(),
  fetchSystemInfo: vi.fn(),
  fetchDhcpLeases: vi.fn(),
}));

vi.mock("./openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("./openwrt.client.js");
  return {
    ...actual,
    healthCheck: (...a: unknown[]) => healthCheck(...a),
    fetchInterfaces: (...a: unknown[]) => fetchInterfaces(...a),
    fetchWirelessStatus: (...a: unknown[]) => fetchWirelessStatus(...a),
    fetchSystemInfo: (...a: unknown[]) => fetchSystemInfo(...a),
    fetchDhcpLeases: (...a: unknown[]) => fetchDhcpLeases(...a),
  };
});

import { getNetworkOverview } from "./network.service.js";

// A LAN-only single-box interface map: lan present + up, wan an explicit
// present:false stub (WAN handled by the host). This is what the routing SDK
// returns on the box that motivated ADR-018.
const SINGLE_BOX_INTERFACES = {
  lan: { up: true, present: true, device: "br-lan" },
  wan: { up: false, present: false, "ipv4-address": [] },
} as any;

const WIRELESS = { radios: [] } as any;
const SYSTEM = { board: { model: "single-box" }, resources: {} } as any;

beforeEach(() => {
  vi.clearAllMocks();
  fetchInterfaces.mockResolvedValue(SINGLE_BOX_INTERFACES);
  fetchWirelessStatus.mockResolvedValue(WIRELESS);
  fetchSystemInfo.mockResolvedValue(SYSTEM);
  fetchDhcpLeases.mockResolvedValue([]);
});

describe("getNetworkOverview routerConnected derivation (WARP-826)", () => {
  it("is TRUE when the router is reachable (healthCheck resolves true)", async () => {
    healthCheck.mockResolvedValue(true);
    const result = await getNetworkOverview();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routerConnected).toBe(true);
    }
  });

  it("is FALSE when the router is unreachable, even if reads return data", async () => {
    // The honest case the hardcoded `true` could never represent: status reads
    // resolve (e.g. from a warm cache on the routing side) but the live ubus
    // probe says the router is down. routerConnected must follow reachability.
    healthCheck.mockResolvedValue(false);
    const result = await getNetworkOverview();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routerConnected).toBe(false);
    }
  });

  it("derives the flag from healthCheck (not a literal) — healthCheck is consulted", async () => {
    healthCheck.mockResolvedValue(true);
    await getNetworkOverview();
    expect(healthCheck).toHaveBeenCalledTimes(1);
  });

  it("single-box WAN-absence is ONLINE (200, not 503) when ubus is reachable", async () => {
    // THE regression: a reachable LAN-only box (wan present:false) must NOT read
    // as offline. The overview succeeds AND routerConnected is true.
    healthCheck.mockResolvedValue(true);
    const result = await getNetworkOverview();
    expect(result.ok).toBe(true); // ok arm → route returns 200, dashboard ONLINE
    if (result.ok) {
      expect(result.value.routerConnected).toBe(true);
      // and the WAN-absent interface rode through untouched (no degrade-to-offline)
      expect(result.value.interfaces.wan.present).toBe(false);
    }
  });

  it("a real fetch failure still surfaces the error arm (503), unchanged", async () => {
    // Reachability derivation must not swallow genuine summary faults — a thrown
    // fetch still returns the err() arm so /network/status 503s with the code.
    healthCheck.mockResolvedValue(true);
    fetchSystemInfo.mockRejectedValue(new Error("ubus timeout"));
    const result = await getNetworkOverview();
    expect(result.ok).toBe(false);
  });

  it("a healthCheck failure does not break the overview (treated as not connected)", async () => {
    // healthCheck swallows its own errors and returns false, but guard anyway:
    // if it rejected, the overview must not 500 the whole read — it resolves
    // with routerConnected false rather than throwing.
    healthCheck.mockRejectedValue(new Error("health probe blew up"));
    const result = await getNetworkOverview();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.routerConnected).toBe(false);
    }
  });
});

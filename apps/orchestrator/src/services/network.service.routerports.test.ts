/**
 * WARP-1866 — `getRouterPorts()` is a cached pass-through of the routing
 * service's physical port map.
 *
 * Two things are worth pinning at this layer, because both are ways the panel
 * could end up lying while every call still "succeeds":
 *
 *  1. an unreachable router must PROPAGATE, not resolve to an empty map — the
 *     dashboard's unreachable state and its no-port-map state say different
 *     things and are chosen by whether this throws;
 *  2. the map is cached on the SHORT TTL. Someone plugging in a cable and
 *     watching the panel is the use case; a long TTL would show the cable
 *     arriving at the switch (10s) before the router.
 *
 * Mirrors network.service.routerconnected.test.ts: mock openwrt.client + cache,
 * assert the behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { DROPLET_AP_MODE: "uci", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { cacheGet, cacheSet, cacheDel } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("./cache.service.js", () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...a),
  cacheSet: (...a: unknown[]) => cacheSet(...a),
  cacheDel: (...a: unknown[]) => cacheDel(...a),
}));

vi.mock("./hostapd-bridge.service.js", () => ({
  stageSsid: vi.fn(),
  applyWifi: vi.fn(),
}));

const { fetchRouterPorts } = vi.hoisted(() => ({ fetchRouterPorts: vi.fn() }));

vi.mock("./openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("./openwrt.client.js");
  return { ...actual, fetchRouterPorts: (...a: unknown[]) => fetchRouterPorts(...a) };
});

import { getRouterPorts } from "./network.service.js";
import { RouterError } from "./openwrt.client.js";

const MAP = {
  supported: true,
  detail: null,
  model: "MikroTik RB5009",
  ports: [
    {
      id: "p1", role: "wan", networks: ["wan", "wan6"], present: true,
      admin_up: true, link_up: true, speed: "2.5 Gb", duplex: "full",
      mac: "d0:ea:11:41:67:2c", is_sfp: false,
      traffic: { rx_bytes: 1, tx_bytes: 2 }, status: "online",
    },
  ],
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  cacheGet.mockResolvedValue(null);
  cacheSet.mockResolvedValue(undefined);
  cacheDel.mockResolvedValue(undefined);
  fetchRouterPorts.mockResolvedValue(MAP);
});

describe("getRouterPorts (WARP-1866)", () => {
  it("serves the routing service's map", async () => {
    expect(await getRouterPorts()).toEqual(MAP);
    expect(fetchRouterPorts).toHaveBeenCalledTimes(1);
  });

  it("caches on the SHORT ttl, matching the switch port map's refresh", async () => {
    await getRouterPorts();
    expect(cacheSet).toHaveBeenCalledWith("network:ports", MAP, 10);
  });

  it("serves a cache hit without touching the router", async () => {
    cacheGet.mockResolvedValue(MAP);
    expect(await getRouterPorts()).toEqual(MAP);
    expect(fetchRouterPorts).not.toHaveBeenCalled();
  });

  it("propagates an unreachable router instead of resolving to an empty map", async () => {
    // An empty map would render as "this router reports no ports", which is a
    // different — and false — statement about a router that simply didn't answer.
    fetchRouterPorts.mockRejectedValue(RouterError.unreachable("Router ports"));
    await expect(getRouterPorts()).rejects.toBeInstanceOf(RouterError);
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("passes an unsupported-shape answer through as data, not as an error", async () => {
    const unsupported = { supported: false, detail: "no port map", model: null, ports: [] };
    fetchRouterPorts.mockResolvedValue(unsupported);
    expect(await getRouterPorts()).toEqual(unsupported);
  });
});

/**
 * WARP-817 — host-side deployment-topology probe.
 *
 * The routing service's GET /network/topology (ADR-018) probes the
 * CONTAINERISED OpenWrt's "wan" ubus interface, which the single-box shape
 * never configures (WAN is HOST-owned) — so it always reports UNKNOWN, and the
 * onboarding wizard can never tell "downstream of an existing home router"
 * (the common case) apart from "this box IS the primary router".
 *
 * Two things under test:
 *
 *   1. `fetchHostTopology()` (lib/host-topology.ts) — the bridge caller.
 *      Mirrors `fetchBridgeUplinkIp()`'s test shape (vpn-home-endpoint):
 *      best-effort, degrades to `null` on any failure, never throws.
 *
 *   2. `getTopology()` (services/network.service.ts) — the read the
 *      `/network/topology` route serves. On the single-box shape
 *      (DROPLET_AP_MODE=hostapd) it prefers the host probe; on any other
 *      shape, or when the host probe comes back null, it falls back to the
 *      routing-service topology unchanged. `assertPrimaryRouterPosture()`
 *      (the brick-risk KAN-8 firmware gate) is NOT under test here — it
 *      intentionally stays wired to `openwrt.fetchTopology()` directly and
 *      must be unaffected by this change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { configMock } = vi.hoisted(() => ({
  configMock: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_AP_MODE: "uci" as "uci" | "hostapd" | "auto",
    DEVICE_BRIDGE_URL: "http://host.docker.internal:9090",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../config.js", () => ({ config: configMock }));

vi.mock("../services/openwrt.client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/openwrt.client.js")>();
  return {
    ...actual,
    fetchTopology: vi.fn(),
  };
});

vi.mock("../lib/host-topology.js", () => ({
  fetchHostTopology: vi.fn(),
}));

import * as openwrt from "../services/openwrt.client.js";
import { fetchHostTopology } from "../lib/host-topology.js";
import { getTopology } from "../services/network.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  configMock.DROPLET_AP_MODE = "uci";
});

describe("getTopology (WARP-817 host-signal preference)", () => {
  it("uci mode: uses the routing-service topology unchanged and never probes the host", async () => {
    configMock.DROPLET_AP_MODE = "uci";
    vi.mocked(openwrt.fetchTopology).mockResolvedValue({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { wan_present: true },
    });

    await expect(getTopology()).resolves.toEqual({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { wan_present: true },
    });
    expect(fetchHostTopology).not.toHaveBeenCalled();
  });

  it("hostapd mode: prefers the host probe when it succeeds", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    vi.mocked(fetchHostTopology).mockResolvedValue({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { uplink_iface: "br-mgmt", upstream_gateway: "192.168.1.254" },
    });

    await expect(getTopology()).resolves.toEqual({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { uplink_iface: "br-mgmt", upstream_gateway: "192.168.1.254" },
    });
    // The host probe answered — the routing-service topology is never consulted.
    expect(openwrt.fetchTopology).not.toHaveBeenCalled();
  });

  it("hostapd mode: reports PRIMARY_ROUTER from the host probe", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    vi.mocked(fetchHostTopology).mockResolvedValue({
      posture: "PRIMARY_ROUTER",
      evidence: { uplink_iface: "eth0", upstream_gateway: null },
    });

    const result = await getTopology();
    expect(result.posture).toBe("PRIMARY_ROUTER");
  });

  it("hostapd mode: falls back to the routing-service topology when the host probe fails (null)", async () => {
    configMock.DROPLET_AP_MODE = "hostapd";
    vi.mocked(fetchHostTopology).mockResolvedValue(null);
    vi.mocked(openwrt.fetchTopology).mockResolvedValue({ posture: "UNKNOWN" });

    await expect(getTopology()).resolves.toEqual({ posture: "UNKNOWN" });
    expect(fetchHostTopology).toHaveBeenCalledTimes(1);
    expect(openwrt.fetchTopology).toHaveBeenCalledTimes(1);
  });

  it("auto mode: does not probe the host — same as uci", async () => {
    configMock.DROPLET_AP_MODE = "auto";
    vi.mocked(openwrt.fetchTopology).mockResolvedValue({ posture: "PRIMARY_ROUTER" });

    await expect(getTopology()).resolves.toEqual({ posture: "PRIMARY_ROUTER" });
    expect(fetchHostTopology).not.toHaveBeenCalled();
  });
});

/**
 * `fetchHostTopology()` — the bridge caller itself. Mirrors
 * `fetchBridgeUplinkIp()`'s test shape (vpn-home-endpoint-discovery.test.ts):
 * best-effort, degrades to null on any failure, never throws.
 */
describe("fetchHostTopology", () => {
  // Un-mock host-topology.ts for this block — we want the REAL implementation,
  // only its dependencies (fetch, config, bridge auth) are faked.
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.BRIDGE_AUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it("returns the topology the bridge reports", async () => {
    vi.doUnmock("../lib/host-topology.js");
    const { fetchHostTopology: realFetch } = await vi.importActual<
      typeof import("../lib/host-topology.js")
    >("../lib/host-topology.js");

    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({
            posture: "DOWNSTREAM_ROUTER",
            evidence: { uplink_iface: "br-mgmt", upstream_gateway: "192.168.1.254" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(realFetch()).resolves.toEqual({
      posture: "DOWNSTREAM_ROUTER",
      evidence: { uplink_iface: "br-mgmt", upstream_gateway: "192.168.1.254" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${configMock.DEVICE_BRIDGE_URL}/host/topology`);
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe(
      "test-token",
    );
  });

  it("returns null (never throws) when the bridge is unreachable", async () => {
    vi.doUnmock("../lib/host-topology.js");
    const { fetchHostTopology: realFetch } = await vi.importActual<
      typeof import("../lib/host-topology.js")
    >("../lib/host-topology.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("fetch failed");
        (err as { cause?: { code?: string } }).cause = { code: "ECONNREFUSED" };
        throw err;
      }),
    );
    await expect(realFetch()).resolves.toBeNull();
  });

  it("returns null when the bridge answers with a non-2xx status", async () => {
    vi.doUnmock("../lib/host-topology.js");
    const { fetchHostTopology: realFetch } = await vi.importActual<
      typeof import("../lib/host-topology.js")
    >("../lib/host-topology.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    await expect(realFetch()).resolves.toBeNull();
  });

  it("returns null when the bridge auth token is not configured", async () => {
    vi.doUnmock("../lib/host-topology.js");
    const { fetchHostTopology: realFetch } = await vi.importActual<
      typeof import("../lib/host-topology.js")
    >("../lib/host-topology.js");

    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(realFetch()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the response body is malformed (no posture)", async () => {
    vi.doUnmock("../lib/host-topology.js");
    const { fetchHostTopology: realFetch } = await vi.importActual<
      typeof import("../lib/host-topology.js")
    >("../lib/host-topology.js");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(realFetch()).resolves.toBeNull();
  });
});

/**
 * Home-mode box LAN-IP discovery (hybrid remote-access P1).
 *
 * `resolveHomeEndpointHost()` returns the box's home-network-facing LAN IP —
 * the address a HOME-mode WireGuard peer dials directly. The IP is DHCP, so it
 * is DISCOVERED (from the routing-service network summary), never hardcoded:
 *
 *   1. The WAN interface's IPv4 address, when the summary exposes one (multi-box
 *      shape where the containerized OpenWrt owns the uplink).
 *   2. Else the WIREGUARD_HOME_ENDPOINT_HOST config fallback (single-box: the
 *      OpenWrt container does NOT own WAN — "WAN handled by host" — so the
 *      summary's wan is present:false and an operator can pin the host IP).
 *   3. Else null — an HONEST "not discovered". Never a wrong guess. The route
 *      surfaces this as a clear error rather than minting a dead conf.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pickHomeEndpointFromSummary,
  pickHomeEndpoint,
  fetchBridgeUplinkIp,
} from "../lib/vpn-home-endpoint.js";
import { config } from "../config.js";
import type { NetworkSummary } from "../types/network.js";

function summaryWithWan(wan: Partial<NetworkSummary["wan"]>): NetworkSummary {
  return {
    system: {} as NetworkSummary["system"],
    resources: {} as NetworkSummary["resources"],
    lan: { "ipv4-address": [{ address: "192.168.20.1", mask: 24 }] } as NetworkSummary["lan"],
    wan: {
      up: true,
      present: true,
      pending: false,
      available: true,
      autostart: true,
      device: "eth0",
      proto: "dhcp",
      uptime: 100,
      l3_device: "eth0",
      "ipv4-address": [],
      "ipv6-address": [],
      route: [],
      "dns-server": [],
      data: {},
      ...wan,
    } as NetworkSummary["wan"],
    wireless: {} as NetworkSummary["wireless"],
    dhcp_leases: [],
    firewall_zones: {},
  };
}

describe("pickHomeEndpointFromSummary", () => {
  it("returns the WAN IPv4 address when the summary exposes one", () => {
    const summary = summaryWithWan({
      "ipv4-address": [{ address: "192.168.1.87", mask: 24 }],
    });
    expect(pickHomeEndpointFromSummary(summary, "10.9.9.9")).toBe("192.168.1.87");
  });

  it("falls back to the config value when WAN has no IPv4 address (single-box)", () => {
    // Single-box: WAN handled by the host, so the container reports present:false.
    const summary = summaryWithWan({ present: false, "ipv4-address": [] });
    expect(pickHomeEndpointFromSummary(summary, "192.168.1.87")).toBe("192.168.1.87");
  });

  it("returns null (never a guess) when neither WAN nor a config fallback is available", () => {
    const summary = summaryWithWan({ present: false, "ipv4-address": [] });
    expect(pickHomeEndpointFromSummary(summary, "")).toBeNull();
  });

  it("returns null when the summary itself is null and no config fallback", () => {
    expect(pickHomeEndpointFromSummary(null, "")).toBeNull();
  });

  it("uses the config fallback when the summary is null but a fallback is set", () => {
    expect(pickHomeEndpointFromSummary(null, "192.168.1.50")).toBe("192.168.1.50");
  });

  it("ignores a non-routable WAN placeholder like 0.0.0.0 and falls back", () => {
    const summary = summaryWithWan({
      "ipv4-address": [{ address: "0.0.0.0", mask: 0 }],
    });
    expect(pickHomeEndpointFromSummary(summary, "192.168.1.87")).toBe("192.168.1.87");
  });
});

/**
 * Single-box host-uplink probe (VPN home-mode P1.5).
 *
 * On single-box the WAN is HOST-owned, so the routing summary reports
 * wan.present:false and pickHomeEndpointFromSummary(summary, "") is null. The
 * host device-bridge — which runs in the host network namespace — exposes
 * GET /host/uplink-ip; fetchBridgeUplinkIp() queries it as the discovery tier
 * BELOW the summary and ABOVE null. Best-effort: any transport/status failure
 * degrades to null (the route renders that honestly), never throws.
 */
describe("fetchBridgeUplinkIp", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    // config.DEVICE_BRIDGE_URL is frozen at module load, so we assert against
    // the resolved config value rather than overriding it per-test. Only the
    // auth token (read from process.env at call time) is stubbed here.
    process.env.BRIDGE_AUTH_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...OLD_ENV };
  });

  it("returns the uplinkIp the bridge reports", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ uplinkIp: "192.168.1.87" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBridgeUplinkIp()).resolves.toBe("192.168.1.87");
    // Auth-gated GET to the bridge's uplink-ip route with the shared token.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${config.DEVICE_BRIDGE_URL}/host/uplink-ip`);
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe(
      "test-token",
    );
  });

  it("returns null when the bridge honestly reports uplinkIp:null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ uplinkIp: null }), { status: 200 }),
      ),
    );
    await expect(fetchBridgeUplinkIp()).resolves.toBeNull();
  });

  it("returns null (never throws) when the bridge is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("fetch failed");
        (err as { cause?: { code?: string } }).cause = { code: "ECONNREFUSED" };
        throw err;
      }),
    );
    await expect(fetchBridgeUplinkIp()).resolves.toBeNull();
  });

  it("returns null when the bridge answers with a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    await expect(fetchBridgeUplinkIp()).resolves.toBeNull();
  });

  it("returns null when the bridge auth token is not configured", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchBridgeUplinkIp()).resolves.toBeNull();
    // No token → never hit the wire (mirrors the .env write-back persisters).
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters a placeholder the bridge should never emit (defence in depth)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ uplinkIp: "0.0.0.0" }), { status: 200 }),
      ),
    );
    await expect(fetchBridgeUplinkIp()).resolves.toBeNull();
  });
});

/**
 * Full home-endpoint precedence: env fallback (WIREGUARD_HOME_ENDPOINT_HOST) and
 * the routing summary are resolved by pickHomeEndpointFromSummary (the #897
 * behaviour is unchanged); the NEW single-box bridge uplink-ip is the tier BELOW
 * both of those and ABOVE a null "not discovered". pickHomeEndpoint composes the
 * three inputs deterministically so the route just wires the async fetches to it.
 */
describe("pickHomeEndpoint precedence (env/summary > bridge > null)", () => {
  const wanSummary = summaryWithWan({
    "ipv4-address": [{ address: "192.168.1.50", mask: 24 }],
  });
  const singleBoxSummary = summaryWithWan({ present: false, "ipv4-address": [] });

  it("prefers the explicit env fallback over the bridge", () => {
    expect(
      pickHomeEndpoint({
        envFallback: "192.168.1.9",
        summary: singleBoxSummary,
        bridgeIp: "192.168.1.87",
      }),
    ).toBe("192.168.1.9");
  });

  it("prefers the routing summary WAN IP over the bridge", () => {
    expect(
      pickHomeEndpoint({
        envFallback: "",
        summary: wanSummary,
        bridgeIp: "192.168.1.87",
      }),
    ).toBe("192.168.1.50");
  });

  it("falls back to the bridge uplink-ip on single-box (no env, no summary WAN)", () => {
    expect(
      pickHomeEndpoint({
        envFallback: "",
        summary: singleBoxSummary,
        bridgeIp: "192.168.1.87",
      }),
    ).toBe("192.168.1.87");
  });

  it("falls back to the bridge when the summary itself is unavailable (null)", () => {
    expect(
      pickHomeEndpoint({ envFallback: "", summary: null, bridgeIp: "192.168.1.87" }),
    ).toBe("192.168.1.87");
  });

  it("returns null (honest) when env, summary AND bridge all come up empty", () => {
    expect(
      pickHomeEndpoint({ envFallback: "", summary: singleBoxSummary, bridgeIp: null }),
    ).toBeNull();
  });

  it("ignores a placeholder bridge IP and returns null", () => {
    expect(
      pickHomeEndpoint({
        envFallback: "",
        summary: singleBoxSummary,
        bridgeIp: "127.0.0.1",
      }),
    ).toBeNull();
  });
});

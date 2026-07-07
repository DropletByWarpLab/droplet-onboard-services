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

import { describe, it, expect } from "vitest";
import { pickHomeEndpointFromSummary } from "../lib/vpn-home-endpoint.js";
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

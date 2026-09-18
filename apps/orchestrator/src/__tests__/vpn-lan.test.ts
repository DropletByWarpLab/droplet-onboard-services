/**
 * WARP-2692 — the LAN a peer conf routes is the ROUTER's LAN, not an env pin.
 *
 * The failure this guards: a tunnel that handshakes (wg show agrees) and
 * carries nothing, because the conf routed the single-box container LAN
 * (192.168.20.0/24) while the box sat behind an edge router on 192.168.9.0/24.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    WIREGUARD_LAN_CIDR: "192.168.50.0/24",
    WIREGUARD_DNS: "192.168.50.1",
    WIREGUARD_HOME_ALLOWED_IPS: "192.168.20.0/24",
    WIREGUARD_HOME_DNS: "192.168.20.1",
  },
}));

vi.mock("../services/openwrt.client.js", () => ({
  fetchNetworkSummary: vi.fn(),
}));

import { lanCidrFromAddress, pickVpnLanRouting, resolveVpnLanRouting } from "../lib/vpn-lan.js";
import * as openwrt from "../services/openwrt.client.js";

function summaryWithLan(lan: unknown) {
  return { lan } as any;
}

describe("lanCidrFromAddress", () => {
  it("masks the router's LAN address down to its network", () => {
    expect(lanCidrFromAddress("192.168.9.1", 24)).toBe("192.168.9.0/24");
    expect(lanCidrFromAddress("10.20.33.7", 16)).toBe("10.20.0.0/16");
    expect(lanCidrFromAddress("172.16.5.129", 25)).toBe("172.16.5.128/25");
  });

  it.each([
    ["a malformed literal", "192.168.9", 24],
    ["an out-of-range octet", "192.168.999.1", 24],
    ["a /32 (not a LAN)", "192.168.9.1", 32],
    ["a /0", "192.168.9.1", 0],
    ["the unspecified address", "0.0.0.0", 24],
    ["loopback", "127.0.0.1", 8],
    ["link-local (no DHCP lease)", "169.254.10.4", 16],
  ])("refuses %s", (_label, address, mask) => {
    expect(lanCidrFromAddress(address, mask)).toBeNull();
  });
});

describe("pickVpnLanRouting", () => {
  it("derives every routing fact from the router's LAN address (edge-router shape)", () => {
    const routing = pickVpnLanRouting(
      summaryWithLan({ present: true, "ipv4-address": [{ address: "192.168.9.1", mask: 24 }] }),
    );
    expect(routing).toEqual({
      lanCidr: "192.168.9.0/24",
      dns: "192.168.9.1",
      homeAllowedIps: "192.168.9.0/24",
      homeDns: "192.168.9.1",
      source: "router",
    });
  });

  it("agrees with the historical single-box pins on the container shape", () => {
    // The env pins were right for THIS shape; the derivation must not change
    // what a container-terminated box hands out.
    const routing = pickVpnLanRouting(
      summaryWithLan({ present: true, "ipv4-address": [{ address: "192.168.20.1", mask: 24 }] }),
    );
    expect(routing.lanCidr).toBe("192.168.20.0/24");
    expect(routing.dns).toBe("192.168.20.1");
    expect(routing.source).toBe("router");
  });

  it("skips a placeholder address and takes the first usable one", () => {
    const routing = pickVpnLanRouting(
      summaryWithLan({
        present: true,
        "ipv4-address": [
          { address: "0.0.0.0", mask: 24 },
          { address: "192.168.9.1", mask: 24 },
        ],
      }),
    );
    expect(routing.lanCidr).toBe("192.168.9.0/24");
  });

  it.each([
    ["no summary at all", null],
    ["a LAN the router reports absent", summaryWithLan({ present: false, "ipv4-address": [] })],
    ["a LAN with no IPv4 address yet", summaryWithLan({ present: true, "ipv4-address": [] })],
    ["a LAN with only a placeholder", summaryWithLan({ present: true, "ipv4-address": [{ address: "0.0.0.0", mask: 24 }] })],
    ["a summary with no lan key (older routing build)", {} as any],
  ])("falls back to env for %s", (_label, summary) => {
    expect(pickVpnLanRouting(summary)).toEqual({
      lanCidr: "192.168.50.0/24",
      dns: "192.168.50.1",
      homeAllowedIps: "192.168.20.0/24",
      homeDns: "192.168.20.1",
      source: "env",
    });
  });
});

describe("resolveVpnLanRouting", () => {
  it("reads the router and reports source=router", async () => {
    (openwrt.fetchNetworkSummary as any).mockResolvedValueOnce(
      summaryWithLan({ present: true, "ipv4-address": [{ address: "192.168.9.1", mask: 24 }] }),
    );
    const routing = await resolveVpnLanRouting();
    expect(routing.source).toBe("router");
    expect(routing.lanCidr).toBe("192.168.9.0/24");
  });

  it("never throws — a routing-service fault degrades to env", async () => {
    (openwrt.fetchNetworkSummary as any).mockRejectedValueOnce(new Error("routing down"));
    const routing = await resolveVpnLanRouting();
    expect(routing.source).toBe("env");
    expect(routing.lanCidr).toBe("192.168.50.0/24");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config BEFORE importing the helper so the env-validated `config` object
// is the test fixture, not the production zod-validated one (same pattern as
// trusted-origin.test.ts).
vi.mock("../config.js", () => ({
  config: {
    REMOTE_ACCESS_MODE: "fqdn",
    DROPLET_PUBLIC_FQDN: "",
    WIREGUARD_ENDPOINT_HOST: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { computeOffLanReachable, isLanOnlyHost } from "./remote-access.js";
import { config } from "../config.js";

type MutableConfig = {
  REMOTE_ACCESS_MODE: string;
  DROPLET_PUBLIC_FQDN: string;
  WIREGUARD_ENDPOINT_HOST: string;
};

beforeEach(() => {
  vi.clearAllMocks();
  (config as MutableConfig).REMOTE_ACCESS_MODE = "fqdn";
  (config as MutableConfig).DROPLET_PUBLIC_FQDN = "";
  (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "";
});

// ── isLanOnlyHost: the pure literal classifier (no DNS, no I/O) ──
describe("isLanOnlyHost", () => {
  it("classifies RFC1918 IPv4 literals as LAN-only", () => {
    expect(isLanOnlyHost("192.168.50.1")).toBe(true);
    expect(isLanOnlyHost("192.168.1.87")).toBe(true);
    expect(isLanOnlyHost("10.13.13.1")).toBe(true);
    expect(isLanOnlyHost("172.16.0.1")).toBe(true);
    expect(isLanOnlyHost("172.31.255.254")).toBe(true);
  });

  it("does NOT classify public IPv4 literals as LAN-only", () => {
    expect(isLanOnlyHost("203.0.113.7")).toBe(false);
    expect(isLanOnlyHost("8.8.8.8")).toBe(false);
    // 172.32.x is OUTSIDE the 172.16.0.0/12 private block — regex edge.
    expect(isLanOnlyHost("172.32.0.1")).toBe(false);
    // 172.15.x is BELOW the block.
    expect(isLanOnlyHost("172.15.0.1")).toBe(false);
  });

  it("classifies CGNAT 100.64.0.0/10 literals as LAN-only (not publicly routable)", () => {
    // RFC 6598 shared address space: carrier-grade NAT. A conf minted against
    // one of these is not reachable from the public internet, so it must never
    // light up the "from anywhere" copy.
    expect(isLanOnlyHost("100.64.0.1")).toBe(true);
    expect(isLanOnlyHost("100.100.100.100")).toBe(true);
    expect(isLanOnlyHost("100.127.255.254")).toBe(true);
    // Just OUTSIDE the /10: 100.63.x is public, 100.128.x is public.
    expect(isLanOnlyHost("100.63.255.255")).toBe(false);
    expect(isLanOnlyHost("100.128.0.1")).toBe(false);
  });

  it("classifies IPv4 strings with out-of-range octets as non-routable (never public)", () => {
    // A malformed literal like "999.1.1.1" passes the 4-part shape but is not a
    // valid address. It must be rejected as non-routable rather than falling
    // through to publicly-routable and dishonestly lighting up "from anywhere".
    expect(isLanOnlyHost("999.1.1.1")).toBe(true);
    expect(isLanOnlyHost("256.256.256.256")).toBe(true);
    expect(isLanOnlyHost("203.0.113.300")).toBe(true);
    // A genuinely in-range public literal is still public (guard the boundary).
    expect(isLanOnlyHost("203.0.113.255")).toBe(false);
  });

  it("classifies loopback, link-local, and unspecified addresses as LAN-only", () => {
    expect(isLanOnlyHost("127.0.0.1")).toBe(true);
    expect(isLanOnlyHost("169.254.10.10")).toBe(true);
    expect(isLanOnlyHost("0.0.0.0")).toBe(true);
    expect(isLanOnlyHost("localhost")).toBe(true);
    expect(isLanOnlyHost("::1")).toBe(true);
  });

  it("classifies IPv6 unique-local and link-local literals as LAN-only", () => {
    expect(isLanOnlyHost("fd00::1")).toBe(true);
    expect(isLanOnlyHost("fc00::1")).toBe(true);
    expect(isLanOnlyHost("fe80::1")).toBe(true);
    // Global unicast is not LAN-only.
    expect(isLanOnlyHost("2001:db8::1")).toBe(false);
  });

  it("classifies mDNS/LAN-suffix hostnames as LAN-only", () => {
    expect(isLanOnlyHost("droplet.local")).toBe(true);
    expect(isLanOnlyHost("droplet.lan")).toBe(true);
    expect(isLanOnlyHost("box.internal")).toBe(true);
    expect(isLanOnlyHost("box.home.arpa")).toBe(true);
    expect(isLanOnlyHost("DROPLET.LOCAL")).toBe(true);
  });

  it("does NOT classify public DNS names as LAN-only", () => {
    expect(isLanOnlyHost("vpn.example.com")).toBe(false);
    expect(isLanOnlyHost("home.droplet-us.com")).toBe(false);
    // ".localstuff.com" must not be caught by the ".local" suffix check.
    expect(isLanOnlyHost("my.localstuff.com")).toBe(false);
  });

  it("treats an empty/whitespace host as LAN-only (nothing to reach)", () => {
    expect(isLanOnlyHost("")).toBe(true);
    expect(isLanOnlyHost("   ")).toBe(true);
  });
});

// ── computeOffLanReachable: mirrors resolveEndpointHost() priority ──
describe("computeOffLanReachable", () => {
  it("is false with nothing configured", () => {
    expect(computeOffLanReachable()).toBe(false);
  });

  it("is false when only the split-horizon FQDN is set (ADR-023: no public A record)", () => {
    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
    expect(computeOffLanReachable()).toBe(false);
  });

  it("is false when the FQDN is set even alongside a public endpoint override (FQDN-first minting)", () => {
    // resolveEndpointHost() is FQDN-first, so the minted conf points at the
    // FQDN — which is not publicly resolvable. The boolean must reflect the
    // conf that is actually handed out.
    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "203.0.113.7";
    expect(computeOffLanReachable()).toBe(false);
  });

  it("is true when the operator override is a publicly-routable host and no FQDN is set", () => {
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "vpn.example.com";
    expect(computeOffLanReachable()).toBe(true);
  });

  it("is true when the operator override is a public IP literal", () => {
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "203.0.113.7";
    expect(computeOffLanReachable()).toBe(true);
  });

  it("is false when the operator override is a LAN-only literal (inside-LAN testing value)", () => {
    // config.ts documents setting WIREGUARD_ENDPOINT_HOST=192.168.50.1 for
    // inside-LAN testing — that must never light up the "from anywhere" copy.
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "192.168.50.1";
    expect(computeOffLanReachable()).toBe(false);
  });

  it("is true in relay mode once an endpoint is configured (ADR-025)", () => {
    // The relay makes the named FQDN routable from anywhere. Once the box has
    // its FQDN (or an operator override), the conf is off-LAN reachable.
    (config as MutableConfig).REMOTE_ACCESS_MODE = "relay";
    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
    expect(computeOffLanReachable()).toBe(true);

    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "";
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "203.0.113.7";
    expect(computeOffLanReachable()).toBe(true);
  });

  it("is false in relay mode when NO endpoint is configured at all", () => {
    // endpointConfigured:false must never pair with offLanReachable:true — there
    // is no address to hand out, so the relay has nothing to make routable.
    (config as MutableConfig).REMOTE_ACCESS_MODE = "relay";
    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "";
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "";
    expect(computeOffLanReachable()).toBe(false);
  });

  it("is false in relay mode when the only endpoint override is a LAN-only literal", () => {
    // A relay cannot make a private literal routable — the conf still points at
    // an unreachable inside-LAN address.
    (config as MutableConfig).REMOTE_ACCESS_MODE = "relay";
    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "";
    (config as MutableConfig).WIREGUARD_ENDPOINT_HOST = "192.168.50.1";
    expect(computeOffLanReachable()).toBe(false);
  });
});

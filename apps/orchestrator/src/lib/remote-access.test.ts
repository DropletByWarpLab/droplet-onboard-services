import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config BEFORE importing the helper so the env-validated `config` object
// is the test fixture, not the production zod-validated one (same pattern as
// trusted-origin.test.ts).
vi.mock("../config.js", () => ({
  config: {
    REMOTE_ACCESS_MODE: "fqdn",
    DROPLET_PUBLIC_FQDN: "",
    WIREGUARD_ENDPOINT_HOST: "",
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

  it("is true in relay mode regardless of endpoint envs (ADR-025)", () => {
    (config as MutableConfig).REMOTE_ACCESS_MODE = "relay";
    expect(computeOffLanReachable()).toBe(true);

    (config as MutableConfig).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
    expect(computeOffLanReachable()).toBe(true);
  });
});

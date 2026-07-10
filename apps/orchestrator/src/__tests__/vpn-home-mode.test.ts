/**
 * Home-mode WireGuard peer rendering (hybrid remote-access P1).
 *
 * These are pure-function tests for `renderPeerConf` — no HTTP, no Prisma. They
 * pin the two shapes the hybrid design mints:
 *
 *   - AWAY (default, unchanged): Endpoint = resolved public host, split-tunnel
 *     AllowedIPs = <lanCidr>, <vpnSubnet>. This is the pre-existing behavior and
 *     must stay byte-identical (regression guard).
 *   - HOME (new): the client dials the box DIRECTLY at its home-facing LAN IP,
 *     resolves the per-device FQDN over the tunnel via the box's split-horizon
 *     resolver (192.168.20.1 single-box, ADR-023 §3.4), and routes ONLY the box
 *     subnets (split-tunnel to the box — never 0.0.0.0/0).
 */

import { describe, it, expect } from "vitest";
import { renderPeerConf } from "../services/vpn.service.js";

const base = {
  privateKey: "PEERPRIV=",
  peerIp: "10.13.13.2",
  serverPublicKey: "SERVERPUB=",
  listenPort: 51820,
  lanCidr: "192.168.50.0/24",
  vpnSubnet: "10.13.13.0/24",
};

describe("renderPeerConf — away mode (regression)", () => {
  it("is byte-identical to the pre-mode conf when mode is omitted", () => {
    const conf = renderPeerConf({
      ...base,
      dns: "192.168.50.1",
      endpointHost: "vpn.example.com",
    });
    expect(conf).toBe(
      [
        "[Interface]",
        "PrivateKey = PEERPRIV=",
        "Address = 10.13.13.2/32",
        "DNS = 192.168.50.1",
        "",
        "[Peer]",
        "PublicKey = SERVERPUB=",
        "Endpoint = vpn.example.com:51820",
        "AllowedIPs = 192.168.50.0/24, 10.13.13.0/24",
        "PersistentKeepalive = 25",
        "",
      ].join("\n"),
    );
  });

  it("is byte-identical when mode is explicitly 'away'", () => {
    const omitted = renderPeerConf({ ...base, dns: "192.168.50.1", endpointHost: "vpn.example.com" });
    const explicit = renderPeerConf({
      ...base,
      dns: "192.168.50.1",
      endpointHost: "vpn.example.com",
      mode: "away",
    });
    expect(explicit).toBe(omitted);
  });
});

describe("renderPeerConf — home mode", () => {
  it("points Endpoint at the box's home-facing LAN IP", () => {
    const conf = renderPeerConf({
      ...base,
      mode: "home",
      dns: "192.168.20.1",
      endpointHost: "192.168.1.87",
      homeAllowedIps: "192.168.20.0/24",
    });
    expect(conf).toContain("Endpoint = 192.168.1.87:51820");
  });

  it("uses the split-horizon resolver (192.168.20.1) for DNS", () => {
    const conf = renderPeerConf({
      ...base,
      mode: "home",
      dns: "192.168.20.1",
      endpointHost: "192.168.1.87",
      homeAllowedIps: "192.168.20.0/24",
    });
    expect(conf).toContain("DNS = 192.168.20.1");
  });

  it("is split-tunnel to the box subnets — the box subnet + the VPN subnet, NEVER 0.0.0.0/0", () => {
    const conf = renderPeerConf({
      ...base,
      mode: "home",
      dns: "192.168.20.1",
      endpointHost: "192.168.1.87",
      homeAllowedIps: "192.168.20.0/24",
    });
    expect(conf).toContain("AllowedIPs = 192.168.20.0/24, 10.13.13.0/24");
    expect(conf).not.toContain("0.0.0.0/0");
    // Home mode must NOT leak the away-mode LAN CIDR default.
    expect(conf).not.toContain("192.168.50.0/24");
  });

  it("honors a multi-subnet home AllowedIPs override and always appends the VPN subnet", () => {
    const conf = renderPeerConf({
      ...base,
      mode: "home",
      dns: "192.168.20.1",
      endpointHost: "192.168.1.87",
      homeAllowedIps: "192.168.20.0/24, 192.168.10.0/24",
    });
    expect(conf).toContain("AllowedIPs = 192.168.20.0/24, 192.168.10.0/24, 10.13.13.0/24");
  });
});

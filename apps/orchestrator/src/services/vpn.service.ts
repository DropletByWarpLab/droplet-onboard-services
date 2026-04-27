/**
 * VPN service — IP allocation + .conf rendering for Remote Access peers.
 *
 * Stateless helpers; persistence lives in Prisma (`VpnPeer` model) and the
 * router-side state is owned by services/routing. This module is the seam
 * between them: it converts a "this user wants a peer" request into the
 * concrete (private_key, public_key, assigned_ip, .conf text) tuple the
 * route handler returns.
 */

import type { PrismaClient } from "@prisma/client";

export class VpnIpExhaustedError extends Error {
  constructor(subnet: string) {
    super(`VPN subnet ${subnet} has no free addresses left`);
    this.name = "VpnIpExhaustedError";
  }
}

export class VpnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VpnConfigError";
  }
}

/**
 * Parse a CIDR like "10.13.13.0/24" into its start/end host range.
 *
 * Returns the range usable for peers — the network and broadcast addresses
 * are already excluded, AND the server's own address (first usable host) is
 * reserved. So for "10.13.13.0/24" with server at .1 we return .2 .. .254.
 *
 * Only IPv4 /24..32 is supported. Anything else throws — VPN subnets in this
 * project are explicitly /24 (10.13.13.0/24); we don't need general CIDR math.
 */
export function parseVpnSubnet(cidr: string): {
  network: string;
  serverIp: string;
  firstPeer: number;
  lastPeer: number;
  prefix: string; // "10.13.13"
} {
  const [base, maskStr] = cidr.split("/");
  const mask = Number(maskStr);
  if (!base || !Number.isInteger(mask) || mask < 24 || mask > 30) {
    throw new VpnConfigError(`Unsupported VPN subnet ${cidr} — expected IPv4 /24..30`);
  }
  const octets = base.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    throw new VpnConfigError(`Invalid VPN subnet ${cidr}`);
  }
  if (mask !== 24) {
    // We only allocate inside the last octet today. /24 is the entire range.
    throw new VpnConfigError(`Only /24 supported in v1; got /${mask}`);
  }
  const prefix = octets.slice(0, 3).join(".");
  return {
    network: cidr,
    serverIp: `${prefix}.1`,
    firstPeer: 2,
    lastPeer: 254,
    prefix,
  };
}

/**
 * Allocate the lowest free peer IP. Skips IPs reserved by `active` VpnPeer
 * rows; revoked rows free their IP for re-allocation.
 *
 * NOT atomic on its own — two concurrent calls could pick the same IP. The
 * route handler relies on `assignedIp`'s uniqueness within active rows: an
 * INSERT with a duplicate IP fails on the publicKey unique constraint
 * elsewhere, but to be safe we wrap allocation + insert in a transaction
 * and retry once on conflict. See route handler.
 */
export async function allocatePeerIp(
  prisma: PrismaClient,
  subnet: string,
): Promise<string> {
  const { prefix, firstPeer, lastPeer } = parseVpnSubnet(subnet);

  const taken = await prisma.vpnPeer.findMany({
    where: { status: "active", assignedIp: { startsWith: `${prefix}.` } },
    select: { assignedIp: true },
  });
  const takenSet = new Set(taken.map((p) => p.assignedIp));

  for (let host = firstPeer; host <= lastPeer; host++) {
    const candidate = `${prefix}.${host}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new VpnIpExhaustedError(subnet);
}

/**
 * Render a peer .conf file the user can paste into a WireGuard client.
 *
 * The Endpoint field is the value of `endpointHost`:`listenPort`. If the
 * caller set `endpointHost` to a placeholder string, the route handler
 * surfaces a warning to the dashboard so the user knows to configure
 * WIREGUARD_ENDPOINT_HOST before sharing the QR.
 */
export function renderPeerConf(opts: {
  privateKey: string;
  peerIp: string;
  dns: string;
  serverPublicKey: string;
  endpointHost: string;
  listenPort: number;
  lanCidr: string;
  vpnSubnet: string;
}): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${opts.privateKey}`,
    `Address = ${opts.peerIp}/32`,
    `DNS = ${opts.dns}`,
    "",
    "[Peer]",
    `PublicKey = ${opts.serverPublicKey}`,
    `Endpoint = ${opts.endpointHost}:${opts.listenPort}`,
    `AllowedIPs = ${opts.lanCidr}, ${opts.vpnSubnet}`,
    "PersistentKeepalive = 25",
    "",
  ];
  return lines.join("\n");
}

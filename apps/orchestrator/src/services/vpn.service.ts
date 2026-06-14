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
 * route handler's `allocateMintAndPersistPeer` loop relies on the partial
 * unique index on (assignedIp) WHERE status = 'active' (WARP-565): the losing
 * INSERT fails with P2002, which the loop catches and re-allocates against the
 * now-updated taken set. This bare helper is the per-attempt allocation step.
 */
export async function allocatePeerIp(
  prisma: VpnPeerStore,
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

// Narrow structural type for the Prisma surface the allocator reads. Lets
// allocatePeerIp / the persist loop accept either the real PrismaClient or the
// interactive-transaction client `tx` (same model delegates) without a cast.
type VpnPeerStore = {
  vpnPeer: {
    findMany: PrismaClient["vpnPeer"]["findMany"];
    create: PrismaClient["vpnPeer"]["create"];
  };
};

// The Prisma surface allocateMintAndPersistPeer needs: the outer client for
// the read-only allocate (findMany) + interactive $transaction. The real
// PrismaClient satisfies this; the unit test double provides the same shape.
type VpnTxClient = Pick<PrismaClient, "$transaction"> & VpnPeerStore;

/**
 * Prisma unique-constraint violation (P2002) — duck-typed rather than
 * `instanceof Prisma.PrismaClientKnownRequestError` so the unit tests' plain
 * thrown objects behave like the real client error. Mirrors reset.service.ts.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Is this P2002 the active-IP race (retryable) rather than the publicKey clash?
 *
 * Both surface as P2002. Prisma reports the offending field(s) in `meta.target`
 * (the index name / column list). The publicKey clash means routing minted a
 * pubkey we already hold — a genuine persist failure that must NOT be retried
 * (it would just re-mint and clash again). The assignedIp clash is the WARP-565
 * allocation race we want to re-allocate around. When `meta.target` is absent
 * (older Prisma / bare test errors) we conservatively treat it as the IP race,
 * since the publicKey path has its own explicit pre-seed in the rollback test.
 */
export function isActiveIpViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const target = (err as { meta?: { target?: unknown } })?.meta?.target;
  const mentions = (needle: string) =>
    Array.isArray(target)
      ? target.some((t) => typeof t === "string" && t.includes(needle))
      : typeof target === "string" && target.includes(needle);
  if (mentions("publicKey")) return false;
  if (mentions("assignedIp")) return true;
  return target === undefined; // unannotated P2002 → assume the IP race
}

/**
 * Allocate the next free IP, mint the router-side peer with it, then persist —
 * retrying the WHOLE sequence on the active-IP unique conflict (WARP-565).
 *
 * Why retry the whole sequence and not just the DB write? The router peer is
 * installed with `AllowedIPs = <peerIp>/32`, so a re-allocated IP needs a
 * re-mint. `mint` (an external HTTP call) therefore stays OUT of the DB
 * transaction; only the create runs inside `$transaction`. Whenever a persist
 * attempt fails — retryable IP race OR a terminal error like a publicKey clash
 * — `rollbackMint` tears down that attempt's router peer so we never leak an
 * orphan peer pinned to an IP we didn't keep. This generalizes (and preserves)
 * the pre-WARP-565 single-shot rollback the route already did.
 *
 * Bounded retry: contention is a handful of concurrent setup calls, not a
 * herd, so a small fixed budget suffices. After `maxRetries` exhausted active-
 * IP conflicts the last error propagates (route surfaces it as a 500).
 */
export async function allocateMintAndPersistPeer<TMint extends { public_key: string }>(
  prisma: VpnTxClient,
  subnet: string,
  deps: {
    deviceLabel: string;
    userId: string;
    mint: (peerIp: string) => Promise<TMint>;
    rollbackMint: (minted: TMint) => Promise<void>;
  },
  maxRetries = 3,
): Promise<{
  peerIp: string;
  minted: TMint;
  saved: Awaited<ReturnType<PrismaClient["vpnPeer"]["create"]>>;
}> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Allocate the candidate IP, then mint the router peer pinned to it. The
    // mint is an external HTTP call, so it stays OUT of the DB transaction.
    const peerIp = await allocatePeerIp(prisma, subnet);
    const minted = await deps.mint(peerIp);
    try {
      // Persist inside a transaction. The partial unique index on (assignedIp)
      // WHERE status = 'active' is the real authority: if a concurrent setup
      // claimed this IP between our allocate above and this insert, the INSERT
      // fails P2002 and the catch re-runs the loop, re-allocating against the
      // now-updated taken set on the next pass.
      const saved = await prisma.$transaction((tx) =>
        tx.vpnPeer.create({
          data: {
            userId: deps.userId,
            deviceLabel: deps.deviceLabel,
            publicKey: minted.public_key,
            assignedIp: peerIp,
          },
        }),
      );
      return { peerIp, minted, saved };
    } catch (err) {
      // Always roll back THIS attempt's router peer — it was minted with an IP
      // we failed to persist, retryable or not, so it must not linger.
      try {
        await deps.rollbackMint(minted);
      } catch {
        // rollbackMint logs internally; swallow so the original error wins.
      }
      if (isActiveIpViolation(err) && attempt < maxRetries) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

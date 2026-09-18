/**
 * vpn-lan.ts — WARP-2692. Which LAN a tunnel client should route to the box.
 *
 * A peer .conf carries two facts about the LAN behind the tunnel: the
 * `AllowedIPs` subnet a client routes over it, and the `DNS` resolver it asks.
 * Until now both came from env (`WIREGUARD_LAN_CIDR` / `WIREGUARD_DNS` and the
 * home-mode pair), and `scripts/lib/single-box.sh` upserts those to the
 * single-box container LAN (192.168.20.0/24) on EVERY provision. That is right
 * for a box whose tunnel terminates in the bundled `droplet-openwrt` container
 * and wrong for one whose `OPENWRT_HOST` is a real edge router: measured on the
 * house unit 2026-09-03, the router's LAN is 192.168.9.0/24, the issued conf
 * routed 192.168.20.0/24, and a tunnel that handshook perfectly (`wg show`
 * confirmed) could reach nothing — the client never sent the box's address
 * into it. The env pins could not be fixed in place because the next
 * provision writes them back.
 *
 * So the LAN facts are DERIVED from the router that terminates the tunnel —
 * the same routing-service network summary `resolveHomeEndpointHost` already
 * reads — and env is only the fallback for when that summary cannot be read.
 * The router's `lan` interface address is the LAN resolver on every shape we
 * ship (dnsmasq on the OpenWrt LAN address), and its address+mask is the
 * subnet; that holds for the container (192.168.20.1/24), multi-box
 * (192.168.50.1/24) and edge-router (192.168.9.1/24) shapes alike, which is
 * exactly why no env pin could describe all three.
 *
 * Home and away mode get the same LAN: both describe "the network the box is
 * on", they differ only in the Endpoint the client dials. The env defaults for
 * the two modes differ (192.168.50.x vs 192.168.20.x) purely as a historical
 * artefact of which shape each was written for.
 *
 * Pure `pickVpnLanRouting` for tests; `resolveVpnLanRouting` does the fetch.
 */
import type { NetworkSummary } from "../types/network.js";
import { config } from "../config.js";
import { fetchNetworkSummary } from "../services/openwrt.client.js";
import { createLogger } from "./logger.js";

const logger = createLogger("vpn-lan");

export interface VpnLanRouting {
  /** Away-mode `AllowedIPs` (the VPN subnet is appended by the renderer). */
  lanCidr: string;
  /** Away-mode `DNS`. */
  dns: string;
  /** Home-mode split-tunnel `AllowedIPs`. */
  homeAllowedIps: string;
  /** Home-mode `DNS` (the split-horizon resolver, ADR-023 §3.4). */
  homeDns: string;
  /** Where the facts came from. `env` means the router could not tell us. */
  source: "router" | "env";
}

/** The env fallback, read at call time so tests that patch `config` see it. */
function envRouting(): VpnLanRouting {
  return {
    lanCidr: config.WIREGUARD_LAN_CIDR,
    dns: config.WIREGUARD_DNS,
    homeAllowedIps: config.WIREGUARD_HOME_ALLOWED_IPS,
    homeDns: config.WIREGUARD_HOME_DNS,
    source: "env",
  };
}

function parseIpv4(addr: string): number | null {
  const parts = addr.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

function formatIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/**
 * `address/mask` → the network CIDR, e.g. 192.168.9.1/24 → 192.168.9.0/24.
 * Null for anything that is not a usable LAN: a malformed literal, a mask
 * outside 8..30 (a /31, /32 or a bare /0 is not a LAN anyone routes to), or a
 * placeholder address that cannot resolve anything (unspecified / loopback /
 * link-local).
 */
export function lanCidrFromAddress(address: string, mask: number): string | null {
  const n = parseIpv4(address);
  if (n === null) return null;
  if (!Number.isInteger(mask) || mask < 8 || mask > 30) return null;
  if (n === 0 || (n >>> 24) === 127 || (n >>> 16) === 0xa9fe) return null;
  const netmask = (0xffffffff << (32 - mask)) >>> 0;
  return `${formatIpv4((n & netmask) >>> 0)}/${mask}`;
}

/**
 * Pure core. The router's LAN wins when the summary carries a usable one;
 * anything else — no summary, `lan.present === false`, no IPv4 address, a
 * placeholder — falls back to env.
 */
export function pickVpnLanRouting(summary: NetworkSummary | null): VpnLanRouting {
  const lan = summary?.lan;
  if (!lan || lan.present === false) return envRouting();
  for (const entry of lan["ipv4-address"] ?? []) {
    if (!entry?.address) continue;
    const cidr = lanCidrFromAddress(entry.address, entry.mask);
    if (!cidr) continue;
    return {
      lanCidr: cidr,
      dns: entry.address,
      homeAllowedIps: cidr,
      homeDns: entry.address,
      source: "router",
    };
  }
  return envRouting();
}

/**
 * Read the router's LAN and derive the tunnel routing facts. Never throws: a
 * routing-service fault degrades to the env fallback with a warning, so a
 * mint still succeeds on the same terms it always did.
 */
export async function resolveVpnLanRouting(): Promise<VpnLanRouting> {
  let summary: NetworkSummary | null = null;
  try {
    summary = await fetchNetworkSummary();
  } catch (err) {
    logger.warn({ err }, "vpn: network summary unavailable — using env LAN routing for the peer conf");
  }
  const routing = pickVpnLanRouting(summary);
  if (routing.source === "env" && summary) {
    logger.warn(
      { lan: summary.lan },
      "vpn: router reported no usable LAN address — using env LAN routing for the peer conf",
    );
  }
  return routing;
}

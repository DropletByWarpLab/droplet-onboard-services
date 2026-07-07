/**
 * Home-mode box LAN-IP discovery (hybrid remote-access P1).
 *
 * A HOME-mode WireGuard peer dials the box DIRECTLY at its home-network-facing
 * LAN IP (no server, no public inbound — the foundation-clean path). That IP is
 * a DHCP address on the box's uplink (e.g. 192.168.1.87), so it MUST be
 * discovered at request time, never hardcoded.
 *
 * `pickHomeEndpointFromSummary` is the pure, testable core: given the
 * routing-service network summary (or null when routing is unavailable) and a
 * config fallback, it returns the home-facing IP or null.
 *
 * Precedence:
 *   1. The WAN interface's first routable IPv4 address, when the summary exposes
 *      one. This is the multi-box shape where the containerised OpenWrt owns the
 *      uplink and reports the real WAN IP.
 *   2. Else the `fallback` (WIREGUARD_HOME_ENDPOINT_HOST). On the single-box
 *      shape the OpenWrt container does NOT own WAN ("WAN handled by host"), so
 *      the summary's `wan` is present:false / has no IPv4 address; an operator
 *      can pin the host's DHCP IP here.
 *   3. Else null — an HONEST "not discovered", never a wrong guess. The route
 *      turns this into a clear error instead of minting a dead conf.
 *
 * Note: a private RFC1918 WAN IP (192.168.x, 10.x, 172.16-31.x) is EXPECTED and
 * correct for home mode — the client is on the same home network and reaches the
 * box at its LAN address. We only reject non-addresses (unspecified / loopback /
 * link-local placeholders) that could never be dialled.
 */

import type { NetworkSummary } from "../types/network.js";

/** Addresses that are never a dial-able home endpoint (placeholders/self). */
function isUsableHostIp(addr: string): boolean {
  const a = addr.trim();
  if (a === "") return false;
  if (a === "0.0.0.0") return false; // unspecified / DHCP-pending placeholder
  if (a === "127.0.0.1") return false; // loopback
  if (a.startsWith("169.254.")) return false; // link-local (no DHCP lease)
  return true;
}

/**
 * Resolve the box's home-facing LAN IP from a network summary + config
 * fallback. Returns null when no routable address is available (honest — the
 * caller surfaces it, never guesses). See module doc for precedence.
 */
export function pickHomeEndpointFromSummary(
  summary: NetworkSummary | null,
  fallback: string,
): string | null {
  const wanAddrs = summary?.wan?.["ipv4-address"] ?? [];
  for (const entry of wanAddrs) {
    if (entry?.address && isUsableHostIp(entry.address)) {
      return entry.address;
    }
  }
  const fb = fallback.trim();
  return fb !== "" ? fb : null;
}

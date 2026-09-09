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
 *
 * Single-box host-uplink probe (VPN home-mode P1.5)
 * -------------------------------------------------
 * On the single-box deployment shape the WAN uplink is HOST-owned, not inside the
 * containerised OpenWrt, so the summary's `wan` is present:false and
 * pickHomeEndpointFromSummary(summary, "") is null — the mobile home toggle would
 * stay hidden. The host device-bridge (which runs in the host network namespace)
 * exposes a READ-ONLY GET /host/uplink-ip reporting the host's default-route
 * egress source IP. `fetchBridgeUplinkIp()` queries it, and `pickHomeEndpoint()`
 * slots it in as the discovery tier BELOW the summary/env and ABOVE null:
 *
 *   1. WIREGUARD_HOME_ENDPOINT_HOST env / routing-summary WAN IP
 *      (resolved together by pickHomeEndpointFromSummary — #897 semantics).
 *   2. Else the device-bridge uplink-ip (NEW — closes the single-box gap).
 *   3. Else null — an HONEST "not discovered", never a wrong guess.
 */

import type { NetworkSummary } from "../types/network.js";
import { config } from "../config.js";
import { bridgeAuthToken, isBridgeConnectionError, isTimeoutOrAbort } from "./bridge-errors.js";
import { createLogger } from "./logger.js";

const logger = createLogger("vpn-home-endpoint");

/** Bounded so a slow/unreachable bridge never stalls /vpn/status rendering. */
const BRIDGE_UPLINK_TIMEOUT_MS = 3_000;

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

/**
 * Compose the full home-endpoint precedence from its three already-resolved
 * inputs. Pure + synchronous so the route just wires the async fetches to it:
 *
 *   env fallback / summary WAN IP  (pickHomeEndpointFromSummary — #897)
 *     → else the device-bridge uplink-ip (single-box, NEW)
 *       → else null (honest "not discovered").
 *
 * The bridge IP is placeholder-filtered here too (defence in depth — the bridge
 * already filters, but a wrong guess must never leak into a minted conf).
 */
export function pickHomeEndpoint(inputs: {
  envFallback: string;
  summary: NetworkSummary | null;
  bridgeIp: string | null;
  /**
   * WARP-2183 - did the routing summary actually READ?  Defaults true so every
   * existing caller and test keeps its meaning (`summary: null` there means "no
   * WAN", not "unreadable").
   *
   * The bridge answers with the BOX's own uplink IP, which is a usable endpoint
   * only when the box itself owns the WAN. Behind a real edge router the same
   * probe returns a router-LAN address (e.g. 192.168.9.195) that no home-mode
   * peer on the household network can dial, so minting it hands the user a conf
   * that silently never handshakes.
   *
   * A throw from the summary and a genuine `wan.present:false` both arrive here
   * as `summary === null`, so null alone cannot separate "single-box, the host
   * owns the WAN" from "shape unknown". Pass false for the latter and the
   * bridge is skipped in favour of an honest null.
   */
  summaryOk?: boolean;
}): string | null {
  const fromSummary = pickHomeEndpointFromSummary(inputs.summary, inputs.envFallback);
  if (fromSummary) return fromSummary;
  if (inputs.summaryOk === false) return null;
  const bridgeIp = (inputs.bridgeIp ?? "").trim();
  if (bridgeIp !== "" && isUsableHostIp(bridgeIp)) return bridgeIp;
  return null;
}

/**
 * Query the host device-bridge's READ-ONLY GET /host/uplink-ip for the box's
 * default-route egress source IP (the single-box home endpoint the routing
 * summary can't see). Best-effort: any failure — no auth token, bridge
 * unreachable, non-2xx, malformed body, or a placeholder IP — degrades to null,
 * never throws. The caller renders null honestly. Mirrors the bridge-caller
 * posture in hostapd-bridge.service.ts (shared token, bounded timeout).
 */
export async function fetchBridgeUplinkIp(): Promise<string | null> {
  const token = bridgeAuthToken();
  if (!token) {
    // No token → never put a request on the wire (mirrors the .env write-back
    // persisters, which fail closed rather than 401 the bridge).
    logger.debug({}, "vpn: bridge auth token not configured — skipping uplink-ip probe");
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${config.DEVICE_BRIDGE_URL}/host/uplink-ip`, {
      method: "GET",
      headers: { "X-Droplet-Auth": token },
      signal: AbortSignal.timeout(BRIDGE_UPLINK_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      // Expected on deployment shapes without the bridge, or a slow host.
      logger.debug({ err }, "vpn: device-bridge not reachable for uplink-ip probe");
    } else {
      logger.warn({ err }, "vpn: device-bridge uplink-ip probe failed");
    }
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "vpn: device-bridge uplink-ip probe non-2xx");
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { uplinkIp?: unknown };
  const ip = typeof body.uplinkIp === "string" ? body.uplinkIp.trim() : "";
  if (ip !== "" && isUsableHostIp(ip)) return ip;
  return null;
}

/**
 * WARP-1758 — the box's public UDP mapping as the outside world sees it,
 * observed from host udp/51820 by the device-bridge's STUN probe.
 *
 * Sibling of {@link fetchBridgeUplinkIp}, and the other half of the pair the
 * placement classifier compares: uplink-ip is what the box thinks its WAN
 * address is, this is what the internet says it is. Equal ⇒ the box is the edge
 * router; different ⇒ it lives behind someone else's router.
 *
 * Best-effort in exactly the same way — a missing token, an unreachable bridge,
 * a non-2xx, or a malformed body all yield null so the caller degrades to a
 * weaker but honest conclusion rather than failing. (`overlay-connect.service`
 * has its own fail-CLOSED probe for the punch path, where a missing mapping
 * means there is nothing to answer HQ with; here a null just costs a candidate.)
 *
 * Returns `<ip>:<port>`.
 */
export async function fetchBridgeStunProbe(): Promise<string | null> {
  const token = bridgeAuthToken();
  if (!token) {
    logger.debug({}, "vpn: bridge auth token not configured — skipping STUN probe");
    return null;
  }
  let res: Response;
  try {
    res = await fetch(`${config.DEVICE_BRIDGE_URL}/host/stun-probe`, {
      method: "GET",
      headers: { "X-Droplet-Auth": token },
      signal: AbortSignal.timeout(BRIDGE_UPLINK_TIMEOUT_MS),
    });
  } catch (err) {
    if (isBridgeConnectionError(err) || isTimeoutOrAbort(err)) {
      logger.debug({ err }, "vpn: device-bridge not reachable for STUN probe");
    } else {
      logger.warn({ err }, "vpn: device-bridge STUN probe failed");
    }
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "vpn: device-bridge STUN probe non-2xx");
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as {
    ip?: unknown;
    port?: unknown;
  };
  const ip = typeof body.ip === "string" ? body.ip.trim() : "";
  const port = typeof body.port === "number" ? body.port : Number(body.port);
  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `${ip}:${port}`;
}

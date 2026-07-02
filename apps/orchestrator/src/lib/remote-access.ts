/**
 * Remote-access reachability (WARP-993).
 *
 * The wizard and dashboard promise "reach this Droplet from anywhere" around
 * the minted WireGuard conf. Whether that promise is TRUE depends on what the
 * conf's `Endpoint` actually is:
 *
 *   - `DROPLET_PUBLIC_FQDN` (`<name>.droplet-us.com`) is split-horizon ONLY
 *     (ADR-023 §3): it has NO public A record, so a conf minted against it
 *     works on the home LAN but is a dead end from a coffee shop. The ADR-025
 *     HQ relay (epic WARP-974) is what will make it routable.
 *   - `WIREGUARD_ENDPOINT_HOST` is an explicit operator override. Its contract
 *     is "reachable from outside the LAN", but config.ts also documents
 *     setting it to a LAN IP for inside-LAN testing — a private literal must
 *     never light up the "from anywhere" copy.
 *
 * `computeOffLanReachable()` is the single honest answer the API exposes so
 * every surface gates its copy the same way. Deterministic v1: pure env/string
 * inspection, NO live DNS lookups in the request path.
 */

import { config } from "../config.js";

/** LAN-only hostname suffixes — names that only resolve on the home network. */
const LAN_ONLY_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa"];

/**
 * Classify a host literal (IPv4/IPv6 address or DNS name) as LAN-only.
 * Purely syntactic — no DNS resolution. Unknown shapes default to NOT
 * LAN-only; the caller decides what an operator-set public name means.
 */
export function isLanOnlyHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "") return true; // nothing to reach
  if (h === "localhost") return true;
  if (LAN_ONLY_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;

  // IPv6 literals (with or without brackets): loopback, link-local (fe80::/10),
  // unique-local (fc00::/7 → fc.. / fd..).
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true;
    if (bare.startsWith("fe80")) return true;
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
    return false;
  }

  // IPv4 literal? Private (RFC1918), loopback, link-local, unspecified.
  const octets = bare.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map((o) => Number(o));
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // unspecified
    return false;
  }

  // Anything else is a DNS name without a LAN-only suffix.
  return false;
}

/**
 * Is the WireGuard conf this box mints actually reachable from OUTSIDE the
 * home LAN? Mirrors `resolveEndpointHost()` priority (routes/vpn.ts) so the
 * boolean describes the conf that is really handed out:
 *
 *   1. Relay mode (ADR-025): the HQ relay makes the named FQDN routable from
 *      anywhere → true, regardless of endpoint envs.
 *   2. FQDN set: the conf's Endpoint is the FQDN — split-horizon only, no
 *      public A record → false (even if an operator override is ALSO set,
 *      because minting is FQDN-first and ignores the override).
 *   3. Operator override set: true only if it isn't a LAN-only literal.
 *   4. Nothing configured → false.
 */
export function computeOffLanReachable(): boolean {
  if (config.REMOTE_ACCESS_MODE === "relay") return true;
  const fqdn = (config.DROPLET_PUBLIC_FQDN ?? "").trim();
  if (fqdn !== "") return false;
  const override = (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();
  if (override === "") return false;
  return !isLanOnlyHost(override);
}

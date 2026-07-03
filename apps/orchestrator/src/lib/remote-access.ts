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

  // IPv4 literal? Private (RFC1918), loopback, link-local, unspecified, CGNAT.
  const octets = bare.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const nums = octets.map((o) => Number(o));
    // Reject out-of-range octets (>255): a malformed literal like "999.1.1.1"
    // is not publicly routable — never let it fall through to "from anywhere".
    if (nums.some((n) => n > 255)) return true;
    const [a, b] = nums;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
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
 *   1. Nothing configured (no FQDN, no override) → false in EVERY mode. There
 *      is no address to hand out, so `endpointConfigured:false` must never pair
 *      with `offLanReachable:true` — the relay has nothing to make routable.
 *   2. Relay mode (ADR-025): the HQ relay makes the named FQDN (or a public
 *      override) routable from anywhere → true. A LAN-only override literal is
 *      still unreachable even through a relay → false.
 *   3. FQDN mode + FQDN set: the conf's Endpoint is the FQDN — split-horizon
 *      only, no public A record → false (even if an operator override is ALSO
 *      set, because minting is FQDN-first and ignores the override).
 *   4. FQDN mode + operator override only: true unless it's a LAN-only literal.
 */
export function computeOffLanReachable(): boolean {
  const fqdn = (config.DROPLET_PUBLIC_FQDN ?? "").trim();
  const override = (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();

  // No endpoint at all → nothing to reach, in any mode.
  if (fqdn === "" && override === "") return false;

  if (config.REMOTE_ACCESS_MODE === "relay") {
    // The relay makes the named FQDN routable from anywhere. Mirror
    // resolveEndpointHost()'s FQDN-first priority: the FQDN is the endpoint,
    // so a set FQDN is reachable. Falling back to the override, a LAN-only
    // literal stays unreachable even through the relay.
    if (fqdn !== "") return true;
    return !isLanOnlyHost(override);
  }

  // FQDN mode: a set FQDN is split-horizon only (no public A record).
  if (fqdn !== "") return false;
  return !isLanOnlyHost(override);
}

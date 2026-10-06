/** Direct WireGuard reachability; fleet web names and relay flags are not UDP endpoints. */

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

/** Whether an explicit away endpoint is configured with a non-LAN host.
 * This is configuration inspection, not a live reachability probe. */
export function computeOffLanReachable(): boolean {
  const override = (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();
  // A fleet web name and a legacy relay flag cannot make a UDP endpoint
  // reachable. Only the explicit direct WireGuard endpoint counts here.
  return override !== "" && !isLanOnlyHost(override);
}

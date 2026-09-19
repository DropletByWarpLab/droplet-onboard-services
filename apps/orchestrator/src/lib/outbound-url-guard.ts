/**
 * WARP-2022 — the one gate a user-supplied outbound URL passes before the
 * orchestrator dials it.
 *
 * ## Why this exists
 *
 * The orchestrator sits INSIDE the box's trust boundary: it can reach the
 * LAN, the Docker network and localhost. Any feature that lets a signed-in
 * user name a URL and have the server fetch it is therefore a server-side
 * request forgery primitive — the response comes back to the caller, so it
 * is also a port scanner and an internal-content reader. CalDAV/ICS calendar
 * subscriptions were exactly that shape (`z.string().url()` and nothing
 * else) until this module.
 *
 * ## The vocabulary is deliberately the one the connectors already use
 *
 * `services/erp-connector` guards its vendor base URLs with
 * `assertSafe<Vendor>BaseUrl(raw): string` — parse, refuse a non-http(s)
 * scheme, refuse userinfo, then constrain the host. Those are ALLOWLISTS
 * (one vendor, one known hostname). This guard is the complement: the host
 * is genuinely arbitrary — a customer's own CalDAV server — so the rule is a
 * DENYLIST of the address space that is inside the boundary. Same verb, same
 * error shape, same "runs before any request object exists" placement, so
 * there is one URL-guard vocabulary in this repo rather than two.
 *
 * ## What it refuses
 *
 *   - any scheme that is not http: or https:
 *   - credentials in the authority (`http://user:pass@host/`)
 *   - loopback, RFC1918, CGNAT, link-local (incl. the 169.254.169.254 cloud
 *     metadata address), this-network, IETF-protocol, benchmarking,
 *     multicast and reserved IPv4 space
 *   - IPv6 loopback/unspecified/ULA/link-local/multicast, plus the 6to4 and
 *     NAT64 translation prefixes (which `net.BlockList` does NOT unwrap into
 *     their embedded IPv4, so they are refused wholesale)
 *   - internal name suffixes: localhost, .local, .localhost, .internal,
 *     .home.arpa
 *   - a hostname that RESOLVES into any of the above (`assertOutbound
 *     DestinationAllowed`) — a public name pointed at private space is the
 *     whole point of a DNS-rebind attack
 *
 * Obfuscated IPv4 (`http://2130706433/`, `http://0177.0.0.1/`) needs no
 * special handling: the WHATWG URL parser normalises those to dotted-quad
 * before we see the hostname. That is asserted in the tests so a future
 * parser swap cannot silently reopen it.
 *
 * ## Residual risk, stated plainly: DNS rebinding
 *
 * `assertOutboundDestinationAllowed` resolves the name and checks every
 * address, then `fetch` resolves it AGAIN when it connects. A resolver that
 * returns a public address to us and a private one to undici — a TTL-0
 * rebind — defeats the check in that window. Closing it needs a pinned-IP
 * dispatcher (connect to the vetted address, carry the original Host header
 * and SNI), which undici supports but which changes TLS verification and
 * virtual-host behaviour for every calendar source. That is deliberately out
 * of scope here and tracked separately; this guard removes the trivially
 * exploitable case (a literal, or a name whose ONLY answer is private),
 * which is what an authenticated user can actually reach for today.
 *
 * ## Fail-closed
 *
 * A name that does not resolve is REFUSED, not passed through to `fetch` to
 * fail on its own. The two are equivalent in outcome today, but "the guard
 * declined to have an opinion" is the shape that turns into a bypass the
 * next time somebody changes the resolver.
 */

import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Why a destination was refused. An explicit union, never inferred from a
 *  string match — callers that need to tell "bad scheme" from "private
 *  address" apart read this field, they do not parse the message. */
export type OutboundUrlRejection =
  | "malformed"
  | "scheme"
  | "userinfo"
  | "private_host"
  | "unresolvable"
  | "redirect";

/**
 * The ONLY string a refused destination ever surfaces.
 *
 * `POST /api/calendar/sources/:id/sync` returns the sync result to its
 * caller and the dashboard renders `lastSyncError`, so any detail in the
 * message is a probe oracle: it would tell an authenticated user whether
 * 127.0.0.1:9200 exists, which is the capability this module removes. The
 * message is therefore fixed BY CONSTRUCTION (baked into the Error, not
 * mapped by each caller) — a future caller that naively surfaces
 * `err.message` cannot reopen the oracle.
 */
export const BLOCKED_DESTINATION_MESSAGE = "blocked_destination";

/** Thrown by every entry point in this module. `reason` and `detail` are for
 *  operators and logs; `message` is the fixed, caller-safe string. */
export class OutboundUrlBlockedError extends Error {
  readonly code = "BLOCKED_DESTINATION";
  constructor(
    readonly reason: OutboundUrlRejection,
    /** Operator-facing specifics. NEVER interpolated into `message`. */
    readonly detail: string,
  ) {
    super(BLOCKED_DESTINATION_MESSAGE);
    this.name = "OutboundUrlBlockedError";
  }
}

export interface OutboundUrlGuardOptions {
  /**
   * Owner/admin escape hatch for a self-hosted CalDAV server on the box's own
   * LAN — a legitimate, first-class use case on this appliance.
   *
   * Skips the ADDRESS-RANGE rules only. The scheme and userinfo rules still
   * apply: "I trust my LAN" is not "I want the orchestrator to read
   * file:///etc/passwd".
   */
  allowPrivateHost?: boolean;
}

/** Address space the orchestrator must never be steered into. Built once. */
const BLOCKED_RANGES = (() => {
  const list = new BlockList();
  // IPv4 — RFC 5735 / 6598 special-purpose space plus the private ranges.
  list.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
  list.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918
  list.addSubnet("100.64.0.0", 10, "ipv4"); // RFC6598 CGNAT
  list.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  list.addSubnet("169.254.0.0", 16, "ipv4"); // link-local — incl. 169.254.169.254
  list.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918
  list.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
  list.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918
  list.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  list.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  list.addSubnet("240.0.0.0", 4, "ipv4"); // reserved — incl. 255.255.255.255
  // IPv6. BlockList already maps ::ffff:a.b.c.d onto the IPv4 rules above,
  // so IPv4-mapped addresses need no rule of their own (asserted in tests).
  list.addAddress("::", "ipv6"); // unspecified
  list.addAddress("::1", "ipv6"); // loopback
  list.addSubnet("fc00::", 7, "ipv6"); // unique local
  list.addSubnet("fe80::", 10, "ipv6"); // link-local
  list.addSubnet("ff00::", 8, "ipv6"); // multicast
  // Translation prefixes. BlockList does NOT unwrap the IPv4 these carry, so
  // they are refused entirely rather than checked against the IPv4 rules.
  list.addSubnet("2002::", 16, "ipv6"); // 6to4
  list.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64
  return list;
})();

/** Names that only ever mean "inside this box or this LAN". */
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"] as const;
const BLOCKED_HOST_EXACT = new Set(["localhost", ""]);

/** WHATWG URL keeps IPv6 hostnames bracketed; every other consumer wants the
 *  bare address. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Is this IP literal inside the boundary?
 *
 * Exported as the reusable predicate: other outbound clients that already
 * hold a resolved address (WARP-2039's off-LAN channel gate is the first
 * consumer) apply the same table without re-deriving it.
 *
 * Fails CLOSED — an address this cannot parse is treated as blocked, because
 * "I could not tell" must never resolve to "allowed".
 */
export function isBlockedAddress(addr: string): boolean {
  const bare = stripBrackets(addr.trim());
  const version = isIP(bare);
  if (version === 0) return true;
  return BLOCKED_RANGES.check(bare, version === 4 ? "ipv4" : "ipv6");
}

/**
 * Is this hostname inside the boundary on NAME alone — before any DNS?
 *
 * Covers both the internal-only suffixes and the case where the "hostname"
 * is really an IP literal. Says nothing about what a public name resolves
 * to; that is `assertOutboundDestinationAllowed`'s job.
 */
export function isBlockedHostname(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase());
  if (BLOCKED_HOST_EXACT.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix))) return true;
  if (isIP(h) !== 0) return isBlockedAddress(h);
  return false;
}

/**
 * Structural gate — parse, check scheme, userinfo and the host as written.
 * Synchronous, so it is the one used at REGISTRATION time: a bad URL is a
 * 400 when the user saves it, not a mystery sync failure fifteen minutes
 * later. Deliberately does no DNS, so saving a source while the box is
 * offline still works.
 *
 * Returns the parsed URL so callers use the SAME parse the guard vetted,
 * rather than re-parsing the raw string and diverging from it.
 */
export function assertOutboundUrlAllowed(
  raw: string,
  opts: OutboundUrlGuardOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundUrlBlockedError("malformed", "not a parseable URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlBlockedError("scheme", `${url.protocol}// is not http(s)`);
  }
  // Checked even under allowPrivateHost: credentials in a URL leak into
  // logs, Referer headers and redirect targets regardless of destination.
  if (url.username !== "" || url.password !== "") {
    throw new OutboundUrlBlockedError("userinfo", "credentials in the URL authority");
  }
  if (opts.allowPrivateHost !== true && isBlockedHostname(url.hostname)) {
    throw new OutboundUrlBlockedError("private_host", stripBrackets(url.hostname));
  }
  return url;
}

/**
 * Full gate — everything `assertOutboundUrlAllowed` does, then resolve the
 * hostname and refuse if ANY answer lands inside the boundary.
 *
 * This is the one wired into the fetch path, so a public hostname that
 * resolves to 127.0.0.1 is refused even though nothing about the string
 * says so. See the module header for the rebind residual.
 */
export async function assertOutboundDestinationAllowed(
  raw: string,
  opts: OutboundUrlGuardOptions = {},
): Promise<URL> {
  const url = assertOutboundUrlAllowed(raw, opts);
  if (opts.allowPrivateHost === true) return url;

  const host = stripBrackets(url.hostname);
  // A literal was already vetted against the same table; resolving it would
  // just hand the same string back.
  if (isIP(host) !== 0) return url;

  let addresses: string[];
  try {
    const answers = await lookup(host, { all: true, verbatim: true });
    addresses = answers.map((a) => a.address);
  } catch {
    // Fail closed. See the module header.
    throw new OutboundUrlBlockedError("unresolvable", host);
  }
  if (addresses.length === 0) {
    throw new OutboundUrlBlockedError("unresolvable", host);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new OutboundUrlBlockedError("private_host", address);
    }
  }
  return url;
}

/** True when `err` is this module's refusal — lets a caller distinguish a
 *  policy rejection from a transport failure without string-matching. */
export function isOutboundUrlBlocked(err: unknown): err is OutboundUrlBlockedError {
  return err instanceof OutboundUrlBlockedError;
}

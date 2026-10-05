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
 * WARP-3532 closes the window for ONE consumer, in a second mode at the bottom
 * of this file ("LAN-aware, pinned mode"): `resolvePinnedDestination` resolves
 * once, vets every answer and hands the vetted addresses to a connector that
 * never resolves again. The calendar paths above are untouched.
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
import { networkInterfaces } from "node:os";

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

// ─────────────────────────────────────────────────────────────────────────────
// LAN-aware, pinned mode (WARP-3532, ADR-069 §9)
//
// The calendar guard above has one question — "is this inside the boundary?" —
// and one answer for it: refuse. A work webhook needs a different split. A
// destination on the box's own LAN (a local n8n, Home Assistant, a NAS) is a
// legitimate, first-class target and needs no egress switch; a destination off
// the LAN is legitimate only with the owner's `work_integrations` switch on;
// and the box itself, in every shape it can be addressed, is never a target.
//
// "The box itself" is wider than loopback on this appliance. The orchestrator
// is a compose container: its siblings (postgres, redis, mqtt, the gateway) sit
// on the same bridge, `host.docker.internal` resolves to the bridge gateway,
// and the host's own LAN address reaches the host-network services (routing,
// switch, the device bridge) from inside the container. All of those are
// RFC1918 addresses, so "refuse RFC1918" and "allow the LAN" cannot both be a
// range table: the table says what is PRIVATE, and `localNetworkFacts` says
// which private addresses are THIS box.
//
// Nothing here changes `assertOutboundUrlAllowed`, `assertOutboundDestination
// Allowed` or `allowPrivateHost`. Their callers (calendar, email provisioning,
// push endpoints) keep their original contract; the pinned-mode test file
// proves it row by row.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a vetted destination sits relative to the box. `lan` is RFC1918 / ULA
 *  space that is not this box; `public` is everything else that is routable. */
export type OutboundScope = "lan" | "public";

/**
 * Facts about THIS box that no static table can know: the addresses it holds
 * and the networks it is attached to. Inside the orchestrator's container the
 * attached networks are the compose bridge and `droplet-internal`.
 *
 * `cidrs` carry a host address with the prefix (`172.18.0.5/16`), exactly as
 * `os.networkInterfaces()` reports them; the prefix is what matters.
 */
export interface LocalNetworkFacts {
  readonly addresses: readonly string[];
  readonly cidrs: readonly string[];
}

/**
 * This process's own interface addresses and attached networks, from the
 * kernel. Synchronous and cheap — read per resolution, never cached, because a
 * compose network can be (re)created under a running orchestrator.
 *
 * Caveat, stated rather than hidden: in a container this covers the container's
 * own networks, which is the compose network and the host-gateway. The HOST's
 * LAN address is not an interface in there; a caller that can learn it (the
 * device bridge reports the uplink IP) merges it in through
 * `resolvePinnedDestination`'s `local` option. Run outside a container and the
 * LAN the box sits on is "attached", so it is refused too — fail closed, and
 * the on-box stack is the only place LAN delivery is meant to work.
 */
export function localNetworkFacts(): LocalNetworkFacts {
  const addresses: string[] = [];
  const cidrs: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push(entry.address);
      if (entry.cidr) cidrs.push(entry.cidr);
    }
  }
  return { addresses, cidrs };
}

/** RFC1918 and IPv6 ULA: the address space a LAN lives in. A strict subset of
 *  `BLOCKED_RANGES`, which is why an address the old table refuses is LAN when
 *  it is also in this one and reserved when it is not. */
const LAN_RANGES = (() => {
  const list = new BlockList();
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("fc00::", 7, "ipv6");
  return list;
})();

/**
 * Cloud instance-metadata endpoints, named and checked FIRST. The IPv4 ones sit
 * inside link-local space, which is refused anyway; they are listed so the
 * refusal reads "metadata" to an operator. EC2's IPv6 endpoint is the one that
 * needs the entry: it lives inside the ULA block that LAN mode allows.
 *
 * Deliberately NOT listed: Azure's wire server and Alibaba's metadata address.
 * This is an appliance, not a cloud instance; Alibaba's is inside CGNAT, which
 * is refused as "reserved"; and Azure's is an ordinary public address, so a
 * literal here would be a public IP in the source that the egress registry
 * (docs/security/allowed-egress.yaml) would have to carry for an address
 * nothing dials.
 */
const METADATA_ADDRESSES = (() => {
  const list = new BlockList();
  list.addAddress("169.254.169.254", "ipv4"); // AWS, GCP, Azure, OpenStack, DigitalOcean
  list.addAddress("169.254.170.2", "ipv4"); // AWS ECS task metadata
  list.addAddress("fd00:ec2::254", "ipv6"); // AWS IPv6 IMDS
  return list;
})();

/** Why a vetted address was refused. Operator-facing, like `detail`. */
export type AddressRefusalRule = "unparseable" | "metadata" | "reserved" | "own_network";

export type AddressVerdict =
  | { readonly scope: OutboundScope }
  | { readonly scope: "refused"; readonly rule: AddressRefusalRule };

/** Own addresses and attached networks as a BlockList, which — unlike string
 *  comparison — also matches IPv4-mapped IPv6 and any textual form. */
function localBlockList(local: LocalNetworkFacts): BlockList {
  const list = new BlockList();
  for (const address of local.addresses) {
    const bare = address.split("%")[0] ?? "";
    const version = isIP(bare);
    if (version !== 0) list.addAddress(bare, version === 4 ? "ipv4" : "ipv6");
  }
  for (const cidr of local.cidrs) {
    const [net, prefix] = cidr.split("/");
    const bare = (net ?? "").split("%")[0] ?? "";
    const version = isIP(bare);
    const bits = Number(prefix);
    if (version !== 0 && Number.isInteger(bits)) {
      list.addSubnet(bare, bits, version === 4 ? "ipv4" : "ipv6");
    }
  }
  return list;
}

/**
 * What an address means for egress: refused, on the LAN, or public.
 *
 * Order matters and is the reason this is one function rather than three
 * predicates: metadata first (two of its addresses are otherwise "public" and
 * "LAN"), then everything the original table refuses that is not LAN space,
 * then THIS box. An address that survives all three is LAN if it is in
 * RFC1918 / ULA space and public otherwise.
 *
 * Fails CLOSED: an address that does not parse is refused, never "public".
 */
export function classifyDestinationAddress(addr: string, local: LocalNetworkFacts): AddressVerdict {
  const bare = (stripBrackets(addr.trim()).split("%")[0] ?? "").trim();
  const version = isIP(bare);
  if (version === 0) return { scope: "refused", rule: "unparseable" };
  const family = version === 4 ? "ipv4" : "ipv6";

  if (METADATA_ADDRESSES.check(bare, family)) return { scope: "refused", rule: "metadata" };
  const isLan = LAN_RANGES.check(bare, family);
  if (BLOCKED_RANGES.check(bare, family) && !isLan) return { scope: "refused", rule: "reserved" };
  if (localBlockList(local).check(bare, family)) return { scope: "refused", rule: "own_network" };
  return { scope: isLan ? "lan" : "public" };
}

/** Names that can only mean "this box", refused before any DNS in LAN-aware mode.
 *  `.local` and `.home.arpa` are deliberately NOT here: they are how a LAN
 *  names its own devices, and the address they resolve to is what is vetted. */
const LAN_AWARE_BLOCKED_SUFFIXES = [".localhost", ".internal"] as const;

/** Scheme, credentials and name — everything checkable without an address.
 *  Returns the URL and its bare hostname. */
function parseLanAwareUrl(raw: string): { url: URL; host: string } {
  const url = assertOutboundUrlAllowed(raw, { allowPrivateHost: true });
  const host = stripBrackets(url.hostname).toLowerCase();
  if (
    host === "" ||
    host === "localhost" ||
    LAN_AWARE_BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new OutboundUrlBlockedError("private_host", host);
  }
  return { url, host };
}

function refusedAddress(address: string, rule: AddressRefusalRule): OutboundUrlBlockedError {
  return new OutboundUrlBlockedError("private_host", `${address} (${rule})`);
}

/**
 * Registration-time gate for a destination that may be on the LAN or off it.
 * Synchronous and DNS-free, like `assertOutboundUrlAllowed`, so a bad URL is a
 * 400 when the owner saves it and saving works while the box is offline.
 *
 * Refuses a bad scheme, credentials in the URL, names that mean this box and —
 * for an IP literal — every address `classifyDestinationAddress` refuses.
 * Does NOT decide LAN-versus-public for a name: that needs DNS and is the
 * send-time job of `resolvePinnedDestination`.
 */
export function assertLanOrPublicUrl(
  raw: string,
  opts: { local?: () => LocalNetworkFacts } = {},
): URL {
  const { url, host } = parseLanAwareUrl(raw);
  if (isIP(host) !== 0) {
    const verdict = classifyDestinationAddress(host, (opts.local ?? localNetworkFacts)());
    if (verdict.scope === "refused") throw refusedAddress(host, verdict.rule);
  }
  return url;
}

export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * A destination the guard has vetted, with the addresses the connection must
 * use. `url` is the SAME parse the guard vetted, original hostname intact — the
 * hostname is what `Host` and TLS SNI carry, while `addresses` is where the
 * socket goes. Nothing downstream resolves `hostname` again.
 */
export interface PinnedDestination {
  readonly url: URL;
  /** Bare hostname as written (IPv6 unbracketed). */
  readonly hostname: string;
  /** Every vetted answer, resolver order. One name can carry several (A + AAAA)
   *  and the connector may try each; it may not try anything else. */
  readonly addresses: readonly PinnedAddress[];
  /** The strictest scope among `addresses`: `public` if any answer is. The
   *  egress switch is consulted for `public`, never for `lan`. */
  readonly scope: OutboundScope;
}

export interface ResolveDestinationOptions {
  /** Test seam; defaults to `dns.lookup({ all: true, verbatim: true })`. */
  resolve?: (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  /** The box's own addresses and networks. May be async so a caller can merge
   *  in addresses only the host knows. A throw propagates: fail closed. */
  local?: () => LocalNetworkFacts | Promise<LocalNetworkFacts>;
}

async function defaultResolve(host: string): Promise<ReadonlyArray<{ address: string; family: number }>> {
  return lookup(host, { all: true, verbatim: true });
}

/**
 * Send-time gate: resolve the hostname ONCE, vet EVERY answer, and return the
 * vetted addresses for a connector that never resolves again.
 *
 * Refuses the whole destination if any answer is refused — a name with one
 * public and one loopback answer is a rebind in progress, not a lucky draw.
 * Fails closed when the name does not resolve.
 */
export async function resolvePinnedDestination(
  raw: string,
  opts: ResolveDestinationOptions = {},
): Promise<PinnedDestination> {
  const { url, host } = parseLanAwareUrl(raw);
  const local = await (opts.local ?? localNetworkFacts)();

  let answers: ReadonlyArray<{ address: string; family: number }>;
  const literal = isIP(host);
  if (literal !== 0) {
    answers = [{ address: host, family: literal }];
  } else {
    try {
      answers = await (opts.resolve ?? defaultResolve)(host);
    } catch {
      // Fail closed. See the module header.
      throw new OutboundUrlBlockedError("unresolvable", host);
    }
    if (answers.length === 0) throw new OutboundUrlBlockedError("unresolvable", host);
  }

  let scope: OutboundScope = "lan";
  const addresses: PinnedAddress[] = [];
  for (const { address } of answers) {
    const verdict = classifyDestinationAddress(address, local);
    if (verdict.scope === "refused") throw refusedAddress(address, verdict.rule);
    if (verdict.scope === "public") scope = "public";
    const bare = stripBrackets(address.trim());
    addresses.push({ address: bare, family: isIP(bare) === 6 ? 6 : 4 });
  }
  return { url, hostname: host, addresses, scope };
}

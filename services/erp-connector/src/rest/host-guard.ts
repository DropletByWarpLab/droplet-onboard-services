/**
 * WARP-2707 / ADR-046 §3 — the exact-host guard for the declarative REST track.
 *
 * 🔴 **This file is the enforcement. The allowlist entry is not.**
 *
 * Ten of the thirty-four surveyed vendors assemble their host per account — a
 * region, a subdomain, a self-hosted install, or a host handed back in a token
 * response. For every one of them `docs/security/allowed-egress.yaml` carries a
 * `kind: dynamic` entry, and `docs/SECURITY.md` states the limit plainly: the
 * static scanner *"cannot see hostnames assembled at runtime"*, and
 * `load_allowlist()` contributes **zero** host patterns for a dynamic entry. So
 * for those ten the YAML is documentation and review — and this function is the
 * only thing that actually stops a customer's key being sent somewhere.
 *
 * Filing a per-account host as `kind: egress` with a wildcard, or with one
 * sampled region, is worse than useless: it produces a green `egress-gate` over
 * a host nothing constrains. Do not "fix" the dynamic entries into static ones.
 *
 * ## Why this is shared rather than per-vendor
 *
 * `assertSafePipedriveBaseUrl` and `assertSafeQboBaseUrl` are the same seven
 * checks with different constants. At ten vendors, ten copies is ten chances to
 * omit the userinfo check or the port check in one of them — and the omission
 * is invisible, because every copy's happy path passes. One guard, tested once
 * and hard, is the trade ADR-046 makes knowingly: a bug here is a bug in every
 * profile at once, which is exactly why this module's tests are heavier than
 * any single connector's.
 *
 * ## The test rule that matters
 *
 * 🔴 Every guard test asserts the injected `fetch` was called **zero** times —
 * never merely that an error was thrown. A test that inspects the outcome still
 * passes when the request already went out carrying the customer's credential.
 * ADR-046 §3 makes this explicit and it is not negotiable.
 */
import type { RestBaseUrl } from "./profile.js";

/**
 * Refusal to dial a host this connection may not reach.
 *
 * Mirrors `UnsafeQboBaseUrlError` / `UnsafePipedriveBaseUrlError`: a distinct
 * type, so a call site can tell "this destination is refused" from "this
 * request failed", and so the orchestrator never reports a blocked destination
 * as a vendor outage.
 */
export class UnsafeBaseUrlError extends Error {
  readonly provider: string;
  constructor(provider: string, reason: string) {
    super(`refusing to dial for "${provider}": ${reason}`);
    this.name = "UnsafeBaseUrlError";
    this.provider = provider;
  }
}

/**
 * A DNS label, for the per-account portion of a dynamic host.
 *
 * Anchored at both ends, 1–63 characters, no leading or trailing hyphen — the
 * RFC-1035 shape. Anchoring is the point: an unanchored pattern admits
 * `evil.com/?x=acme` as a "label".
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Escape a literal for safe interpolation into a `RegExp`. */
function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * IPv4 ranges this connector will not dial, whatever a profile or a customer
 * says.
 *
 * A vendor SaaS lives on the public internet. An address in one of these ranges
 * is not a vendor — it is this box, this LAN, or the cloud metadata service —
 * and a REST connection pointed at one is either a mistake or an attempt to
 * turn the connector into a proxy for the customer's own network. The
 * per-account host is CUSTOMER-SUPPLIED and the `Link`/cursor follow URL is
 * VENDOR-supplied, so both are exactly the inputs that reach for these.
 *
 * `169.254.0.0/16` is the one that matters most: `169.254.169.254` is the
 * instance-metadata endpoint on every major cloud, and it answers unauthenticated
 * HTTP with role credentials. It is not a hypothetical — it is the canonical
 * SSRF payoff, and it is inside link-local, so blocking the /16 blocks it.
 *
 * Two ranges beyond the ones a reviewer would list first, and why each is here:
 *   `0.0.0.0/8`     — `https://0/` PARSES as `0.0.0.0`, which Linux routes to
 *                     loopback. Blocking `127/8` alone leaves that open.
 *   `100.64.0.0/10` — RFC 6598 shared address space. It is a real LAN range on
 *                     a carrier-fed install, not a curiosity.
 */
const BLOCKED_V4_RANGES: readonly { readonly cidr: string; readonly why: string; readonly test: (o: number[]) => boolean }[] = [
  { cidr: "0.0.0.0/8", why: "this host", test: (o) => o[0] === 0 },
  { cidr: "10.0.0.0/8", why: "a private network", test: (o) => o[0] === 10 },
  { cidr: "127.0.0.0/8", why: "loopback", test: (o) => o[0] === 127 },
  { cidr: "100.64.0.0/10", why: "carrier-grade NAT space", test: (o) => o[0] === 100 && o[1]! >= 64 && o[1]! <= 127 },
  { cidr: "169.254.0.0/16", why: "link-local, which is where cloud instance metadata answers", test: (o) => o[0] === 169 && o[1] === 254 },
  { cidr: "172.16.0.0/12", why: "a private network", test: (o) => o[0] === 172 && o[1]! >= 16 && o[1]! <= 31 },
  { cidr: "192.168.0.0/16", why: "a private network", test: (o) => o[0] === 192 && o[1] === 168 },
];

/** The four octets of a dotted-quad, or `null` if this is not one. */
function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Why this host must not be dialled, or `null` if it is not a blocked literal.
 *
 * Reads the host AFTER `new URL()` has normalised it, which is what makes the
 * ranges above sufficient rather than a game of spellings. The WHATWG parser
 * folds every IPv4 form to a dotted-quad — `0x7f.0.0.1`, `2130706433`,
 * `010.0.0.1` and `0` all come out as addresses these tests catch — and folds
 * IPv6 to its compressed form. Matching on the raw string instead would have
 * to enumerate those spellings, and would miss the next one.
 *
 * A NAME is not checked here: `internal.corp.example` is a host this cannot
 * resolve, and the allow-set check is what constrains names. See the TOCTOU
 * note on {@link assertSafeRestBaseUrl}.
 */
function blockedLiteralReason(hostname: string): string | null {
  // `URL.hostname` keeps the brackets on an IPv6 literal; the address is inside.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  const octets = ipv4Octets(bare);
  if (octets) {
    const hit = BLOCKED_V4_RANGES.find((range) => range.test(octets));
    return hit ? `${hit.cidr} is ${hit.why}` : null;
  }

  if (!bare.includes(":")) return null; // a name, not an address literal

  const v6 = bare.toLowerCase();
  if (v6 === "::1") return "::1 is loopback";
  if (v6 === "::") return ":: is the unspecified address";

  // An IPv4-mapped address is an IPv4 address wearing an IPv6 spelling, and the
  // parser normalises the trailing dotted-quad into two hex groups — so
  // `::ffff:127.0.0.1` arrives as `::ffff:7f00:1`. Decode it and apply the IPv4
  // ranges, or `::ffff:169.254.169.254` walks straight past them.
  const mapped = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    const reason = blockedLiteralReason(
      `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
    );
    if (reason) return `${reason} (reached as an IPv4-mapped IPv6 address)`;
    return null;
  }

  const firstGroup = v6.split(":")[0] ?? "";
  if (/^[0-9a-f]{1,4}$/.test(firstGroup)) {
    const value = parseInt(firstGroup, 16);
    // fc00::/7 — unique local. Both fc.. and fd.. are inside it.
    if (value >= 0xfc00 && value <= 0xfdff) return "fc00::/7 is a unique-local network";
    // fe80::/10 — link-local, the IPv6 half of the metadata problem.
    if (value >= 0xfe80 && value <= 0xfebf) return "fe80::/10 is link-local";
  }
  return null;
}

/**
 * The checks every dialled URL passes, whatever the track.
 *
 * Returns the normalised origin (`https://host`) — callers build paths onto
 * THAT, never onto the string they were handed, so a query or fragment
 * smuggled into a base URL cannot survive into a request.
 */
function assertCommonUrlSafety(provider: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeBaseUrlError(provider, `"${raw}" is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new UnsafeBaseUrlError(provider, `"${url.protocol}//" is not https`);
  }
  // A URL of the form `https://<a-trusted-looking-name>@<attacker-host>/`
  // parses with the ATTACKER's hostname — the part before the `@` is userinfo,
  // not a host. The hostname check below would catch that one, but userinfo
  // also leaks a credential into a URL and into every log that records it, so
  // it is refused in its own right rather than left to a downstream check.
  //
  // (Written without a literal example on purpose: `check-egress-allowlist.py`
  // reads string and comment content looking for bare hostnames, and a sample
  // host in a comment is indistinguishable to it from a destination this box
  // dials. The same reason `ref-pipedrive-host-suffix` exists.)
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeBaseUrlError(provider, "the URL carries userinfo");
  }
  // The URL parser drops an explicit :443, so any port left standing is one the
  // egress registry does not declare.
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeBaseUrlError(
      provider,
      `port ${url.port} — the egress registry allows this host on 443 only`,
    );
  }
  const blocked = blockedLiteralReason(url.hostname.toLowerCase());
  if (blocked !== null) {
    throw new UnsafeBaseUrlError(
      provider,
      `"${url.hostname}" is not a vendor — ${blocked}`,
    );
  }
  return url;
}

/**
 * Is `host` admitted by this base-URL declaration?
 *
 * Exact equality for `allowedHosts`. For `allowedSuffixes`, the host must be
 * exactly one DNS label followed by the suffix — `evil-acme.pipedrive.com` is
 * admitted (it is a real Pipedrive host) but `acme.pipedrive.com.evil.com` is
 * not, and neither is a multi-label `a.b.pipedrive.com`. Anchored on both ends,
 * because `endsWith(".pipedrive.com")` alone admits
 * `pipedrive.com.evil.pipedrive.com` from an attacker who controls a
 * subdomain — a suffix test is not a host test.
 */
function hostIsAllowed(host: string, allowedHosts: readonly string[], allowedSuffixes: readonly string[]): boolean {
  if (allowedHosts.some((allowed) => allowed.toLowerCase() === host)) return true;
  return allowedSuffixes.some((suffix) => {
    const pattern = new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?${escapeRegExpLiteral(suffix.toLowerCase())}$`);
    return pattern.test(host);
  });
}

/**
 * Validate the per-account value the customer supplied for a dynamic host.
 *
 * Accepts either a bare DNS label (Pipedrive's `acme`, BambooHR's subdomain) or
 * a whole hostname (a self-hosted GitLab or Cal.com). Both are re-checked
 * against the profile's allow-set by {@link assertSafeRestBaseUrl}, so this
 * only rejects what could never be a host at all.
 */
export function assertHostConfigValue(provider: string, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") {
    throw new UnsafeBaseUrlError(provider, "the connection carries no host value");
  }
  if (trimmed.includes("/") || trimmed.includes(":") || trimmed.includes("@")) {
    throw new UnsafeBaseUrlError(
      provider,
      `"${value}" must be a host or subdomain label, not a URL`,
    );
  }
  const labels = trimmed.split(".");
  if (labels.some((label) => !DNS_LABEL.test(label))) {
    throw new UnsafeBaseUrlError(provider, `"${value}" is not a valid host`);
  }
  return trimmed;
}

/**
 * Resolve and validate the origin this connection may dial.
 *
 * Static profiles: the declared origin is re-validated rather than trusted, so
 * one code path is under test instead of two — the same reasoning as
 * `pipedriveBaseUrlFor`.
 *
 * Dynamic profiles: the customer's value is substituted, and the RESULT is
 * checked against the profile's allow-set. Building and then validating is
 * deliberate; validating only the input would leave the composition unchecked.
 *
 * ## 🔴 What this guard does NOT close — stated rather than implied
 *
 * This is a check on the URL, not on the connection. Three residual gaps, and
 * naming them is the point: a guard that is believed to do more than it does is
 * worse than one whose limit is written down.
 *
 *  1. **DNS rebinding / check-then-connect (TOCTOU).** The blocklist above
 *     reads an address LITERAL. A registered NAME under an allowed suffix is
 *     admitted here and resolved later by the runtime, and nothing stops that
 *     name from resolving to `127.0.0.1`, to `169.254.169.254`, or to a
 *     different address on the second lookup than on the first. Closing it
 *     needs resolution inside the guard AND a socket pinned to the address that
 *     was checked — a custom `undici` dispatcher with a `connect` hook, not a
 *     line here. Until that exists, the allow-set is what constrains a name:
 *     only a host the profile registered can be dialled at all, so the attacker
 *     has to already control a vendor subdomain.
 *  2. **The vendor's own hosts.** An allowed host that is compromised, or a
 *     vendor that proxies, is inside the allow-set by definition. Nothing here
 *     sees that.
 *  3. **The redirect a runtime might follow.** Closed on this track by
 *     `redirect: "error"` in `connector.ts`, not by this file — and that is why
 *     it is set there rather than left to the guard.
 */
export function assertSafeRestBaseUrl(
  provider: string,
  baseUrl: RestBaseUrl,
  hostConfigValue?: string,
): string {
  if (baseUrl.kind === "static") {
    const url = assertCommonUrlSafety(provider, baseUrl.origin);
    return `${url.protocol}//${url.host}`;
  }

  if (hostConfigValue === undefined) {
    throw new UnsafeBaseUrlError(
      provider,
      `this connection supplies no "${baseUrl.configField}", so no host can be resolved`,
    );
  }
  const value = assertHostConfigValue(provider, hostConfigValue);

  // A bare label is completed with the FIRST declared suffix; a value that
  // already contains a dot is taken as a whole host. Both then face the same
  // allow-set check below, so the completion is a convenience and never a
  // permission.
  const candidateHost = value.includes(".")
    ? value
    : `${value}${baseUrl.allowedSuffixes[0] ?? ""}`;

  const url = assertCommonUrlSafety(provider, `https://${candidateHost}`);
  const host = url.hostname.toLowerCase();

  if (!hostIsAllowed(host, baseUrl.allowedHosts, baseUrl.allowedSuffixes)) {
    throw new UnsafeBaseUrlError(provider, `"${host}" is not a registered host for this provider`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Re-check a URL the VENDOR handed back before following it.
 *
 * `Link: <…>; rel="next"` is vendor-controlled input. A next-page URL pointing
 * at another host is the obvious way to walk a customer's credential off the
 * registered destination, and following it would be indistinguishable from
 * normal pagination in every log. So the follow-up URL faces the same guard the
 * first request did, plus an equality check against the origin already
 * resolved for this connection.
 *
 * The same applies to any absolute cursor URL a body hands back.
 */
export function assertSafeFollowUrl(provider: string, resolvedOrigin: string, raw: string): string {
  const url = assertCommonUrlSafety(provider, raw);
  const origin = `${url.protocol}//${url.host}`;
  if (origin !== resolvedOrigin) {
    throw new UnsafeBaseUrlError(
      provider,
      `a pagination link pointed at "${origin}", which is not this connection's host ("${resolvedOrigin}")`,
    );
  }
  return url.toString();
}

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
  // `https://api.vendor.com@evil.com/` parses with hostname `evil.com`. The
  // hostname check below would catch that one, but userinfo also leaks a
  // credential into a URL and into every log that records it, so it is refused
  // in its own right rather than left to a downstream check.
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

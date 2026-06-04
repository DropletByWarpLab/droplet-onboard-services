/**
 * Shared, host-validated builder for invite-accept links.
 *
 * Invite-accept URLs carry a single-use token and go out over email, so the
 * host embedded in them is security-sensitive: a forged `X-Forwarded-Host`
 * header that gets reflected into the link is a token-exfiltration vector
 * (the victim clicks `https://evil.example/invite/<token>` and hands the
 * attacker the token). PR #486 code-review finding 2.
 *
 * This module is the single source of truth for that link — `auth.ts`,
 * `people.ts`, and `settings-email.ts` all delegate here instead of each
 * trusting the request header. It does NOT trust the request host blindly;
 * it resolves a canonical public origin and only honours the request/forwarded
 * host when that host is on an allowlist of origins the box already trusts.
 *
 * Resolution order for the host (documented contract — do not reorder without
 * updating the tests):
 *
 *   1. **Canonical origin** — `WIREGUARD_ENDPOINT_HOST` (the operator-set
 *      public DNS name, verbatim), else the box's enabled DuckDNS subdomain
 *      (`fullDomain` || `<subdomain>.duckdns.org`). This is the same
 *      env→DuckDNS order `vpn.ts`'s `resolveEndpointHost()` uses for the
 *      WireGuard endpoint, so the invite link and the VPN endpoint agree on
 *      "what is this box's public address". When present, the link is built
 *      from it and the request host is ignored.
 *   2. **Allowlisted request host** — when there is no canonical origin, the
 *      request's host (`x-forwarded-host` then `host`) is used ONLY if it
 *      matches the allowlist {canonical-origin host} ∪ {hosts of
 *      `config.corsAllowedOrigins`}. `corsAllowedOrigins` is the box's own
 *      trusted LAN/dashboard origins (defaults to `https://droplet-ai.local`,
 *      covered by the TLS cert SANs), so this keeps the legitimate
 *      nginx-proxy host working without trusting arbitrary headers.
 *   3. **Safe default** — when neither a canonical origin nor an allowlisted
 *      request host is available, fall back to the first trusted origin
 *      (`https://droplet-ai.local` by default). Never the forged header.
 *
 * The protocol is `https` whenever the chosen host came from a canonical/known
 * https origin; otherwise it honours `req.secure` / `x-forwarded-proto`. The
 * token + `/invite/:token` path contract is unchanged from the three helpers
 * this replaces.
 */
import type { Request } from "express";
import pino from "pino";
import { config } from "../config.js";
import { fetchDuckDnsStatus } from "../services/openwrt.client.js";

const logger = pino({ name: "invite-url" });

/** Resolved canonical-origin context for a single link build. */
export interface InviteOrigin {
  /** The box's canonical public host, or null if none is configured. */
  canonicalHost: string | null;
  /** True when the canonical origin is reachable over https (always, today). */
  canonicalIsHttps: boolean;
  /**
   * Lower-cased, bare (port-stripped) hosts the box trusts. A request host is
   * only honoured if it is in this set.
   */
  allowedHosts: Set<string>;
}

/**
 * In-process TTL cache for the canonical-origin resolution. The DuckDNS leg
 * hits the routing service; invite sends are infrequent but the cache keeps a
 * burst of invites (or a polled status page that reuses this) from amplifying
 * onto the Python sidecar. Mirrors `vpn.ts`'s 30 s endpoint cache.
 */
const ORIGIN_CACHE_TTL_MS = 30_000;
let _originCache: { value: InviteOrigin; expiresAt: number } | null = null;

/** Test-only: drop the cache so unit tests can flip env/DuckDNS without TTL waits. */
export function _resetInviteOriginCacheForTests(): void {
  _originCache = null;
}

/** Strip a trailing `:port` from a host[:port] and lower-case it. */
function bareHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return "";
  // IPv6 literals are bracketed (`[::1]:443`); leave the bracketed part intact
  // and only drop a port that follows the closing bracket.
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/** Extract the bare host from an origin string (`https://h:443` → `h`). */
function hostFromOrigin(origin: string): string | null {
  try {
    return bareHost(new URL(origin).host);
  } catch {
    return null;
  }
}

/** The box's own LAN dashboard origin — the safe default + permanent allowlist
 *  entry. Matches `config.ts`'s `resolveCorsAllowedOrigins` default so the
 *  invite link and CORS agree on the box's identity. */
const DEFAULT_TRUSTED_ORIGIN = "https://droplet-ai.local";

/**
 * The box's trusted origins. Reads `config.corsAllowedOrigins` (its own
 * LAN/dashboard origins, operator-overridable via CORS_ALLOWED_ORIGINS) and
 * always includes the LAN default so an under-specified config can never leave
 * the allowlist empty (which would otherwise let a forged host through).
 */
function trustedOrigins(): string[] {
  const configured = Array.isArray(config.corsAllowedOrigins)
    ? config.corsAllowedOrigins
    : [];
  return configured.length > 0 ? configured : [DEFAULT_TRUSTED_ORIGIN];
}

/**
 * Resolve the canonical public origin + the host allowlist for invite links.
 *
 * Cached for `ORIGIN_CACHE_TTL_MS`. Routing-service failures are non-fatal:
 * a failed DuckDNS lookup is treated as "no canonical origin" (the env
 * override path is unaffected), exactly like `resolveEndpointHost()`.
 */
export async function resolveInviteOrigin(): Promise<InviteOrigin> {
  const now = Date.now();
  if (_originCache && _originCache.expiresAt > now) {
    return _originCache.value;
  }

  // Always trust the box's own configured origins (LAN dashboard origin etc.).
  const allowedHosts = new Set<string>();
  for (const origin of trustedOrigins()) {
    const h = hostFromOrigin(origin);
    if (h) allowedHosts.add(h);
  }

  // 1. Operator-set public DNS name wins, verbatim, without a network call.
  let canonicalHost: string | null = null;
  const envHost = (config.WIREGUARD_ENDPOINT_HOST ?? "").trim();
  if (envHost) {
    canonicalHost = bareHost(envHost);
  } else if (config.ROUTING_MODE !== "disabled") {
    // 2. Else derive from an enabled DuckDNS config. Skipped when routing
    //    supervision is disabled (the call would just throw RouterError.disabled).
    try {
      const ddns = await fetchDuckDnsStatus();
      if (ddns.configured && ddns.enabled) {
        const derived = ddns.fullDomain || `${ddns.subdomain}.duckdns.org`;
        canonicalHost = bareHost(derived);
      }
    } catch (err) {
      logger.debug(
        { err },
        "invite-url: could not check DuckDNS for canonical origin — treating as unconfigured",
      );
    }
  }

  if (canonicalHost) allowedHosts.add(canonicalHost);

  const value: InviteOrigin = {
    canonicalHost,
    // The canonical origin is always an https endpoint today (DuckDNS / the
    // operator's public DNS front the box over TLS).
    canonicalIsHttps: true,
    allowedHosts,
  };
  _originCache = { value, expiresAt: now + ORIGIN_CACHE_TTL_MS };
  return value;
}

/** The request host the proxy claims, in priority order: forwarded then direct. */
function requestHost(req: Request): string | null {
  const xff = req.headers["x-forwarded-host"];
  const fromXff = Array.isArray(xff) ? xff[0] : xff;
  const host = fromXff || req.headers.host;
  if (!host || typeof host !== "string") return null;
  // `x-forwarded-host` can be a comma list when chained through proxies; the
  // first hop is the client-facing host.
  return bareHost(host.split(",")[0]);
}

/**
 * Pick the host to embed, given the resolved origin context. Pure function —
 * no I/O — so the allowlist decision is unit-testable in isolation.
 *
 *   - The canonical host always wins (it does not depend on the request).
 *   - Otherwise the request host is honoured ONLY if it is on the allowlist.
 *   - Otherwise null (caller applies the safe default).
 */
export function pickInviteHost(
  req: Request,
  origin: Pick<InviteOrigin, "canonicalHost" | "allowedHosts">,
): string | null {
  if (origin.canonicalHost) return origin.canonicalHost;

  const candidate = requestHost(req);
  if (candidate && origin.allowedHosts.has(candidate)) {
    return candidate;
  }

  if (candidate) {
    logger.warn(
      { candidate },
      "invite-url: request host is not on the allowlist; ignoring it for the invite link",
    );
  }
  return null;
}

/** Whether the inbound request looks like https (direct TLS or proxied). */
function requestIsHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Build the absolute, host-validated invite-accept URL for `token`.
 *
 * Resolves the canonical origin, applies the host allowlist (see module
 * docstring), and assembles `https://<host>/invite/<token>`. A forged or
 * unknown request host is never embedded; the link falls back to the canonical
 * origin or the first trusted origin instead.
 */
export async function buildInviteUrl(req: Request, token: string): Promise<string> {
  const origin = await resolveInviteOrigin();
  const picked = pickInviteHost(req, origin);

  if (picked) {
    // A canonical host (or an allowlisted host that came from an https origin)
    // is served over https; a same-host request that arrived over http keeps
    // http only when it wasn't promoted from a canonical/https origin.
    const https =
      origin.canonicalHost === picked
        ? origin.canonicalIsHttps
        : requestIsHttps(req) || origin.allowedHosts.has(picked);
    const protocol = https ? "https" : "http";
    return `${protocol}://${picked}/invite/${token}`;
  }

  // Safe default: the box's first trusted origin. Never the forged header.
  const fallback = trustedOrigins()[0] ?? DEFAULT_TRUSTED_ORIGIN;
  const base = fallback.replace(/\/+$/, "");
  return `${base}/invite/${token}`;
}

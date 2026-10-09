/** Host-validated internal dashboard URLs. A UDP WireGuard endpoint is
 * separate from the web origin; request headers never override the local
 * canonical name or the configured trusted-origin allowlist. */
import type { Request } from "express";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("trusted-origin");

/** Resolved canonical-origin context for a single URL build. */
export interface TrustedOrigin {
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
 * Test-only: retained as a no-op so existing specs keep a stable import.
 * The canonical origin now resolves from env vars with no I/O, so there is
 * no longer any TTL cache to reset.
 */
export function _resetTrustedOriginCacheForTests(): void {}

/** Strip a trailing `:port` from a host[:port] and lower-case it. */
export function bareHost(host: string): string {
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
 *  entry. Matches `config.ts`'s `resolveCorsAllowedOrigins` default so every
 *  generated URL and CORS agree on the box's identity. */
const DEFAULT_TRUSTED_ORIGIN = "https://droplet-ai.lan";

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
 * Resolve the canonical public origin + the host allowlist.
 *
 * The canonical origin comes from `DROPLET_LAN_HOSTNAME`, read without
 * a network call. Async
 * signature is retained so callers and tests are unaffected.
 */
export async function resolveTrustedOrigin(): Promise<TrustedOrigin> {
  // Always trust the box's own configured origins (LAN dashboard origin etc.).
  const allowedHosts = new Set<string>();
  for (const origin of trustedOrigins()) {
    const h = hostFromOrigin(origin);
    if (h) allowedHosts.add(h);
  }

  const hostname = (config.DROPLET_LAN_HOSTNAME ?? "").trim();
  const canonicalHost = hostname ? bareHost(hostname) : null;

  if (canonicalHost) allowedHosts.add(canonicalHost);

  const value: TrustedOrigin = {
    canonicalHost,
    // The canonical origin is always an https endpoint today (the operator's
    // internal DNS name fronts the box over TLS).
    canonicalIsHttps: true,
    allowedHosts,
  };
  return value;
}

/** The request host the proxy claims, in priority order: forwarded then direct. */
export function requestHost(req: Request): string | null {
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
 *
 * `extraAllowedHosts` lets a specific surface widen the allowlist with hosts
 * the box legitimately serves but that aren't in `corsAllowedOrigins` — e.g.
 * the mDNS `droplet.local` (a TLS cert SAN) for the device-pairing WebDAV URL.
 * They are matched bare + case-insensitively, like the base allowlist.
 */
export function pickTrustedHost(
  req: Request,
  origin: Pick<TrustedOrigin, "canonicalHost" | "allowedHosts">,
  extraAllowedHosts?: readonly string[],
): string | null {
  if (origin.canonicalHost) return origin.canonicalHost;

  const candidate = requestHost(req);
  if (candidate && origin.allowedHosts.has(candidate)) {
    return candidate;
  }
  if (
    candidate &&
    extraAllowedHosts?.some((h) => bareHost(h) === candidate)
  ) {
    return candidate;
  }

  if (candidate) {
    logger.warn(
      { candidate },
      "trusted-origin: request host is not on the allowlist; ignoring it for the generated URL",
    );
  }
  return null;
}

/** Split `host[:port]` / `[v6][:port]` into a lower-cased host and optional port. */
function splitHostPort(raw: string): { host: string; port: string | null } | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("[")) {
    const close = v.indexOf("]");
    if (close === -1) return null;
    const rest = v.slice(close + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return null;
    return { host: v.slice(0, close + 1), port: rest ? rest.slice(1) : null };
  }
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
  return m ? { host: m[1], port: m[2] ?? null } : null;
}

/**
 * The request's own authority for the same-origin check: `host` plus the
 * effective port. Deliberately IGNORES `X-Forwarded-Host` (nginx does not set
 * it on /api/, so a client-supplied value would pass straight through). The
 * port comes from `X-Forwarded-Port` (nginx overwrites it from $server_port;
 * its `Host $host` strips the port) else the Host header's own port, else the
 * scheme default. Returns null when Host is missing or malformed.
 */
export function requestAuthority(req: Request): { host: string; port: string } | null {
  const hostHeader = req.headers.host;
  if (!hostHeader || typeof hostHeader !== "string") return null;
  const parsed = splitHostPort(hostHeader);
  if (!parsed) return null;
  const xfp = req.headers["x-forwarded-port"];
  const xfpFirst = (Array.isArray(xfp) ? xfp[0] : xfp)?.split(",")[0]?.trim();
  const port = (xfpFirst && /^\d{1,5}$/.test(xfpFirst) ? xfpFirst : null)
    ?? parsed.port ?? (requestIsHttps(req) ? "443" : "80");
  return { host: parsed.host, port };
}

/** Whether the inbound request looks like https (direct TLS or proxied). */
export function requestIsHttps(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Resolve the absolute, host-validated origin (`scheme://host`) for `req`.
 *
 * Applies the canonical-origin → allowlisted-request-host → safe-default order
 * documented in the module header. A forged or unknown request host is never
 * embedded. Returns an origin with NO trailing slash.
 *
 * `extraAllowedHosts` — see `pickTrustedHost`.
 */
export async function resolveTrustedOriginUrl(
  req: Request,
  extraAllowedHosts?: readonly string[],
): Promise<string> {
  const origin = await resolveTrustedOrigin();
  const picked = pickTrustedHost(req, origin, extraAllowedHosts);

  if (picked) {
    // The canonical origin is always https. An allowlisted request host is
    // https when the request arrived over TLS (direct or via
    // `x-forwarded-proto`) or when it matches one of the box's trusted origins
    // — which, in every production case, is the https LAN/public origin. (The
    // only non-https trusted origin is the dev dashboard at
    // http://localhost:3001.) Upgrading to https is the safe direction.
    const https =
      origin.canonicalHost === picked
        ? origin.canonicalIsHttps
        : requestIsHttps(req) || origin.allowedHosts.has(picked);
    const protocol = https ? "https" : "http";
    return `${protocol}://${picked}`;
  }

  // Safe default: the box's first trusted origin. Never the forged header.
  const fallback = trustedOrigins()[0] ?? DEFAULT_TRUSTED_ORIGIN;
  return fallback.replace(/\/+$/, "");
}

/**
 * Build an absolute, host-validated URL for `req` at `path`.
 *
 * `path` is appended to the resolved trusted origin with exactly one leading
 * slash (a missing leading slash is added; the origin never carries a trailing
 * one). Use this for every orchestrator-generated absolute URL whose host would
 * otherwise come straight from the request header.
 *
 * `extraAllowedHosts` — see `pickTrustedHost`.
 */
export async function trustedOriginUrl(
  req: Request,
  path: string,
  extraAllowedHosts?: readonly string[],
): Promise<string> {
  const base = await resolveTrustedOriginUrl(req, extraAllowedHosts);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

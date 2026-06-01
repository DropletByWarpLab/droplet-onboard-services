/**
 * PR #377 (WARP-___) — WebAuthn Relying Party config.
 *
 * rpID + origin are derived FROM THE REQUEST, never hardcoded and never read
 * from a new env var (architecture-guard rule 11: no new MATTER_*; reuse the
 * existing config posture). The orchestrator already builds request-relative
 * URLs this exact way — `getRedirectUri` and `buildInviteUrl` in routes/auth.ts
 * read `req.headers.host` + `x-forwarded-proto`. Reusing that derivation is
 * what makes passkeys work on the LAN with the WAN down: the rpID/origin
 * reflect whatever host the browser actually used to reach the box
 * (`droplet.local`, `droplet-ai.local`, a bare LAN IP), so there is nothing to
 * resolve against the internet.
 *
 * WebAuthn rules this encodes:
 *   - `origin` is the full `scheme://host[:port]` the ceremony ran on; the
 *     authenticator binds the assertion to it and the server re-checks it.
 *   - `rpID` is the host WITHOUT scheme or port. It must be a registrable
 *     domain suffix of the origin's host — for a single LAN host the hostname
 *     itself is the natural RP ID.
 */
import type { Request } from "express";

/**
 * Human-readable Relying Party name shown in the OS/browser passkey prompt
 * ("Save a passkey for Droplet"). Not a host and not a secret — a constant,
 * matching the DROPLET_MATTER_CONTROLLER_NAME default. No env var needed.
 */
export const WEBAUTHN_RP_NAME = "Droplet";

export interface WebAuthnRp {
  /** RP ID — the origin's hostname, no scheme, no port. */
  rpID: string;
  /** Full origin the ceremony runs on: `scheme://host[:port]`. */
  origin: string;
  /** Display name for the authenticator prompt. */
  rpName: string;
}

/** Resolve the request scheme, preferring the gateway's x-forwarded-proto. */
function resolveProtocol(req: Request): "http" | "https" {
  const xf = req.headers["x-forwarded-proto"];
  if (typeof xf === "string" && xf.length > 0) {
    // x-forwarded-proto can be a comma list ("https,http") behind chained
    // proxies — the first hop is the client-facing scheme.
    return xf.split(",")[0]!.trim() === "https" ? "https" : "http";
  }
  return req.secure ? "https" : "http";
}

/** Resolve the request host (incl. port), preferring x-forwarded-host. */
function resolveHost(req: Request): string {
  const xfHost = req.headers["x-forwarded-host"];
  if (typeof xfHost === "string" && xfHost.length > 0) {
    return xfHost.split(",")[0]!.trim();
  }
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0) return host;
  // No Host header at all is pathological for a browser request; fail safe to
  // localhost so the ceremony errors loudly rather than minting a bogus rpID.
  return "localhost";
}

/** Strip the `:port` suffix from a host to get the bare rpID hostname.
 *  IPv6 literals arrive bracketed (`[::1]:3000`) — keep the brackets off. */
function hostnameOnly(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host : host.slice(1, close);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Derive the WebAuthn RP config (rpID + origin + rpName) for a request.
 */
export function deriveWebAuthnRp(req: Request): WebAuthnRp {
  const protocol = resolveProtocol(req);
  const host = resolveHost(req);
  return {
    rpID: hostnameOnly(host),
    origin: `${protocol}://${host}`,
    rpName: WEBAUTHN_RP_NAME,
  };
}

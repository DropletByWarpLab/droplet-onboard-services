/**
 * Plane OIDC IdP signing + JWKS helpers.
 *
 * WARP-505 — spec WARP-498 OQ6. The orchestrator is a minimal OIDC IdP
 * for the embedded Plane PM stack. ID tokens are signed with RS256
 * (Plane verifies via JWKS — HMAC won't work because Plane fetches the
 * public key from /api/pm/oidc/.well-known/jwks.json).
 *
 * The private key (PEM) and key id (kid) come from `setup.sh`-generated
 * secrets pinned in `.env` as `DROPLET_PM_OIDC_PRIVATE_KEY_PEM` +
 * `DROPLET_PM_OIDC_KID`. Operators rotate by re-running
 * `setup.sh --regenerate-pm-oidc-key`.
 *
 * Access tokens are SHORT-LIVED signed JWTs too (same key) — userinfo
 * verifies the bearer JWT directly without a Redis lookup.
 */

import { createPublicKey } from "node:crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";

import { config } from "../config.js";

export const ID_TOKEN_TTL_SECONDS = 5 * 60; // 5 min — short, matches typical OIDC.
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min.

export interface IdTokenClaims {
  sub: string;
  email: string;
  first_name?: string;
  last_name?: string;
  /** OIDC nonce from /authorize, echoed back so Plane can detect replays. */
  nonce: string;
  aud: string;
  iss: string;
}

export interface AccessTokenClaims {
  sub: string;
  scope: string;
  aud: string;
  iss: string;
}

/** Stable issuer URL — Plane verifies tokens against this. */
export function oidcIssuer(): string {
  // gateway URL with /api/pm/oidc as the realm. DROPLET_PM_WEB_URL ends
  // at /pm; the IdP itself lives one level up on the same host so we
  // strip the trailing /pm before appending.
  const base = config.DROPLET_PM_WEB_URL.replace(/\/pm\/?$/, "");
  return `${base}/api/pm/oidc`;
}

function getPrivateKey(): string {
  const raw = config.DROPLET_PM_OIDC_PRIVATE_KEY_PEM;
  if (!raw) {
    throw new Error(
      "DROPLET_PM_OIDC_PRIVATE_KEY_PEM is empty — run setup.sh to generate the OIDC keypair",
    );
  }
  // setup.sh writes the PEM as a single \n-escaped line so the .env file
  // stays parseable by every consumer. Decode back to real newlines for
  // node:crypto's parser. Idempotent against either form (the bash
  // assignment may or may not have escaped depending on shell quoting).
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function getKid(): string {
  const kid = config.DROPLET_PM_OIDC_KID;
  if (!kid) {
    throw new Error(
      "DROPLET_PM_OIDC_KID is empty — run setup.sh to generate the OIDC keypair",
    );
  }
  return kid;
}

/** Sign an OIDC ID token for the given user. */
export function signIdToken(claims: Omit<IdTokenClaims, "aud" | "iss">): string {
  const payload: IdTokenClaims = {
    ...claims,
    aud: config.DROPLET_PM_OIDC_CLIENT_ID,
    iss: oidcIssuer(),
  };
  return jwt.sign(payload, getPrivateKey(), {
    algorithm: "RS256",
    expiresIn: ID_TOKEN_TTL_SECONDS,
    keyid: getKid(),
  });
}

/** Sign an OAuth access token (also an RS256 JWT — userinfo verifies it). */
export function signAccessToken(userId: string, scope = "openid email profile"): string {
  const payload: AccessTokenClaims = {
    sub: userId,
    scope,
    aud: config.DROPLET_PM_OIDC_CLIENT_ID,
    iss: oidcIssuer(),
  };
  return jwt.sign(payload, getPrivateKey(), {
    algorithm: "RS256",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    keyid: getKid(),
  });
}

/** Verify an access token presented at /userinfo. Returns claims or null. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    // RS256 verifies with the public key. Derive it from the private key —
    // avoids shipping two env vars and a synchronisation foot-gun.
    const pub = createPublicKey(getPrivateKey())
      .export({ format: "pem", type: "spki" })
      .toString();
    const decoded = jwt.verify(token, pub, {
      algorithms: ["RS256"],
      issuer: oidcIssuer(),
      audience: config.DROPLET_PM_OIDC_CLIENT_ID,
    });
    return decoded as AccessTokenClaims;
  } catch {
    return null;
  }
}

/** Build the public JWK that goes in /.well-known/jwks.json. */
export function publicJwk(): Record<string, string> {
  const pub = createPublicKey(getPrivateKey());
  const jwk = pub.export({ format: "jwk" }) as Record<string, string>;
  return {
    ...jwk,
    use: "sig",
    alg: "RS256",
    kid: getKid(),
  };
}

/**
 * Validate Plane's client-secret presentation at /token.
 * Plane sends it either via Basic auth or form-encoded body.
 */
export function verifyClientSecret(presented: string): boolean {
  const expected = config.DROPLET_PM_OIDC_CLIENT_SECRET;
  if (!expected) return false;
  // Constant-time compare via Buffer length + crypto.timingSafeEqual would
  // be ideal; for now a length-guard + direct compare matches the existing
  // SERVICE_TOKEN_* pattern in middleware/auth.ts.
  if (presented.length !== expected.length) return false;
  return presented === expected;
}

/** Decoded export — useful for the discovery doc to surface supported algs. */
export const SUPPORTED_ID_TOKEN_ALGS = ["RS256"] as const;
export const SUPPORTED_RESPONSE_TYPES = ["code"] as const;
export const SUPPORTED_GRANT_TYPES = ["authorization_code"] as const;
export const SUPPORTED_SCOPES = ["openid", "email", "profile"] as const;

// Re-export for ergonomics in route handlers; the underlying lib stays
// behind this single import surface.
export type { JwtPayload };

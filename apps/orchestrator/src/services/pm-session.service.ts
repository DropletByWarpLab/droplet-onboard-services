/**
 * Plane OIDC authorization-code cache.
 *
 * WARP-505 — minimal OIDC IdP per spec WARP-498 OQ6 (resolved 2026-05-28
 * after Plane API verification showed Plane's only SSO path is OIDC).
 *
 * Flow: when the dashboard user lands on /api/pm/oidc/authorize, the
 * orchestrator mints a short-lived authorization code, stashes
 * { user_id, nonce, redirect_uri, code_challenge?, code_challenge_method? }
 * here, and redirects to Plane's callback. Plane then POSTs to /token
 * within the TTL window, presenting the code; we look it up here, return
 * an ID token + access token, and delete the code (single-use).
 *
 * Single-use semantics implemented at the consume call site
 * (`consumeOidcCode`) — Redis DEL after read.
 *
 * TTL is 60s per RFC 6749 §10.5 ("authorization codes MUST be short
 * lived") — typical OIDC providers use 60–300s.
 *
 * Previously this file held a Plane-session-token cache for the
 * admin-API-mints-session-token approach; that approach is dead per OQ6.
 * The filename stays the same so the WARP-505 PR diff shows a rewrite,
 * not a rename — matches `pr-scope-and-coherence.md`.
 */

import { getRedis } from "./cache.service.js";

const OIDC_CODE_PREFIX = "oidc:pm:code:";
const CODE_TTL_SECONDS = 60;

export interface OidcCodePayload {
  userId: string;
  nonce: string;
  redirectUri: string;
  /** PKCE — RFC 7636. Optional. */
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}

/**
 * Stash an authorization code for the given user. Single-use; consumed
 * by {@link consumeOidcCode} at the /token endpoint.
 */
export async function storeOidcCode(
  code: string,
  payload: OidcCodePayload,
): Promise<void> {
  await getRedis().set(
    OIDC_CODE_PREFIX + code,
    JSON.stringify(payload),
    "EX",
    CODE_TTL_SECONDS,
  );
}

/**
 * Look up and delete an authorization code. Returns the payload on first
 * successful read; subsequent reads (replay attempts) return null.
 *
 * Implementation uses a multi/exec roundtrip to make the read+delete
 * atomic — no TOCTOU window where a replayed code could succeed twice.
 */
export async function consumeOidcCode(
  code: string,
): Promise<OidcCodePayload | null> {
  const key = OIDC_CODE_PREFIX + code;
  const redis = getRedis();
  const results = await redis.multi().get(key).del(key).exec();
  if (!results) return null;
  const [getResult] = results;
  const [, raw] = getResult as [Error | null, string | null];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OidcCodePayload;
  } catch {
    return null;
  }
}

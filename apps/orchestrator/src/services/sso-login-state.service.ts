/**
 * ADR-013 (PR #378) — server-side single-use, time-bound OIDC login state.
 *
 * The OIDC `state` (CSRF), `nonce` (ID-token replay), and PKCE
 * `codeVerifier` are minted at /sso/oidc/authorize and persisted here, not
 * in a client-readable cookie or the redirect. The browser carries only the
 * opaque `state`; the callback hands that `state` back and we look up the
 * trusted nonce/verifier server-side.
 *
 * `consumeLoginState` performs an ATOMIC conditional claim so a replayed or
 * concurrent callback can't reuse a state: the updateMany only flips rows
 * that are still unconsumed AND unexpired, and exactly one caller observes
 * count===1. Same single-use idiom as `claimRefreshRotation` (jwt.service)
 * and `UserInvite.acceptedAt` (invite-accept).
 */
import type { PrismaClient, SsoLoginState } from "@prisma/client";

import type { SsoProvider } from "./sso-oidc.service.js";

/** Default authorize→callback window. Short — a real sign-in completes in
 *  seconds; an abandoned flow must not be resumable minutes later. */
export const SSO_LOGIN_STATE_TTL_SECONDS = 10 * 60;

export interface CreateLoginStateInput {
  provider: SsoProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Same-origin relative path to land on after sign-in (validated upstream). */
  returnTo: string;
  ttlSeconds?: number;
}

/** Persist a fresh login-state row. */
export async function createLoginState(
  prisma: PrismaClient,
  input: CreateLoginStateInput,
): Promise<SsoLoginState> {
  const ttl = input.ttlSeconds ?? SSO_LOGIN_STATE_TTL_SECONDS;
  return prisma.ssoLoginState.create({
    data: {
      state: input.state,
      nonce: input.nonce,
      codeVerifier: input.codeVerifier,
      provider: input.provider,
      returnTo: input.returnTo,
      expiresAt: new Date(Date.now() + ttl * 1000),
    },
  });
}

/**
 * Atomically claim the login-state row for `state`. Returns the row (with
 * its trusted nonce/codeVerifier/provider/returnTo) on success, or null if
 * the state is unknown, already consumed (replay), or expired.
 *
 * The claim is a single conditional updateMany so concurrent callbacks
 * race-safely: only one observes count===1. We then fetch the now-consumed
 * row to return its fields.
 */
export async function consumeLoginState(
  prisma: PrismaClient,
  state: string,
): Promise<SsoLoginState | null> {
  const now = new Date();
  const { count } = await prisma.ssoLoginState.updateMany({
    where: {
      state,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (count !== 1) {
    return null;
  }
  // We won the claim; fetch the row to read its trusted fields.
  return prisma.ssoLoginState.findUnique({ where: { state } });
}

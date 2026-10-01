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
 *
 * Native handoff (RFC 8252): a NATIVE row (explicit `flowKind`) also carries
 * the native app's redirect and PKCE challenge. The callback parks only a
 * single-use CONSENT value on it (`parkConsent`, sha256 only); Continue on the
 * consent page trades it for a one-time handoff code with a 60 s clock
 * (`claimConsent`), Cancel burns it with no code (`declineConsent`), and
 * `POST /sso/oidc/native/token` redeems that code once (`consumeHandoff`),
 * all with the same conditional-claim idiom.
 */
import type { PrismaClient, SsoLoginState } from "@prisma/client";

import type { SsoProvider } from "./sso-oidc.service.js";

/** Default authorize→callback window. Short — a real sign-in completes in
 *  seconds; an abandoned flow must not be resumable minutes later. */
export const SSO_LOGIN_STATE_TTL_SECONDS = 10 * 60;

interface CreateLoginStateBase {
  provider: SsoProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Same-origin relative path to land on after sign-in (validated upstream). */
  returnTo: string;
  ttlSeconds?: number;
}

/**
 * BROWSER (the dashboard flow, the default) or NATIVE (RFC 8252 handoff for a
 * native app: the callback parks a one-time code for the app's own redirect
 * instead of setting cookies). The kind is written to an explicit column so
 * the callback never infers it from a null redirect.
 */
export type CreateLoginStateInput =
  | (CreateLoginStateBase & { flowKind?: "BROWSER" })
  | (CreateLoginStateBase & {
      flowKind: "NATIVE";
      /** Loopback or droplet://sso/callback, validated upstream. */
      nativeRedirectUri: string;
      /** The app's PKCE S256 challenge (43-char base64url). */
      nativeCodeChallenge: string;
    });

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
      ...(input.flowKind === "NATIVE"
        ? {
            flowKind: "NATIVE" as const,
            nativeRedirectUri: input.nativeRedirectUri,
            nativeCodeChallenge: input.nativeCodeChallenge,
          }
        : { flowKind: "BROWSER" as const }),
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

/**
 * Read the row for `state` WITHOUT claiming it. The callback uses this only to
 * learn the row's `flowKind` before its cookie check (a NATIVE flow has no
 * browser cookie); the single-use claim is still `consumeLoginState`.
 */
export async function peekLoginState(
  prisma: PrismaClient,
  state: string,
): Promise<SsoLoginState | null> {
  return prisma.ssoLoginState.findUnique({ where: { state } });
}

/**
 * One-time handoff code lifetime. The clock starts when the person presses
 * Continue on the consent page (ADR-063 S5), not when the page is shown: the
 * page itself lives as long as the state row (`SSO_LOGIN_STATE_TTL_SECONDS`).
 */
export const SSO_NATIVE_HANDOFF_TTL_SECONDS = 60;

export interface ParkConsentInput {
  /** sha256 (hex) of the single-use consent value embedded in the page. */
  consentHash: string;
  /** Local User.id the callback resolved. */
  userId: string;
}

/**
 * Bind a pending consent to a NATIVE row: the callback stores the hash of the
 * page's single-use value and the person it resolved, and NO handoff code
 * exists yet. The write is conditional on `flowKind = NATIVE` and on no code
 * having been minted, so a browser row can never be turned into a handoff; a
 * miss throws (the callback then fails closed with a 500, minting nothing).
 */
export async function parkConsent(
  prisma: PrismaClient,
  stateId: string,
  input: ParkConsentInput,
): Promise<void> {
  const { count } = await prisma.ssoLoginState.updateMany({
    where: { id: stateId, flowKind: "NATIVE", handoffCodeHash: null },
    data: { nativeConsentHash: input.consentHash, handoffUserId: input.userId },
  });
  if (count !== 1) {
    throw new Error("SSO consent: no NATIVE login-state row to attach the consent to");
  }
}

/**
 * The person pressed Continue: atomically trade the page's single-use consent
 * value for a handoff code (`codeHash`, sha256 only) with a fresh 60 s clock.
 * Returns the row (redirect, state, provider, the person) on success, or null
 * if the value is unknown, already used (replay, a double click) or the state
 * row has expired (the page's own lifetime). Same race-safe conditional claim
 * as `consumeLoginState`: exactly one caller sees count===1, and the consent
 * value is cleared by the claim so it can never mint a second code.
 */
export async function claimConsent(
  prisma: PrismaClient,
  consentHash: string,
  codeHash: string,
): Promise<SsoLoginState | null> {
  const row = await prisma.ssoLoginState.findUnique({
    where: { nativeConsentHash: consentHash },
  });
  if (!row) return null;
  const handoffExpiresAt = new Date(Date.now() + SSO_NATIVE_HANDOFF_TTL_SECONDS * 1000);
  const { count } = await prisma.ssoLoginState.updateMany({
    where: {
      id: row.id,
      nativeConsentHash: consentHash,
      flowKind: "NATIVE",
      handoffCodeHash: null,
      expiresAt: { gt: new Date() },
    },
    data: { nativeConsentHash: null, handoffCodeHash: codeHash, handoffExpiresAt },
  });
  if (count !== 1) return null;
  return { ...row, nativeConsentHash: null, handoffCodeHash: codeHash, handoffExpiresAt };
}

/**
 * The person pressed Cancel: atomically burn the page's single-use consent
 * value WITHOUT minting a code. Same conditional claim as `claimConsent`, so a
 * Cancel and a Continue racing on one page cannot both win, and a spent page
 * can do neither. Returns the row (redirect, state, provider, the person) so
 * the route can audit the refusal and relay `access_denied`, or null if the
 * value is unknown, already used or the state row has expired.
 */
export async function declineConsent(
  prisma: PrismaClient,
  consentHash: string,
): Promise<SsoLoginState | null> {
  const row = await prisma.ssoLoginState.findUnique({
    where: { nativeConsentHash: consentHash },
  });
  if (!row) return null;
  const { count } = await prisma.ssoLoginState.updateMany({
    where: {
      id: row.id,
      nativeConsentHash: consentHash,
      flowKind: "NATIVE",
      handoffCodeHash: null,
      expiresAt: { gt: new Date() },
    },
    data: { nativeConsentHash: null },
  });
  if (count !== 1) return null;
  return { ...row, nativeConsentHash: null };
}

/**
 * Atomically redeem a handoff by its code hash. Returns the row (with the
 * app's `nativeCodeChallenge` and the `handoffUserId`) on success, or null if
 * the code is unknown, already redeemed (replay) or expired. Same race-safe
 * conditional claim as `consumeLoginState`: exactly one caller sees count===1.
 */
export async function consumeHandoff(
  prisma: PrismaClient,
  codeHash: string,
): Promise<SsoLoginState | null> {
  const now = new Date();
  const { count } = await prisma.ssoLoginState.updateMany({
    where: {
      handoffCodeHash: codeHash,
      flowKind: "NATIVE",
      handoffConsumedAt: null,
      handoffExpiresAt: { gt: now },
    },
    data: { handoffConsumedAt: now },
  });
  if (count !== 1) {
    return null;
  }
  return prisma.ssoLoginState.findUnique({ where: { handoffCodeHash: codeHash } });
}

/**
 * Grace window before a CONSUMED row becomes eligible for pruning. Closes a
 * TOCTOU race with `consumeLoginState`: that function first atomically claims
 * the row (sets `consumedAt`) and THEN reads it back with `findUnique` to
 * return its trusted nonce/codeVerifier. Without a grace window a prune firing
 * between the claim and the read would delete the row the winning caller is
 * about to read, turning a legitimate sign-in into a spurious null. The
 * claim→read gap is sub-millisecond, so any non-trivial grace fully removes
 * the race while consumed rows still drain the same night (they're well past
 * the grace by 03:00). Expired-but-unconsumed rows have no such race
 * (`consumeLoginState`'s claim requires `expiresAt > now`, so it never reads an
 * expired row) and are pruned immediately. */
export const SSO_LOGIN_STATE_PRUNE_GRACE_MS = 60 * 1000; // 1 minute

/** Rows deleted per `deleteMany` statement; mirrors audit-retention-purge. */
const DEFAULT_PRUNE_BATCH_SIZE = 5000;
/** Hard upper bound on rows removed per run; mirrors audit-retention-purge. */
const DEFAULT_PRUNE_MAX_ROWS = 100_000;

export interface PruneOptions {
  /** Rows deleted per `deleteMany` statement. Default 5000. */
  batchSize?: number;
  /**
   * Hard upper bound on rows removed per run. Bounds the wall-clock of the
   * run so the shared 60 s advisory-lock `$transaction` in the daily-purge
   * cron can't time out on a huge first-run backlog; the remainder drains on
   * subsequent nights. Default 100_000.
   */
  maxRowsPerRun?: number;
  /** Injectable clock for deterministic tests. Default `new Date()`. */
  now?: Date;
}

/**
 * Prune spent (consumed) and abandoned (expired) login-state rows. `create`
 * and `consumeLoginState` are the only writers and neither deletes, so on an
 * SSO-enabled box this table grows unbounded. Consumed rows are single-use and
 * useless once claimed; expired rows are past the short authorize→callback
 * window and can never be consumed again. Wired to the 03:00 daily purge in
 * index.ts (NOT a `while True`) — losing a tick is harmless because
 * consumeLoginState independently rejects consumed/expired rows.
 *
 * Bounded + capped (same precedent as audit-retention-purge.service.ts,
 * "Finding 2 / PR #623"): the daily-purge cron handler runs INSIDE a single
 * 60 s advisory-lock `prisma.$transaction` (cron-runtime `withAdvisoryLock`).
 * This table accumulated forever on an SSO box, so a first-run / long-idle box
 * can hold a months-deep backlog. One unbounded `deleteMany` scanning that
 * whole backlog could push the handler past 60 s → P2028 → the transaction
 * rolls back EVERY purge in the tick and retries the same oversized set every
 * night forever. Instead we delete in bounded batches (each `deleteMany` short
 * and index-bounded) capped per run, so the run is provably short and the
 * backlog drains over nights.
 *
 * A CONSUMED row is only eligible once its `consumedAt` is older than
 * `SSO_LOGIN_STATE_PRUNE_GRACE_MS` — see that constant for the TOCTOU rationale
 * vs `consumeLoginState`'s claim-then-read.
 */
export async function pruneExpiredLoginStates(
  prisma: PrismaClient,
  options: PruneOptions = {},
): Promise<number> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE);
  const maxRowsPerRun = Math.max(
    1,
    options.maxRowsPerRun ?? DEFAULT_PRUNE_MAX_ROWS,
  );
  const now = options.now ?? new Date();
  const consumedCutoff = new Date(
    now.getTime() - SSO_LOGIN_STATE_PRUNE_GRACE_MS,
  );

  // A row is prunable when it was consumed before the grace cutoff, OR it was
  // never consumed and is expired. Guarding the expired branch on
  // `consumedAt: null` guarantees a freshly-consumed row (even one that has
  // since expired) is never swept inside the grace window.
  //
  // A consumed NATIVE row may still carry a redeemable handoff: the callback
  // claims the state BEFORE the IdP code exchange, and Continue mints the
  // handoff up to the state's own 10 minutes later, so it can land well after
  // `consumedAt`. Such a row is spared until its handoff is past the same
  // grace window (which also covers `consumeHandoff`'s claim-then-read), and,
  // while a consent value is still pending (the page is live), until the state
  // itself has expired. A NATIVE row with neither (the callback failed) goes
  // like a browser row.
  const where = {
    OR: [
      {
        AND: [
          { consumedAt: { lt: consumedCutoff } },
          {
            OR: [
              { flowKind: "BROWSER" as const },
              {
                AND: [
                  {
                    OR: [
                      { handoffExpiresAt: null },
                      { handoffExpiresAt: { lt: consumedCutoff } },
                    ],
                  },
                  { OR: [{ nativeConsentHash: null }, { expiresAt: { lt: now } }] },
                ],
              },
            ],
          },
        ],
      },
      { AND: [{ consumedAt: null }, { expiresAt: { lt: now } }] },
    ],
  };

  let deleted = 0;
  while (deleted < maxRowsPerRun) {
    const take = Math.min(batchSize, maxRowsPerRun - deleted);
    const batch = await prisma.ssoLoginState.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    if (batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    const { count } = await prisma.ssoLoginState.deleteMany({
      where: { id: { in: ids } },
    });
    deleted += count;
    // Short batch means we've drained everything currently prunable — done.
    if (batch.length < take) break;
  }
  return deleted;
}

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
  const where = {
    OR: [
      { consumedAt: { lt: consumedCutoff } },
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

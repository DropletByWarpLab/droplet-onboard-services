/**
 * WARP-3193 — the per-user current-password throttle, moved verbatim out of
 * routes/auth.ts so the credential step-up gate
 * (middleware/require-credential-step-up.ts) shares ONE counter with
 * POST /auth/change-password: both guess the same secret, so separate
 * counters would let a hijacked session alternate between them.
 */
import { cacheGet, cacheSet, cacheDel, cacheIncr } from "./cache.service.js";

/**
 * Progressive backoff for failed current-password checks on
 * POST /auth/change-password (PR #549 reviewer follow-up: without a lockout
 * the endpoint is a current-password brute-force oracle for whoever holds a
 * session cookie). Mirrors the WARP-631 claim-code model: a small free tier,
 * then FIXED escalating locks that always elapse on their own; the failure
 * counter resets after an hour without failures and on a successful verify.
 * Keyed by user id — the gate protects the ACCOUNT's password, and a NATed
 * household shares one IP. Fails OPEN on cache errors so a flaky Redis can
 * never lock a legitimate user out of rotating their password.
 */
const PW_CHANGE_FREE_TIER = 5;
/** Lock seconds for the 1st, 2nd, 3rd … lock; the last value is the cap. */
const PW_CHANGE_BACKOFF_SCHEDULE = [30, 60, 120, 300, 900] as const;
/** Failure counter resets after an hour of no failures (rolling window). */
const PW_CHANGE_FAILS_TTL_SEC = 60 * 60;

function pwChangeFailsKey(userId: string): string {
  return `ratelimit:change-password:fails:${userId}`;
}
function pwChangeLockKey(userId: string): string {
  return `ratelimit:change-password:lock:${userId}`;
}

/** PURE schedule map (failure count → lock seconds). Exported for tests. */
export function passwordChangeBackoffSeconds(failureCount: number): number {
  const idx = failureCount - PW_CHANGE_FREE_TIER - 1;
  if (idx < 0) return 0;
  return PW_CHANGE_BACKOFF_SCHEDULE[
    Math.min(idx, PW_CHANGE_BACKOFF_SCHEDULE.length - 1)
  ];
}

export async function checkPasswordChangeLock(
  userId: string,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  try {
    const until = (await cacheGet<number>(pwChangeLockKey(userId))) ?? 0;
    const now = Date.now();
    if (until > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    return { locked: false, retryAfterSeconds: 0 };
  } catch {
    return { locked: false, retryAfterSeconds: 0 };
  }
}

/** Counts one failure. Resolves true when this failure started a lockout. */
export async function recordPasswordChangeFailure(userId: string): Promise<boolean> {
  try {
    // cacheIncr is atomic (Redis INCR) — avoids the read-modify-write race
    // where two concurrent wrong-password requests both read N and both write
    // N+1, keeping the counter artificially low.
    const next = await cacheIncr(pwChangeFailsKey(userId), PW_CHANGE_FAILS_TTL_SEC);
    if (next === null) return false; // Redis error — fail open
    const lockedSeconds = passwordChangeBackoffSeconds(next);
    if (lockedSeconds > 0) {
      await cacheSet(
        pwChangeLockKey(userId),
        Date.now() + lockedSeconds * 1000,
        lockedSeconds,
      );
      return true;
    }
    return false;
  } catch {
    // fail open — see the model comment above.
    return false;
  }
}

export async function clearPasswordChangeRateState(userId: string): Promise<void> {
  try {
    await cacheDel(pwChangeFailsKey(userId));
    await cacheDel(pwChangeLockKey(userId));
  } catch {
    // fail open.
  }
}

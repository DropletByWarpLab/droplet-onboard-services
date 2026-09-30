/**
 * WARP-3180 — the one throttled credential check shared by the credential
 * step-up (require-credential-step-up.ts) and POST /auth/step-up, so the two
 * can't drift. Uses the per-user counter of POST /auth/change-password: the
 * three routes cannot be alternated to multiply guesses.
 *
 * `check` runs only when the user isn't locked out; a false result counts as
 * one failure. `lockedNow` is true when THIS failure started a lockout, so a
 * caller can audit the transition instead of every refused attempt.
 */
import {
  checkPasswordChangeLock,
  clearPasswordChangeRateState,
  recordPasswordChangeFailure,
} from "./password-change-throttle.service.js";

export type ThrottledCheckResult =
  | { outcome: "ok" }
  | { outcome: "locked"; retryAfterSeconds: number }
  | { outcome: "invalid"; lockedNow: boolean };

export async function throttledCredentialCheck(
  userId: string,
  check: () => Promise<boolean>,
): Promise<ThrottledCheckResult> {
  const lock = await checkPasswordChangeLock(userId);
  if (lock.locked) return { outcome: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  if (!(await check())) {
    return { outcome: "invalid", lockedNow: (await recordPasswordChangeFailure(userId)) === true };
  }
  await clearPasswordChangeRateState(userId);
  return { outcome: "ok" };
}

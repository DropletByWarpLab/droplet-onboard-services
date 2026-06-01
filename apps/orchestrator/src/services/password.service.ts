import argon2 from "argon2";

/**
 * ADR-012 — built-in argon2id directory.
 *
 * Vetted-library boundary for password hashing + verification. The
 * built-in directory (`User.passwordHash`) is the auth source of truth;
 * every credential check in the orchestrator flows through this module.
 *
 * Library: `argon2` (npm) — a thin native binding over the reference
 * Argon2 C implementation, the PHC-winner and OWASP's first-choice
 * password hash. Argon2id variant only (hybrid; resists both GPU and
 * side-channel attacks). NEVER bcrypt.
 *
 * Tuned parameters (PASSWORD_HASH_PARAMS) sit at the OWASP Password
 * Storage Cheat Sheet floor for argon2id — m=19 MiB, t=2, p=1 — which is
 * the recommended minimum that still verifies in well under a second on
 * the single-box appliance's CPU. The params travel inside the PHC
 * string argon2 emits, so `verifyPassword` re-derives them per-row: we
 * can raise this floor later and old rows keep verifying against the
 * params they were minted with.
 *
 * Security invariants:
 *   - NEVER log or stringify a hash or a password. This module takes no
 *     logger and returns only booleans + the (already public) PHC hash.
 *   - `verifyPassword` uses argon2's constant-time comparison and never
 *     throws on a malformed stored value — a corrupt/foreign row reads
 *     as "auth failed", it does not crash the caller.
 *   - `verifyDummyPassword` lets the login route spend comparable CPU on
 *     the unknown-account branch so an attacker can't distinguish
 *     "no such email" from "wrong password" by timing (user enumeration).
 */

/**
 * Argon2id tuning. Introspectable so the ADR, the migration notes, and
 * the test suite assert against the same numbers that actually run.
 *
 * OWASP floor (argon2id): memoryCost >= 19456 KiB, timeCost >= 2,
 * parallelism >= 1.
 */
export const PASSWORD_HASH_PARAMS = {
  type: "argon2id" as const,
  /** 19 MiB — OWASP-recommended minimum for argon2id. */
  memoryCost: 19456,
  /** Iterations. */
  timeCost: 2,
  /** Lanes / degree of parallelism. */
  parallelism: 1,
} as const;

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: PASSWORD_HASH_PARAMS.memoryCost,
  timeCost: PASSWORD_HASH_PARAMS.timeCost,
  parallelism: PASSWORD_HASH_PARAMS.parallelism,
};

/**
 * A pre-computed argon2id hash of a throwaway secret, used only to burn a
 * comparable amount of CPU on the unknown-account login branch. Computed
 * lazily on first use and cached so we don't pay the cost at import time.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    // The plaintext here is irrelevant — it's never a valid credential.
    dummyHashPromise = argon2.hash(
      "anti-enumeration-placeholder-not-a-real-password",
      ARGON2_OPTIONS,
    );
  }
  return dummyHashPromise;
}

/**
 * Hash a plaintext password with the tuned argon2id parameters. Returns a
 * self-describing PHC string (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`)
 * suitable for storage in `User.passwordHash`. A fresh random salt is
 * generated per call by the library, so identical passwords hash to
 * different strings.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time verification of a plaintext against a stored argon2id PHC
 * hash. Returns true on match, false on mismatch.
 *
 * Returns false (does NOT throw) when `storedHash` is empty, malformed, or
 * a foreign format (e.g. a leftover bcrypt row). A corrupt stored value
 * must surface to the login route as an ordinary auth failure, not a 500.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    // Malformed/unsupported hash string — treat as auth failure.
    return false;
  }
}

/**
 * Anti-enumeration helper. Verifies the supplied password against a dummy
 * hash and always returns false. The login route calls this on the
 * unknown-email branch so the wall-clock cost of "no such account" is
 * comparable to "account exists, wrong password" — denying an attacker a
 * timing oracle for which emails are registered.
 */
export async function verifyDummyPassword(plaintext: string): Promise<boolean> {
  try {
    const dummy = await getDummyHash();
    await argon2.verify(dummy, plaintext);
  } catch {
    // Never surfaces — the dummy hash is well-formed, but stay defensive.
  }
  return false;
}

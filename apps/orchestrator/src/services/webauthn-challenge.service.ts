/**
 * PR #377 (WARP-___) — WebAuthn ceremony challenge store.
 *
 * Server-side, single-use, time-bound challenges back both the registration
 * and authentication ceremonies. They are the replay defence: the server
 * mints a random challenge, persists it, and hands the base64url value to the
 * browser; on verify the row is resolved by value + ceremony type, checked for
 * expiry, and DELETEd. A captured challenge therefore can never be replayed —
 * single-use is enforced by consume-by-delete and the time bound by
 * `expiresAt`.
 *
 * Mirrors invite.service.ts conventions: `prisma` is passed in, challenges are
 * `randomBytes(...).toString("base64url")`, types come from `@prisma/client`.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient, WebAuthnChallenge, WebAuthnChallengeType } from "@prisma/client";

/**
 * Challenge lifetime. WebAuthn ceremonies are interactive (touch the key /
 * face-scan) but should complete quickly; a short TTL shrinks the replay
 * window. Named constant — no magic number, per the project no-guessing rule.
 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Challenge entropy. 32 bytes -> 43 base64url chars; well above the WebAuthn
 *  spec's 16-byte floor. A guessable challenge defeats the replay defence. */
const CHALLENGE_BYTES = 32;

export interface CreateChallengeInput {
  type: WebAuthnChallengeType;
  /** Non-null for the registration ceremony (bound to the signed-in user);
   *  null for the passwordless authenticate ceremony. */
  userId: string | null;
}

/**
 * Mint + persist a fresh ceremony challenge and return its base64url value.
 *
 * The returned string is what the route hands to `@simplewebauthn/server`'s
 * options generator (as the `challenge`) and ultimately to the browser.
 */
export async function createChallenge(
  prisma: PrismaClient,
  input: CreateChallengeInput,
): Promise<string> {
  const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
  await prisma.webAuthnChallenge.create({
    data: {
      challenge,
      type: input.type,
      userId: input.userId,
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return challenge;
}

/**
 * Resolve, validate, and CONSUME a challenge.
 *
 * Returns the row on success (caller reads `userId` for the registration
 * binding). Returns null — having deleted any matching row it could — when the
 * challenge is unknown, was minted for a different ceremony `type`, or has
 * expired. The delete makes the call single-use: a replayed challenge resolves
 * to null on the second pass.
 *
 * The delete is best-effort against a concurrent consume: if two requests race
 * the same challenge, the loser's delete throws (row already gone) and we treat
 * it as a miss — exactly the anti-replay behaviour we want.
 */
export async function consumeChallenge(
  prisma: PrismaClient,
  challenge: string,
  type: WebAuthnChallengeType,
): Promise<WebAuthnChallenge | null> {
  const row = await prisma.webAuthnChallenge.findUnique({ where: { challenge } });
  if (!row) return null;

  // Wrong ceremony — a registration challenge must never satisfy an
  // authenticate verify (or vice-versa). Leave the row in place: it may still
  // be valid for its own ceremony, and deleting it here would let an attacker
  // burn a victim's live challenge by replaying it against the wrong endpoint.
  if (row.type !== type) return null;

  // Expired or correct-ceremony: in both cases the row is now spent. Delete it
  // (consume-by-delete = single-use) and decide validity on `expiresAt`.
  try {
    await prisma.webAuthnChallenge.delete({ where: { id: row.id } });
  } catch {
    // Lost a race to a concurrent consume — the other request already deleted
    // it. Treat as a miss so the challenge can't be used twice.
    return null;
  }

  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

/**
 * Prune abandoned (expired) challenges. Ceremonies the user walked away from
 * leave rows that consumeChallenge never reaches; this keeps the table from
 * growing unbounded. Wired to the cron runtime (NOT a `while True`), called
 * opportunistically — losing a tick is harmless because consumeChallenge
 * independently rejects anything past `expiresAt`.
 */
export async function pruneExpiredChallenges(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.webAuthnChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}

import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "./password.service.js";

/**
 * One-time recovery codes — the backup second factor when an owner loses
 * their authenticator app.
 *
 * Codes are minted alongside TOTP enrollment confirmation, shown to the
 * user EXACTLY ONCE, and only their argon2id hashes are persisted. We
 * reuse `password.service` for hashing/verification so recovery codes get
 * the same vetted argon2id treatment as passwords — no second hashing
 * scheme, no plaintext at rest, no code in any log line.
 *
 * Each code is single-use: at login a candidate is matched against the
 * user's UNUSED hashes; the matching hash is returned so the caller marks
 * exactly that `RecoveryCode` row consumed (`usedAt`), and a replay of the
 * same code then matches nothing.
 */

/** How many backup codes to mint per enrollment. */
export const RECOVERY_CODE_COUNT = 10;

/** Characters per group, and groups per code → `xxxx-xxxx`. */
const GROUP_LEN = 4;
const GROUP_COUNT = 2;

/**
 * Unambiguous lowercase alphabet for the human-typed code. Crockford-ish:
 * digits + letters with the visually-confusable set (`i l o u 0 1`)
 * removed so a customer reading a code off a screen doesn't fat-finger it.
 */
const CODE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

export interface GeneratedRecoveryCodes {
  /** Plaintext codes — surface to the user once, then discard. */
  plaintext: string[];
  /** argon2id hashes, positionally aligned with `plaintext`. */
  hashes: string[];
}

/** Normalize a user-supplied code to the canonical comparison form. */
function normalizeCode(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Draw one random group of `GROUP_LEN` chars from the safe alphabet. */
function randomGroup(): string {
  let out = "";
  for (let i = 0; i < GROUP_LEN; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

/** Mint one formatted code, e.g. `3f9a-b2c7`. */
function mintCode(): string {
  const groups: string[] = [];
  for (let i = 0; i < GROUP_COUNT; i++) groups.push(randomGroup());
  return groups.join("-");
}

/**
 * Mint {@link RECOVERY_CODE_COUNT} distinct recovery codes and their
 * argon2id hashes. The returned arrays are positionally aligned:
 * `hashes[i]` is the hash of `plaintext[i]`.
 */
export async function generateRecoveryCodes(): Promise<GeneratedRecoveryCodes> {
  const plaintext = new Set<string>();
  while (plaintext.size < RECOVERY_CODE_COUNT) {
    plaintext.add(mintCode());
  }
  const codes = [...plaintext];
  const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
  return { plaintext: codes, hashes };
}

/**
 * Match a user-supplied recovery code against a list of stored (unused)
 * argon2id hashes. Returns the matching hash so the caller can mark that
 * one row consumed, or null when nothing matches.
 *
 * Checks EVERY hash even after a match is found so the wall-clock cost
 * doesn't leak how many codes remain or where the match sat in the list.
 * Never throws — a malformed candidate or corrupt hash reads as "no match".
 */
export async function findMatchingRecoveryCodeHash(
  candidate: string,
  storedHashes: string[],
): Promise<string | null> {
  const normalized = normalizeCode(candidate);
  if (!normalized) return null;

  let matched: string | null = null;
  for (const hash of storedHashes) {
    // verifyPassword is already constant-time + swallows malformed hashes.
    const ok = await verifyPassword(hash, normalized);
    if (ok && matched === null) {
      matched = hash;
    }
  }
  return matched;
}

/** The slice of Prisma `consumeRecoveryCode` touches. */
type RecoveryCodeStore = {
  recoveryCode: Pick<import("@prisma/client").PrismaClient["recoveryCode"], "findMany" | "updateMany">;
};

export type ConsumeRecoveryCodeResult =
  | { consumed: true; remaining: number }
  | { consumed: false };

/**
 * WARP-3193 ARCH-3 — the ONE recovery-code consume path, shared by
 * POST /auth/login (pre-session second factor) and POST /auth/recovery
 * (live-session step-up), so a hardening fix cannot land on only one copy.
 *
 * Matches against the user's UNUSED codes only, then claims exactly the
 * matched row. Atomic single-use: two concurrent requests presenting the
 * same code both read it unused, but the `usedAt: null` guard means exactly
 * one update flips it (count 1) and the loser sees count 0 → not consumed.
 * Mirrors claimRefreshRotation / invite single-use.
 */
export async function consumeRecoveryCode(
  prisma: RecoveryCodeStore,
  userId: string,
  candidate: string,
): Promise<ConsumeRecoveryCodeResult> {
  const unused = await prisma.recoveryCode.findMany({
    where: { userId, usedAt: null },
  });
  const matchHash = await findMatchingRecoveryCodeHash(
    candidate,
    unused.map((r) => r.codeHash),
  );
  if (!matchHash) return { consumed: false };
  const consumed = unused.find((r) => r.codeHash === matchHash);
  if (!consumed) return { consumed: false };
  const claimed = await prisma.recoveryCode.updateMany({
    where: { id: consumed.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return { consumed: false };
  return { consumed: true, remaining: unused.length - 1 };
}

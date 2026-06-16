/**
 * Onboarding claim service (PR #373 / docs/ONBOARDING_CLAIM.md + #371
 * handoff §2).
 *
 * Verifies a single-use claim code — read off the PyPortal lid display — that
 * binds a fresh appliance to its workspace. This is the verify half of the
 * Claim wizard step; the appliance-lifecycle flip ("unclaimed" → "ready") is
 * driven by the route through the #372 `markApplianceReady` service.
 *
 * SECURITY CONTRACT
 *   - Codes are HASHED AT REST. `hashClaimCode` is a keyed one-way HMAC-SHA256
 *     over the NORMALIZED code (same DEVICE_SECRET-derived approach the
 *     calendar publish token uses). The plaintext never touches the DB, so a
 *     backup / breach / hand-edit can't recover a live code. Verification
 *     re-hashes the candidate and compares hashes in CONSTANT TIME
 *     (timingSafeEqual) — no early-exit byte compare that could leak the code
 *     via response timing.
 *   - The consume is ATOMIC + SINGLE-USE. `consumeClaimCode` runs a conditional
 *     `updateMany WHERE state='available' AND expiresAt > now` inside a
 *     `$transaction` (the WARP-564 pairing-claim pattern). The Postgres row
 *     lock serializes concurrent claimers; the loser flips zero rows and is
 *     reported `already_claimed`. The audit `usedAt` stamp is written in the
 *     SAME transaction that flips `state`, so the two can never disagree.
 *   - State is an EXPLICIT column (`ClaimCodeState`), never derived from
 *     `usedAt IS NULL` (CLAUDE.md no-guessing rule; WARP-218 precedent).
 *   - A wrong code increments the per-code `attempts` counter (lockout /
 *     observability) and returns `invalid` WITHOUT echoing the real code.
 *
 * MINTING / ROTATION IS OUT OF SCOPE (PyPortal display-service, separate PR).
 * Here codes are SEEDED via env/fixture and only verified; `seedClaimCode`
 * lets the boot path / tests materialize the seeded hash idempotently.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import type { PrismaClient } from "@prisma/client";

/** Outcomes the route maps onto HTTP responses. A closed set — never a free
 *  string — so the route's switch is exhaustive. */
export const CLAIM_OUTCOME = {
  /** Code matched an available, unexpired row → appliance can be bound. */
  CLAIMED: "claimed",
  /** Code matched a row that was already consumed (or lost the race) →
   *  short-circuit the wizard to the next step. */
  ALREADY_CLAIMED: "already_claimed",
  /** No available, unexpired row matched (wrong, unknown, or expired code). */
  INVALID: "invalid",
} as const;

export type ClaimOutcome = (typeof CLAIM_OUTCOME)[keyof typeof CLAIM_OUTCOME];

export interface ClaimResult {
  outcome: ClaimOutcome;
}

/**
 * Canonical form of a claim code: uppercase, with every non-alphanumeric
 * character (the "·", "-", spaces the PyPortal / customer may use to group it)
 * stripped. So "DRPL · 7K2Q · 9F4M", "drpl-7k2q-9f4m" and "DRPL7K2Q9F4M" all
 * hash identically. Codes are minted from an unambiguous alphabet (no 0/O/1/I)
 * by the rotation owner; normalization here is purely about grouping/case, not
 * character substitution.
 */
export function normalizeClaimCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * The HMAC key. Mirrors `routes/calendar.ts` publishToken: read
 * `DEVICE_SECRET` from the environment; in production an unset secret is a hard
 * error (every hash would be derivable from a known literal); in dev/test fall
 * back to a deterministic placeholder so a seeded fixture hash is stable.
 */
function claimHmacKey(): string {
  const key = process.env.DEVICE_SECRET;
  if (key) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DEVICE_SECRET must be set to hash claim codes");
  }
  return "dev-only-not-secure";
}

/**
 * One-way keyed hash of a claim code, over its normalized form. Deterministic
 * (so a seeded hash matches at verify time) and keyed (so the hash can't be
 * precomputed without DEVICE_SECRET). Hex-encoded SHA-256 digest.
 */
export function hashClaimCode(code: string): string {
  return createHmac("sha256", claimHmacKey())
    .update(`claim:${normalizeClaimCode(code)}`)
    .digest("hex");
}

/** Constant-time hex-string equality. Both inputs are fixed-length HMAC
 *  digests, but we length-check first so `timingSafeEqual` can't throw on a
 *  malformed candidate. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify + atomically consume a claim code.
 *
 * Flow:
 *   1. Hash the candidate and look up the row by `codeHash` (the unique index).
 *      No match → `invalid` (don't reveal whether a code exists; a wrong code
 *      and an unknown code are indistinguishable to the caller).
 *   2. Re-confirm the hash in constant time. (The unique-index lookup already
 *      equates hashes, but the explicit constant-time compare keeps the
 *      no-timing-leak guarantee independent of how the row was fetched and
 *      guards against any future non-hash lookup path.)
 *   3. Atomic single-use consume inside a `$transaction`: conditional
 *      `updateMany WHERE id=… AND state='available' AND expiresAt > now`.
 *        - count === 1 → we won. Stamp `usedAt` is set by the same update.
 *          Return `claimed`.
 *        - count === 0 → the row exists but is consumed or expired. If it was
 *          consumed, this is an idempotent re-run / lost race → `already_claimed`.
 *          If it was expired, → `invalid` (the code was right but stale).
 *
 * NOTE on `attempts`: this service does not bump the per-code counter (a wrong
 * code has no row to bump). The wrong-guess BUDGET that protects against
 * brute force is enforced in the ROUTE via the shared cache-counter rate limit
 * (no busy-loop). The `ClaimCode.attempts` column is reserved for future
 * per-code lockout once minting/rotation lands.
 */
export async function consumeClaimCode(
  prisma: PrismaClient,
  code: string,
): Promise<ClaimResult> {
  const candidateHash = hashClaimCode(code);

  // Look the row up by its unique hash. A wrong/unknown code has no row.
  const row = await prisma.claimCode.findFirst({
    where: { codeHash: candidateHash },
  });
  if (!row || !constantTimeEqualHex(row.codeHash, candidateHash)) {
    return { outcome: CLAIM_OUTCOME.INVALID };
  }

  // Row exists. The atomic conditional consume decides the outcome — we never
  // branch on a stale read of `state` here (that would be a check-then-act
  // TOCTOU; the WARP-564 fix). `expiresAt > now` makes expiry authoritative at
  // consume time.
  const now = new Date();
  const consume = await prisma.$transaction(async (tx) => {
    return tx.claimCode.updateMany({
      where: { id: row.id, state: "available", expiresAt: { gt: now } },
      data: { state: "consumed", usedAt: now },
    });
  });

  if (consume.count === 1) {
    return { outcome: CLAIM_OUTCOME.CLAIMED };
  }

  // count === 0: the row was not available-and-unexpired at consume time. The
  // pre-consume `row` read can be STALE (under a race the loser read
  // "available" before the winner flipped it), so RE-READ the authoritative
  // current state to classify the outcome — never branch on the snapshot:
  //   - now consumed → idempotent re-run / lost race → already_claimed
  //   - still available (so it failed the `expiresAt > now` predicate) →
  //     invalid (the code was right but stale)
  const fresh = await prisma.claimCode.findFirst({
    where: { codeHash: candidateHash },
  });
  if (fresh?.state === "consumed") {
    return { outcome: CLAIM_OUTCOME.ALREADY_CLAIMED };
  }
  return { outcome: CLAIM_OUTCOME.INVALID };
}

/**
 * Idempotently materialize a seeded claim code (env/fixture provisioning).
 * MINTING/ROTATION is out of scope — this only writes the hash of an
 * externally-provided code so `consumeClaimCode` can verify it. Re-seeding the
 * same code is a no-op (the `codeHash` unique index + skipDuplicates), so a
 * boot-time seed is safe to run on every start.
 *
 * @returns true if a new row was created, false if it already existed.
 */
export async function seedClaimCode(
  prisma: PrismaClient,
  code: string,
  opts: { expiresAt?: Date } = {},
): Promise<boolean> {
  const codeHash = hashClaimCode(code);
  const existing = await prisma.claimCode.findFirst({ where: { codeHash } });
  if (existing) return false;
  // Default a far-future expiry — the rotation owner (PyPortal service, future
  // PR) will manage real TTLs; a seeded env code is meant to stay valid until
  // the box is claimed.
  const expiresAt =
    opts.expiresAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  await prisma.claimCode.create({ data: { codeHash, expiresAt } });
  return true;
}

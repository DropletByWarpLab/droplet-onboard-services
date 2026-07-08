import type { PrismaClient, User } from "@prisma/client";
import {
  deriveEmailColumnKey,
  emailLookupHash,
  encryptColumn,
  decryptColumn,
  isEncryptedColumn,
} from "./column-crypto.service.js";

/**
 * WARP-233 — User.email is PII at rest: stored as a `dcv1:` AES-256-GCM blob
 * under the HKDF-derived email column key, with equality (and the uniqueness
 * guarantee that used to live on email's @unique) moved to `emailLookupHash`,
 * a deterministic HMAC-SHA256 blind index over trim+lowercase(email).
 *
 * Transition contract (pre-backfill rows): rows written before
 * scripts/encrypt-existing-phi-columns.ts ran still hold plaintext email and
 * a NULL emailLookupHash. `readUserEmail` passes plaintext through (the
 * `dcv1:` prefix is an explicit format marker, so there is no ambiguity) and
 * `findUserByEmail` falls back to a plaintext equality probe on hash-miss.
 *
 * The email column key is DERIVED (HKDF of DEVICE_SECRET_KEY), not a stored
 * DocumentEncryptionKey row: a whole-table logical key has no meaningful
 * crypto-shred story (deleting it would brick every login, never one user),
 * and deriving keeps every read/write path synchronous. Per-document DEKs
 * (where shredding IS the point) stay in DocumentEncryptionKey.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Data fragment for every prisma write that sets User.email. */
export function emailWriteData(email: string): { email: string; emailLookupHash: string } {
  const normalized = normalizeEmail(email);
  return {
    email: encryptColumn(deriveEmailColumnKey(), normalized),
    emailLookupHash: emailLookupHash(normalized),
  };
}

/** Nullable-tolerant variant for writers whose email is optional (e.g. a
 *  pre-normalization invite row may carry email: null) — a null email also
 *  clears the blind index so the pair can never desynchronize. */
export function emailWriteDataOrNull(
  email: string | null,
): { email: string | null; emailLookupHash: string | null } {
  return email == null ? { email: null, emailLookupHash: null } : emailWriteData(email);
}

/** Decrypt a stored User.email for display/serialization. Pre-backfill
 *  plaintext (no dcv1: marker) passes through unchanged. */
export function readUserEmail(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!isEncryptedColumn(stored)) return stored;
  return decryptColumn(deriveEmailColumnKey(), stored);
}

/** Equality lookup via the blind index; plaintext fallback covers rows the
 *  WARP-233 backfill has not visited yet (their emailLookupHash is NULL, and
 *  a plaintext probe can never collide with a dcv1 blob). */
export async function findUserByEmail(prisma: PrismaClient, email: string): Promise<User | null> {
  const normalized = normalizeEmail(email);
  const byHash = await prisma.user.findUnique({
    where: { emailLookupHash: emailLookupHash(normalized) },
  });
  if (byHash) return byHash;
  return prisma.user.findFirst({
    where: { email: normalized, emailLookupHash: null },
  });
}

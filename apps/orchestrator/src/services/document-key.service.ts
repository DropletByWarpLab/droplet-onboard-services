import type { PrismaClient } from "@prisma/client";
import { deriveDocKek, generateDek, wrapDek, unwrapDek } from "./column-crypto.service.js";

/**
 * WARP-233/WARP-242 — persistence for wrapped per-document DEKs. See the
 * DocumentEncryptionKey schema comment for the key hierarchy.
 *
 * Versioning (WARP-242): rows are keyed (keyId, version). Rotation — a
 * follow-up slice — mints version N+1 and re-encrypts the document's chunks
 * in the background before deleting version N. Until it lands every row is
 * version 1, so "latest version" reads are exact; when rotation arrives the
 * chunk rows gain a dekVersion column so mid-rotation reads can pin the
 * exact version (and v2+ wrap AAD should extend to `${keyId}#v${version}`).
 */

export async function getOrCreateDek(prisma: PrismaClient, keyId: string): Promise<Buffer> {
  const kek = deriveDocKek();
  const existing = await prisma.documentEncryptionKey.findFirst({
    where: { keyId },
    orderBy: { version: "desc" },
  });
  if (existing) return unwrapDek(kek, existing.wrappedDek, keyId);
  const dek = generateDek();
  try {
    await prisma.documentEncryptionKey.create({
      data: { keyId, version: 1, wrappedDek: wrapDek(kek, dek, keyId) },
    });
    return dek;
  } catch {
    // Concurrent minter won the (keyId, version) PK race — use its DEK.
    const row = await prisma.documentEncryptionKey.findFirst({
      where: { keyId },
      orderBy: { version: "desc" },
    });
    if (!row) throw new Error(`document-key: mint race lost AND no row for ${keyId}`);
    return unwrapDek(kek, row.wrappedDek, keyId);
  }
}

export async function getDek(prisma: PrismaClient, keyId: string): Promise<Buffer | null> {
  const row = await prisma.documentEncryptionKey.findFirst({
    where: { keyId },
    orderBy: { version: "desc" },
  });
  if (!row) return null;
  return unwrapDek(deriveDocKek(), row.wrappedDek, keyId);
}

export async function getDeksByIds(
  prisma: PrismaClient,
  keyIds: string[],
): Promise<Map<string, Buffer>> {
  if (keyIds.length === 0) return new Map();
  const kek = deriveDocKek();
  const rows = await prisma.documentEncryptionKey.findMany({
    where: { keyId: { in: keyIds } },
    orderBy: { version: "asc" },
  });
  // Ascending order + Map overwrite ⇒ the latest version wins per keyId.
  return new Map(rows.map((r) => [r.keyId, unwrapDek(kek, r.wrappedDek, r.keyId)]));
}

/** Crypto-shred: after this, every dcv1 blob under keyId is unreadable
 *  forever — ALL versions are deleted. deleteMany is a no-op on a missing
 *  key (idempotent) but a real DB error still propagates: a shred that
 *  silently fails would leave the DEK recoverable. */
export async function shredDocumentKey(prisma: PrismaClient, keyId: string): Promise<void> {
  await prisma.documentEncryptionKey.deleteMany({ where: { keyId } });
}

/** Batch crypto-shred (user purge). Same semantics as shredDocumentKey. */
export async function shredDocumentKeys(prisma: PrismaClient, keyIds: string[]): Promise<void> {
  if (keyIds.length === 0) return;
  await prisma.documentEncryptionKey.deleteMany({ where: { keyId: { in: keyIds } } });
}

import type { PrismaClient } from "@prisma/client";
import { deriveDocKek, generateDek, wrapDek, unwrapDek } from "./column-crypto.service.js";

/** WARP-233 — persistence for wrapped per-document DEKs. See schema comment. */

export async function getOrCreateDek(prisma: PrismaClient, keyId: string): Promise<Buffer> {
  const kek = deriveDocKek();
  const existing = await prisma.documentEncryptionKey.findUnique({ where: { keyId } });
  if (existing) return unwrapDek(kek, existing.wrappedDek, keyId);
  const dek = generateDek();
  await prisma.documentEncryptionKey.create({
    data: { keyId, wrappedDek: wrapDek(kek, dek, keyId) },
  });
  return dek;
}

export async function getDek(prisma: PrismaClient, keyId: string): Promise<Buffer | null> {
  const row = await prisma.documentEncryptionKey.findUnique({ where: { keyId } });
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
  });
  return new Map(rows.map((r) => [r.keyId, unwrapDek(kek, r.wrappedDek, r.keyId)]));
}

/** Crypto-shred: after this, every dcv1 blob under keyId is unreadable forever. */
export async function shredDocumentKey(prisma: PrismaClient, keyId: string): Promise<void> {
  await prisma.documentEncryptionKey.delete({ where: { keyId } }).catch(() => undefined);
}

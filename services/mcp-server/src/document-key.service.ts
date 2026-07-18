/**
 * WARP-242 — read-side lookup for wrapped per-document DEKs. Twin of the
 * read half of apps/orchestrator/src/services/document-key.service.ts —
 * duplicated (intentionally) because the mcp-server is a standalone process
 * (same rationale as file-search.service.ts / column-crypto.service.ts).
 *
 * The mcp-server only DECRYPTS (search_content results): minting DEKs is the
 * file-indexer's job at first chunk-write, crypto-shredding them is the
 * orchestrator's delete flow. Rows are keyed (keyId, version); until DEK
 * rotation lands every keyId has exactly version 1, and readers take the
 * latest version.
 */
import type { PrismaClient } from "@prisma/client";

import { deriveDocKek, unwrapDek } from "./column-crypto.service.js";

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

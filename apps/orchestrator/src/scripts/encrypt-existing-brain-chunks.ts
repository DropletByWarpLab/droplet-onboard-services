/**
 * WARP-242 — one-shot, idempotent backfill: encrypt pre-existing plaintext
 * brain chunks under their per-document DEK (the "existing chunks encrypted
 * at migration time" acceptance criterion).
 *
 * Scope: FileContentChunk rows with source='brain'. Each row's `text` is
 * replaced with a dcv1 AES-256-GCM blob under the item's DEK (keyId
 * `brain:<brainItemId>`, minted here if absent — the same key the
 * file-indexer uses for new writes) and `sensitivity` flips to 'sensitive'
 * (which also NULLs the generated text_tsv, removing the plaintext-derived
 * lexical index). Rows already carrying a dcv1: marker are skipped, so
 * re-running is always safe. Brain rows with a NULL brainItemId (a write
 * race that never resolved) have no DEK identity — reported and left
 * untouched for operator remediation.
 *
 * Ships compiled in the runtime image (src/scripts → dist/scripts). Run
 * inside the orchestrator container (DATABASE_URL from the env; the doc-KEK
 * keyfile mounted at /data/secrets/doc-kek.key):
 *   node dist/scripts/encrypt-existing-brain-chunks.js        # apply
 *   node dist/scripts/encrypt-existing-brain-chunks.js --dry  # report only
 */
import { PrismaClient } from "@prisma/client";
import {
  encryptColumn,
  isEncryptedColumn,
} from "../services/column-crypto.service.js";
import { getOrCreateDek } from "../services/document-key.service.js";

const DRY = process.argv.includes("--dry");
const BATCH = 500;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  let encrypted = 0;
  let skipped = 0;
  let orphans = 0;
  try {
    // Per-item DEK cache — one unwrap per document, not per chunk.
    const deks = new Map<string, Buffer>();
    let cursor: bigint | undefined;
    for (;;) {
      const rows = await prisma.fileContentChunk.findMany({
        where: { source: "brain" },
        select: { id: true, text: true, brainItemId: true },
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor !== undefined ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;

      for (const row of rows) {
        if (isEncryptedColumn(row.text)) {
          skipped++;
          continue;
        }
        if (!row.brainItemId) {
          orphans++;
          console.error(
            `ORPHAN: brain chunk id=${row.id} has no brainItemId — no DEK identity, left plaintext; delete or re-ingest the item`,
          );
          continue;
        }
        const keyId = `brain:${row.brainItemId}`;
        if (!DRY) {
          let dek = deks.get(keyId);
          if (!dek) {
            dek = await getOrCreateDek(prisma, keyId);
            deks.set(keyId, dek);
          }
          await prisma.fileContentChunk.update({
            where: { id: row.id },
            data: {
              text: encryptColumn(dek, row.text, keyId),
              sensitivity: "sensitive",
            },
          });
        }
        encrypted++;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  console.log(
    `${DRY ? "[dry-run] " : ""}encrypt-existing-brain-chunks: ${encrypted} encrypted, ${skipped} skipped (already dcv1), ${orphans} orphans (no brainItemId)`,
  );
  if (orphans > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

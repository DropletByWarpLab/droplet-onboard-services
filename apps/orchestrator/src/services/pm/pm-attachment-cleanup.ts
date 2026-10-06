/** Durable blob cleanup after an item/project cascade removes attachment rows. */
import type { Prisma, PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { isStorageKey, removeAttachmentBlobs } from "./pm-attachment-storage.js";

const logger = createLogger("pm-attachment-cleanup");
export const ATTACHMENT_CLEANUP_PREFIX = "pm-attachments:cleanup:";
const BATCH = 200;
const MAX_BATCHES = 10;

/** Must be called inside the SAME transaction as the cascade. No FK to the
 *  item: the intent must survive the rows it is responsible for removing. */
export async function queueAttachmentCleanup(
  tx: Prisma.TransactionClient,
  storageKeys: readonly string[],
): Promise<string[]> {
  const keys = [...new Set(storageKeys.filter(isStorageKey))];
  if (keys.length === 0) return [];
  const intents = keys.map((storageKey) => ({
    key: `${ATTACHMENT_CLEANUP_PREFIX}${storageKey}`, valueJson: { storageKey },
  }));
  // One bounded payload per blob; UUID storage keys are immutable and never
  // reused, so a repeated intent is the same idempotent cleanup operation.
  await tx.systemFlag.createMany({ data: intents, skipDuplicates: true });
  return intents.map((intent) => intent.key);
}

function cleanupStorageKey(value: Prisma.JsonValue): string | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const key = value.storageKey;
  return typeof key === "string" && isStorageKey(key) ? key : null;
}

/** After commit only. A failure never changes a successful user's delete into
 *  an error; the durable intent remains for the next attachment sweep. */
export async function finishAttachmentCleanup(
  prisma: PrismaClient,
  key: string,
  root: string = config.PM_ATTACHMENTS_DIR,
): Promise<void> {
  try {
    const row = await prisma.systemFlag.findUnique({ where: { key } });
    if (!row) return;
    const storageKey = cleanupStorageKey(row.valueJson);
    if (storageKey === null || key !== `${ATTACHMENT_CLEANUP_PREFIX}${storageKey}`) {
      logger.error({ cleanupKey: key }, "attachment cleanup intent is malformed; nothing unlinked");
      return;
    }
    const result = await removeAttachmentBlobs([storageKey], root);
    if (result.failed === 0) await prisma.systemFlag.deleteMany({ where: { key } });
  } catch (err) {
    logger.warn({ err, cleanupKey: key }, "attachment cleanup left for the sweep");
  }
}

/** Bound the synchronous work on the user's delete; the sweep owns the rest. */
export async function finishQueuedAttachmentCleanup(prisma: PrismaClient, keys: readonly string[]): Promise<void> {
  for (const key of keys.slice(0, BATCH)) await finishAttachmentCleanup(prisma, key);
}

/** The existing attachment sweep is the only scheduler. Walk failures as well
 *  as successes so an unreadable blob cannot starve later cleanup intents. */
export async function sweepAttachmentCleanup(
  prisma: PrismaClient,
  root: string = config.PM_ATTACHMENTS_DIR,
): Promise<void> {
  let after: string | undefined;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.systemFlag.findMany({
      where: { key: { startsWith: ATTACHMENT_CLEANUP_PREFIX, ...(after ? { gt: after } : {}) } },
      select: { key: true }, orderBy: { key: "asc" }, take: BATCH,
    });
    for (const row of rows) await finishAttachmentCleanup(prisma, row.key, root);
    if (rows.length < BATCH) break;
    after = rows[rows.length - 1].key;
  }
}

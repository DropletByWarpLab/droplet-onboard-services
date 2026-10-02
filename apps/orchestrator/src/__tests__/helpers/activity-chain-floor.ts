/**
 * WARP-2977 P2b — the pg lane's way to own a SEGMENT of the activity chain
 * instead of the whole table.
 *
 * The pg files share one database, and the lane's rule is prefix-scoped
 * fixtures: never a TRUNCATE, never an unscoped delete. A file that audits
 * through the real recorder records the chain's tail first (`chainFloor`),
 * then counts, verifies and deletes only what came after it:
 *   · `afterFloor(floor)` — the `where` for "rows this file appended";
 *   · `verifyActivityChain(prisma, signer, floor)` — the segment walk, the
 *     first row anchored on the floor's signature (another file's rows
 *     before it, under another key, do not matter);
 *   · `deleteAfterFloor(prisma, floor)` — the cleanup. This file's rows are
 *     the tail (the lane runs files one at a time), so the chain the next
 *     file appends to is still whole.
 * Not a test file itself.
 */
import type { PrismaClient } from "@prisma/client";
import { createActivityRecorder } from "../../services/activity.service.js";
import { createHmacSigner } from "../../services/audit-signing.service.js";

export interface ChainFloor {
  id: bigint;
  signature: string;
}

/** The current tail of the chain, or null on an empty table (a segment from genesis). */
export async function chainFloor(prisma: PrismaClient): Promise<ChainFloor | null> {
  return prisma.activityRow.findFirst({ orderBy: { id: "desc" }, select: { id: true, signature: true } });
}

/** `where` for the rows appended after `floor` (every row, when the table was empty). */
export function afterFloor(floor: ChainFloor | null): { id: { gt: bigint } } {
  return { id: { gt: floor ? floor.id : 0n } };
}

/** Remove only the rows appended after `floor`. */
export async function deleteAfterFloor(prisma: PrismaClient, floor: ChainFloor | null): Promise<void> {
  await prisma.activityRow.deleteMany({ where: afterFloor(floor) });
}

/**
 * A row as another pg file would leave it — signed with ANOTHER key — to
 * append just before a file takes its floor. The file must neither delete
 * it (a TRUNCATE would) nor walk it (a whole-table verify with the file's own
 * key breaks on it). Returns its id; `removeForeignRow` checks it survived.
 */
export async function appendForeignRow(prisma: PrismaClient, what: string): Promise<bigint> {
  const recorder = createActivityRecorder({ prisma, signer: createHmacSigner(Buffer.alloc(32, 0xf0)) });
  const row = await recorder.record({ kind: "system", severity: "info", sourceIcon: "shield", what, actor: { type: "system" } });
  return row.id;
}

/** True when the foreign row was still there (it is then removed — it is the tail again once the file's own rows are gone). */
export async function removeForeignRow(prisma: PrismaClient, id: bigint): Promise<boolean> {
  const { count } = await prisma.activityRow.deleteMany({ where: { id } });
  return count === 1;
}

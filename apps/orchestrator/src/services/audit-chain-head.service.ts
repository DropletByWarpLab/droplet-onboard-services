/**
 * WARP-3628 — the activity chain's current head, in the form an off-box copy
 * needs.
 *
 * Both the per-row HMAC chain and the daily roots live in this box's own
 * database, so a rewrite by someone with the audit key and the database
 * credentials can only be caught by a copy kept somewhere they cannot reach.
 * `readChainHead` returns the smallest thing worth keeping there: the id and
 * signature hash of the last row, and the newest daily root. Compare a stored
 * head with the live chain later: the row with that id must still carry that
 * signature hash (unless retention has since purged it), and the daily root
 * for that date must still carry that hash.
 *
 * Nothing secret: a signature hash is a SHA-256 of a MAC output, not the audit
 * key. Where the copy goes (the owner's own archive, a WORM bucket, HQ over the
 * telemetry channel) is a decision this module does not make.
 */
import type { PrismaClient } from "@prisma/client";
import { hashSignature } from "./audit-signing.service.js";

export interface ChainHead {
  capturedAt: string;
  /** Null on a box with an empty chain. */
  lastRow: { id: string; at: string; signatureHash: string } | null;
  /** The newest daily root, null before the first one is signed. */
  latestDailyRoot: {
    date: string;
    firstRowId: string;
    lastRowId: string;
    rowCount: number;
    rootHash: string;
    algorithm: string;
  } | null;
}

export async function readChainHead(
  prisma: Pick<PrismaClient, "activityRow" | "activityDailyRoot">,
  now: Date = new Date(),
): Promise<ChainHead> {
  const row = await prisma.activityRow.findFirst({ orderBy: { id: "desc" } });
  const root = await prisma.activityDailyRoot.findFirst({
    orderBy: { date: "desc" },
  });
  return {
    capturedAt: now.toISOString(),
    lastRow: row
      ? {
          id: row.id.toString(),
          at: row.at.toISOString(),
          signatureHash: hashSignature(row.signature),
        }
      : null,
    latestDailyRoot: root
      ? {
          date: root.date,
          firstRowId: root.firstRowId.toString(),
          lastRowId: root.lastRowId.toString(),
          rowCount: root.rowCount,
          rootHash: root.rootHash,
          algorithm: root.algorithm,
        }
      : null,
  };
}

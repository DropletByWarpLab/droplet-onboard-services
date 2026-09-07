/**
 * WARP-2731 (ADR-048) — the daily arm: forgetting, on a schedule.
 *
 * Everything here deletes or nulls something, and each rule exists because a
 * proposal is a small pile of somebody's business in plaintext — names,
 * amounts, and verbatim quotes from a document — and a pile like that must not
 * outlive the reason it was collected.
 *
 * ── 🔴 The orphan purge is the one with no owner before this slice ─────────
 *
 * `IngestProposal.ncFileId` is a plain `Int` with NO FOREIGN KEY, deliberately:
 * a real FK would have to be `SetNull` or `Cascade`, and both were rejected in
 * slice 1 for the trap they set (`sourceRef` carries the durable identity
 * instead). The consequence is that when a file is deleted in Nextcloud,
 * `db.py`'s `delete_index_status` + `delete_chunks` remove the status row and
 * every chunk, and **nothing removes the proposal**. Without this arm a
 * rejected-but-not-yet-decided proposal keeps its quotes forever, for a
 * document the owner deleted months ago.
 *
 * The absence of BOTH the status row and the chunks is the test, not either
 * alone: a re-index in flight can briefly have chunks without a status row.
 *
 * ── Evidence retention (decision D8) ───────────────────────────────────────
 *
 *   REJECTED / NOT_SAME / PHI skip  quotes nulled in the DECIDING transaction,
 *                                   not here — see `apply.service.ts`.
 *   APPLIED                         quotes kept 30 days, then nulled here. The
 *                                   row and its back-pointers survive: undo and
 *                                   the audit trail need them, the wording of
 *                                   the document does not.
 *   EXPIRED                         nulled on expiry.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * ⚠ `EntityLink` rows whose file was deleted are NOT reaped. WARP-2585 shipped
 * without a reaper and this slice does not add one: a link is a CRM row a human
 * may have re-pointed or annotated, and sweeping it from a filing job would be
 * this feature reaching outside itself. Said out loud rather than discovered —
 * an owner who deletes a document still sees it listed on the customer, and
 * that is a known gap with a ticket's name on it, not an oversight.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";

const logger = createLogger("filing-maintenance");

/** How long a pending proposal waits for a human before it lapses. */
export const PROPOSAL_TTL_DAYS = 30;

/** How long an applied proposal keeps the quotes that justified it. */
export const EVIDENCE_TTL_DAYS = 30;

/** Bounds one sweep. A box that deleted ten thousand files gets caught up over
 *  a few nights rather than holding one transaction open for all of them. */
export const SWEEP_BATCH = 500;

export interface MaintenanceResult {
  /** Pending proposals whose source file no longer exists. */
  orphaned: number;
  /** Pending proposals older than the TTL. */
  lapsed: number;
  /** Applied proposals whose quotes passed the retention window. */
  evidenceForgotten: number;
}

const DAY_MS = 24 * 60 * 60_000;

export async function runFilingMaintenance(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<MaintenanceResult> {
  const orphaned = await expireOrphans(prisma);
  const lapsed = await expireLapsed(prisma, now);
  const evidenceForgotten = await forgetOldEvidence(prisma, now);

  const result = { orphaned, lapsed, evidenceForgotten };
  if (orphaned || lapsed || evidenceForgotten) {
    logger.info(result, "filing maintenance sweep");
  }
  return result;
}

/**
 * Expire proposals whose source file is gone.
 *
 * Done in two steps rather than one correlated `deleteMany`, because Prisma
 * cannot express "no row exists in another table" in a `where`. The candidate
 * read is bounded and the guarded update names explicit ids, which is the same
 * shape the claim uses — and it means a file re-appearing between the two
 * steps costs one wrongly-expired proposal rather than a lost transaction.
 */
async function expireOrphans(prisma: PrismaClient): Promise<number> {
  const candidates = await prisma.ingestProposal.findMany({
    where: { status: { in: ["PENDING", "EXPIRED"] }, ncFileId: { not: null } },
    select: { id: true, ncFileId: true },
    take: SWEEP_BATCH,
  });
  if (candidates.length === 0) return 0;

  const fileIds = [...new Set(candidates.map((c) => c.ncFileId as number))];

  // Both halves, because either alone has a false positive: a re-index in
  // flight can hold chunks with no status row, and a status row can exist for
  // a file whose chunks have not landed yet.
  const [statuses, chunks] = await Promise.all([
    prisma.fileIndexStatus.findMany({
      where: { ncFileId: { in: fileIds } },
      select: { ncFileId: true },
    }),
    prisma.$queryRaw<{ ncFileId: number }[]>`
      SELECT DISTINCT "ncFileId" FROM "FileContentChunk"
      WHERE "ncFileId" = ANY(${fileIds})
    `,
  ]);
  const alive = new Set<number>([
    ...statuses.map((s) => s.ncFileId as number),
    ...chunks.map((c) => c.ncFileId),
  ]);

  const dead = candidates.filter((c) => !alive.has(c.ncFileId as number)).map((c) => c.id);
  if (dead.length === 0) return 0;

  const n = await prisma.ingestProposal.updateMany({
    where: { id: { in: dead }, status: { in: ["PENDING", "EXPIRED"] } },
    data: { status: "EXPIRED", evidence: Prisma.DbNull },
  });
  return n.count;
}

/**
 * Lapse proposals nobody decided.
 *
 * `EXPIRED`, not deleted: the row is the record that Droplet once read this
 * document and offered something, which is what makes the Skipped and audit
 * views honest about a quiet month. The quotes go; the fact does not.
 */
async function expireLapsed(prisma: PrismaClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - PROPOSAL_TTL_DAYS * DAY_MS);
  const n = await prisma.ingestProposal.updateMany({
    where: { status: "PENDING", createdAt: { lt: cutoff } },
    data: { status: "EXPIRED", evidence: Prisma.DbNull },
  });
  return n.count;
}

/**
 * Forget the quotes on applied proposals past the retention window.
 *
 * 🔴 `evidence: { not: Prisma.DbNull }` is load-bearing, not an optimisation.
 * Without it every applied proposal is rewritten on every sweep forever — the
 * `updatedAt` on each row would march daily, and "when did this last change?"
 * would stop meaning anything for the whole table.
 */
async function forgetOldEvidence(prisma: PrismaClient, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - EVIDENCE_TTL_DAYS * DAY_MS);
  const n = await prisma.ingestProposal.updateMany({
    where: {
      status: "APPLIED",
      appliedAt: { lt: cutoff },
      evidence: { not: Prisma.DbNull },
    },
    data: { evidence: Prisma.DbNull },
  });
  return n.count;
}

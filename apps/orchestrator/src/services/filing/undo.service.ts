/**
 * WARP-2731 (ADR-048) — undo. The half that makes a wrong filing survivable.
 *
 * The promise the review surface makes is "you can always take it back", and a
 * promise like that is worth exactly as much as its worst case. So the shape
 * here is deliberately narrow: undo reverses ONLY through the proposal's own
 * back-pointers — `createdCompanyId`, `createdContactId`, `createdProjectId`,
 * `createdEntityLinkId`, `createdActivityId` — and never searches for anything
 * that "looks like" what it made. A reversal that guesses is a reversal that
 * can take something a person meant to keep.
 *
 * ── Delete or archive ──────────────────────────────────────────────────────
 *
 * 🔴 THE SAME RULE `landed-purge.ts` USES, FOR THE SAME REASON. Every
 * `CrmActivity` subject relation is `onDelete: Cascade` and must be — the
 * exactly-one-subject CHECK forbids an orphan, so `SetNull` is unavailable —
 * which makes deleting a company silently a delete of every note a human typed
 * against it. `crm-activity-cascade.pg.test.ts` proved that against real
 * Postgres. So:
 *
 *   carries LOCAL activity → ARCHIVE. Whatever a person wrote stays readable.
 *   carries none           → DELETE. Undo that left the row behind is not undo.
 *
 * `undoMode` records which branch ran, because "why is this customer still
 * here?" has to be answerable a month later.
 *
 * This is why the filing path stamps its own `CrmActivity` rows `EXTRACTED`
 * (WARP-2730): at the `LOCAL` default, every filed customer would carry a
 * machine-written `CREATED` row that reads as human prose, the archive branch
 * would always win, and undo could never clean anything up.
 *
 * ── What undo does NOT touch ───────────────────────────────────────────────
 *
 * A proposal against a record that ALREADY EXISTED only ever created a link or
 * an activity. Undo archives the link and deletes the caption; the customer,
 * their deals and their history are none of its business. `createdCompanyId`
 * is null on those proposals, and that null is the whole guard.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient, IngestProposal } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import { FILING_ERRORS, notSameKey } from "./apply.service.js";
import { parsePayload } from "./payloads.js";

const logger = createLogger("filing-undo");

export type UndoMode = "delete" | "archive";

export interface UndoResult {
  proposalId: string;
  /** Null when the proposal created no record — a link-only undo. */
  mode: UndoMode | null;
  companyRemoved: boolean;
  contactRemoved: boolean;
  projectRemoved: boolean;
  linkArchived: boolean;
  activityRemoved: boolean;
  /** True when a `NOT_SAME` rule was written so the pair is not re-offered. */
  ruleWritten: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Does anything a human wrote hang off this record?
 *
 * `origin: "LOCAL"` is the test, exactly as in `landed-purge.ts` — not "was it
 * created by filing". A filed record can acquire a human NOTE the day after it
 * lands, and that note is the owner's prose whatever created the row it hangs
 * on.
 */
async function hasHumanActivity(
  tx: Tx,
  subject: "companyId" | "contactId",
  id: string,
): Promise<boolean> {
  const found = await tx.crmActivity.findFirst({
    where: { origin: "LOCAL", [subject]: id },
    select: { id: true },
  });
  return found !== null;
}

/**
 * Undo an applied proposal.
 *
 * Throws `Error(code)` from `FILING_ERRORS`; the route maps codes to statuses.
 * `APPLIED → UNDONE` is a guarded `updateMany` for the same reason apply is:
 * two tabs, one row, exactly one winner.
 */
export async function undoProposal(
  prisma: PrismaClient,
  proposalId: string,
  actorId: string,
): Promise<UndoResult> {
  const proposal = await prisma.ingestProposal.findUnique({ where: { id: proposalId } });
  if (!proposal) throw new Error(FILING_ERRORS.PROPOSAL_NOT_FOUND);
  if (proposal.status !== "APPLIED") throw new Error(FILING_ERRORS.NOT_APPLIED);

  return prisma.$transaction(async (tx) => {
    // Re-guard under the lock. Everything above was a pre-flight.
    const claimed = await tx.ingestProposal.updateMany({
      where: { id: proposalId, status: "APPLIED" },
      data: {
        status: "UNDONE",
        undoneById: actorId,
        undoneAt: new Date(),
        // 🔴 `decidedById` is NOT cleared. An undone proposal was applied by
        // somebody first, and undoing it does not unmake that — the schema's
        // `IngestProposal_decided_has_actor` CHECK includes UNDONE in its
        // decided set for exactly this reason.
        evidence: Prisma.DbNull,
      },
    });
    if (claimed.count !== 1) throw new Error(FILING_ERRORS.NOT_APPLIED);

    const result = await reverse(tx, proposal, actorId);

    logger.info(
      { proposalId, kind: proposal.kind, mode: result.mode },
      // Ids and codes. No names, no filenames, no amounts.
      "filing: undone",
    );
    return { proposalId, ...result };
  });
}

async function reverse(
  tx: Tx,
  proposal: IngestProposal,
  actorId: string,
): Promise<Omit<UndoResult, "proposalId">> {
  let mode: UndoMode | null = null;
  let companyRemoved = false;
  let contactRemoved = false;
  let projectRemoved = false;
  let linkArchived = false;
  let activityRemoved = false;

  // ── The link, first ──────────────────────────────────────────────────────
  //
  // Archived, never deleted: the link row is the record that Droplet once
  // filed this document here, and the Rules page needs that history to explain
  // itself. `isArchived` and `archivedAt` move together (WARP-884) — one is
  // the flag and the other is the audit stamp, and neither is derived from the
  // other.
  if (proposal.createdEntityLinkId) {
    const n = await tx.entityLink.updateMany({
      where: { id: proposal.createdEntityLinkId, isArchived: false },
      data: { isArchived: true, archivedAt: new Date() },
    });
    linkArchived = n.count === 1;
  }

  // ── The caption ──────────────────────────────────────────────────────────
  //
  // Deleted rather than archived, and it is the one row here that may be:
  // a `LOG_EMAIL_ACTIVITY` caption is a sentence the box wrote, carrying
  // nothing a person authored. `CrmActivity` has no archive flag anyway.
  if (proposal.createdActivityId) {
    const n = await tx.crmActivity.deleteMany({
      where: { id: proposal.createdActivityId, origin: "EXTRACTED" },
    });
    activityRemoved = n.count === 1;
  }

  // ── The created records ──────────────────────────────────────────────────
  if (proposal.createdProjectId) {
    // A project has no activity table of its own to protect, and PM archives
    // rather than deletes, matching what the owner sees everywhere else in
    // Projects.
    await tx.pmProject.updateMany({
      where: { id: proposal.createdProjectId },
      data: { isArchived: true, archivedAt: new Date() },
    });
    projectRemoved = true;
    mode = "archive";
  }

  if (proposal.createdContactId) {
    const keep = await hasHumanActivity(tx, "contactId", proposal.createdContactId);
    if (keep) {
      await tx.contact.updateMany({
        where: { id: proposal.createdContactId },
        data: { isArchived: true, archivedAt: new Date() },
      });
      mode = "archive";
    } else {
      await tx.contact.deleteMany({ where: { id: proposal.createdContactId } });
      mode = mode ?? "delete";
    }
    contactRemoved = true;
  }

  if (proposal.createdCompanyId) {
    const keep = await hasHumanActivity(tx, "companyId", proposal.createdCompanyId);
    if (keep) {
      await tx.crmCompany.updateMany({
        where: { id: proposal.createdCompanyId },
        data: { isArchived: true, archivedAt: new Date() },
      });
      mode = "archive";
    } else {
      // 🔴 The cascade is the reason the branch above exists. Deleting a
      // company takes every CrmActivity on it, including a human's note.
      // Reaching here means we checked and there is none.
      await tx.crmCompany.deleteMany({ where: { id: proposal.createdCompanyId } });
      mode = mode === "archive" ? "archive" : "delete";
    }
    companyRemoved = true;
  }

  await tx.ingestProposal.update({
    where: { id: proposal.id },
    data: { undoMode: mode },
  });

  // ── Remember it ──────────────────────────────────────────────────────────
  //
  // Undoing a filing is a correction, and a correction that does not stick is
  // worse than none: the next tick would read the same document and propose
  // the same thing. The rule is written against the key that FOUND the match
  // (WARP-2730's `matchedKeyValue`), not the dedupe key.
  const ruleWritten = await rememberNotSame(tx, proposal, actorId);

  return {
    mode,
    companyRemoved,
    contactRemoved,
    projectRemoved,
    linkArchived,
    activityRemoved,
    ruleWritten,
  };
}

/**
 * Write the "do not offer this again" rule, when there is a company to point
 * it at and a key the matcher will actually look up.
 *
 * Returns false rather than throwing when either is missing: the UNDO must
 * hold regardless. A rule that matches nothing is one the owner finds on the
 * Rules page later and cannot explain, so it is better not written.
 */
async function rememberNotSame(
  tx: Tx,
  proposal: IngestProposal,
  actorId: string,
): Promise<boolean> {
  const payload = parsePayload(proposal.kind, proposal.payload);
  if (payload === null) return false;
  const key = notSameKey(proposal.kind, payload);
  if (!key) return false;

  // The company the rule points AT: for a link, the record we linked to; for a
  // create, the record we just made — and that one is gone or archived, so
  // there is nothing to point at and no rule to write.
  const companyId =
    proposal.kind === "CREATE_CUSTOMER"
      ? null
      : ((payload as { companyId?: string }).companyId ?? null);
  if (!companyId) return false;

  await tx.filingDecision.create({
    data: {
      keyKind: key.keyKind,
      keyValue: key.keyValue,
      verdict: "NOT_SAME",
      companyId,
      createdById: actorId,
    },
  });
  return true;
}

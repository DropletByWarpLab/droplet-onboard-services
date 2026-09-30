/**
 * What happens to landed records when the owner disconnects the connector that
 * brought them (WARP-2549, the deletion half of ADR-041 §4).
 *
 * "Deletion is a real operation" is one of §4's two binding constraints:
 * disconnecting an account must offer to remove what was synced from it. The
 * credential purge already happens in `integrations.service.ts`; this is the
 * records half.
 *
 * ## WARP-3375 — the owner chooses, and the default deletes nothing
 *
 * This module used to run unconditionally, so "offer" was a promise the box
 * never kept. `disconnect()` now takes a {@link LandedRecordsDisposition}:
 *
 *   • `keep` (the default) → {@link detachLandedRecords}. Nothing is deleted;
 *     the CRM rows become ordinary LOCAL records the business owns.
 *   • `delete` → {@link purgeLandedRecords} (the walk below) plus
 *     {@link purgeLandedDocuments} for the ledger copies.
 *
 * ## Why it is not one `deleteMany`
 *
 * 🔴 All three of `CrmActivity`'s subject relations are `onDelete: Cascade`,
 * and they MUST be: the exactly-one-subject CHECK forbids an orphan, so
 * `SetNull` is unavailable. That makes a delete of a landed company silently a
 * delete of every note, call and meeting a human typed against it — the
 * customer's own words, destroyed as a side effect of unplugging a vendor.
 * `crm-activity-cascade.pg.test.ts` proved that behaviour against real
 * Postgres; this module is what stops it mattering.
 *
 * So the walk is per record:
 *
 *   • carries LOCAL activity  → ARCHIVE. The vendor's copy stops updating, the
 *     row leaves the default listing, and what a person wrote stays readable.
 *   • carries none            → DELETE. Nothing of the owner's is lost, and a
 *     purge that left rows behind would not be a purge.
 *
 * ## Why it is scoped to a CONNECTION and never to a provider
 *
 * WARP-2461's purge walker keys on `connectionId`, and its own mutation test
 * proves why: on a box with two HubSpot portals, scoping by `externalSystem`
 * destroys the sibling connection's customers. Every `where` in this file names
 * `connectionId` and none of them names a provider.
 */
import { Prisma } from "@prisma/client";

import { SUBJECT_ERP_DOCUMENT } from "../erp-sync/money-snapshot.service.js";

/** What the owner asked to happen to the records a connector landed. */
export type LandedRecordsDisposition = "keep" | "delete";

export type PurgeDb = Pick<
  Prisma.TransactionClient,
  "contact" | "crmCompany" | "crmDeal" | "crmPipeline" | "crmPipelineStage" | "crmActivity"
>;

export interface LandedPurgeOutcome {
  readonly deleted: number;
  readonly archived: number;
  /** True when the connection's synced pipeline could be removed as well. */
  readonly pipelineRemoved: boolean;
}

type Subject = "companyId" | "contactId" | "dealId";

/**
 * Does anything a human wrote hang off this record?
 *
 * `origin: LOCAL` is the test, not "was it created by the sync" — a landed row
 * can acquire a `STAGE_CHANGE` the box itself wrote, and that is not the
 * owner's prose. LOCAL is the flag every human-entered activity carries.
 */
async function hasLocalActivity(db: PurgeDb, subject: Subject, id: string): Promise<boolean> {
  const found = await db.crmActivity.findFirst({
    where: { origin: "LOCAL", [subject]: id },
    select: { id: true },
  });
  return found !== null;
}

async function walk(
  db: PurgeDb,
  rows: readonly { id: string }[],
  subject: Subject,
  now: Date,
  del: (id: string) => Promise<unknown>,
  archive: (id: string, now: Date) => Promise<unknown>,
): Promise<{ deleted: number; archived: number; survivors: number }> {
  let deleted = 0;
  let archived = 0;
  for (const row of rows) {
    if (await hasLocalActivity(db, subject, row.id)) {
      await archive(row.id, now);
      archived += 1;
    } else {
      await del(row.id);
      deleted += 1;
    }
  }
  return { deleted, archived, survivors: archived };
}

/**
 * Remove everything this connection landed.
 *
 * Runs inside the caller's transaction — the disconnect's — so a box is never
 * left with purged credentials and un-purged records, or the reverse.
 *
 * Order matters: deals first, then contacts, then companies. A deal references
 * a stage with `Restrict`, so the pipeline can only go once its deals have; and
 * deleting a company `SetNull`s the `companyId` of any deal that survived,
 * which is the right outcome — an archived deal keeps its history and loses a
 * pointer to a customer who is no longer here.
 */
export async function purgeLandedRecords(
  db: PurgeDb,
  connectionId: string,
  now: Date,
): Promise<LandedPurgeOutcome> {
  const scope = { connectionId };

  const deals = await db.crmDeal.findMany({ where: scope, select: { id: true } });
  const dealResult = await walk(
    db,
    deals,
    "dealId",
    now,
    (id) => db.crmDeal.delete({ where: { id } }),
    (id, at) => db.crmDeal.update({ where: { id }, data: { isArchived: true, archivedAt: at } }),
  );

  const contacts = await db.contact.findMany({ where: scope, select: { id: true } });
  const contactResult = await walk(
    db,
    contacts,
    "contactId",
    now,
    (id) => db.contact.delete({ where: { id } }),
    (id, at) => db.contact.update({ where: { id }, data: { isArchived: true, archivedAt: at } }),
  );

  const companies = await db.crmCompany.findMany({ where: scope, select: { id: true } });
  const companyResult = await walk(
    db,
    companies,
    "companyId",
    now,
    (id) => db.crmCompany.delete({ where: { id } }),
    (id, at) =>
      db.crmCompany.update({ where: { id }, data: { isArchived: true, archivedAt: at } }),
  );

  // The synced pipeline is the connection's own board, so it goes with the
  // connection — but only once nothing references its stages. A deal that was
  // archived rather than deleted still sits in one, and `Restrict` on the stage
  // relation would throw and take the whole disconnect down with it.
  let pipelineRemoved = false;
  if (dealResult.survivors === 0) {
    const pipeline = await db.crmPipeline.findFirst({ where: scope, select: { id: true } });
    if (pipeline !== null) {
      await db.crmPipelineStage.deleteMany({ where: { pipelineId: pipeline.id } });
      await db.crmPipeline.delete({ where: { id: pipeline.id } });
      pipelineRemoved = true;
    }
  }

  return {
    deleted: dealResult.deleted + contactResult.deleted + companyResult.deleted,
    archived: dealResult.archived + contactResult.archived + companyResult.archived,
    pipelineRemoved,
  };
}

/**
 * KEEP: hand the connection's landed CRM rows over to the business.
 *
 * "Detach" is one `UPDATE` per table that clears the whole provenance triple
 * AND flips `origin` to LOCAL. Both halves are needed and neither can go
 * first: the `*_provenance_complete` CHECK allows either "all three link
 * columns NULL" (any origin) or "all three set AND origin = EXTERNAL", so
 * nulling the links alone leaves EXTERNAL rows the guards in `crm.service.ts`
 * still refuse to edit or delete, which is the opposite of "ordinary
 * customers". A single `UPDATE` is checked once, on the final row.
 *
 * The synced pipeline is detached the same way, so the deals still standing in
 * it keep their board and the owner can rename or reshape it.
 *
 * Already-archived rows stay archived (`isArchived` is owner state and is not
 * written here), and `CrmActivity` and `PartyLink` rows are untouched: the
 * timeline and the match a person confirmed outlive the connector.
 *
 * Scoped to the CONNECTION for the reason in the header. Runs inside the
 * caller's transaction.
 *
 * KNOWN CONSEQUENCE: the link is what the next sync reconciles on, so
 * reconnecting the same vendor lands fresh EXTERNAL copies beside these
 * detached ones. That is the price of "no longer synced or owned".
 */
export async function detachLandedRecords(
  db: Pick<Prisma.TransactionClient, "contact" | "crmCompany" | "crmDeal" | "crmPipeline">,
  connectionId: string,
): Promise<number> {
  const scope = { connectionId };
  const unlink = {
    connectionId: null,
    externalSystem: null,
    externalId: null,
    origin: "LOCAL" as const,
  };
  const deals = await db.crmDeal.updateMany({ where: scope, data: unlink });
  const contacts = await db.contact.updateMany({ where: scope, data: unlink });
  const companies = await db.crmCompany.updateMany({ where: scope, data: unlink });
  // The pipeline has no provenance triple or origin — only the unique link.
  await db.crmPipeline.updateMany({ where: scope, data: { connectionId: null } });
  return deals.count + contacts.count + companies.count;
}

/**
 * DELETE: remove the invoices and bills this connection landed, and the
 * per-day money history captured from them.
 *
 * `ErpDocument` is not touched by {@link purgeLandedRecords}, so before
 * WARP-3375 a disconnect left the whole ledger copy on the box. Nothing hangs
 * off a landed document that a person wrote (a LANDED row is read-only and the
 * timeline attaches to CRM rows only), so there is no archive branch: it is
 * `LANDED` for THIS connection or it stays. `origin: "LANDED"` is stated even
 * though a LOCAL row can never carry a connection (the `ErpDocument_provenance`
 * CHECK), so a future loosening of that CHECK cannot make this delete a
 * document a person typed.
 *
 * `MoneySnapshot` has no foreign key on purpose (a series must outlive a
 * vendor deleting an invoice), which is exactly why it has to be removed by
 * hand here: it carries each document's amount, balance and status. Done in
 * SQL, before the documents go, because it selects through them and a ledger
 * can be larger than a bound-parameter list.
 *
 * KEEP has no counterpart for this table: a LANDED row must keep its
 * connection (same CHECK), and turning it LOCAL would invent a lifecycle
 * status and drop the vendor's own. So on `keep` the ledger copy stays,
 * read-only, on the disabled connection.
 */
export async function purgeLandedDocuments(
  db: Pick<Prisma.TransactionClient, "erpDocument" | "$executeRaw">,
  connectionId: string,
): Promise<number> {
  await db.$executeRaw`
    DELETE FROM "MoneySnapshot"
    WHERE "subjectType" = ${SUBJECT_ERP_DOCUMENT}
      AND "subjectId" IN (
        SELECT "id" FROM "ErpDocument"
        WHERE "connectionId" = ${connectionId} AND "origin" = 'LANDED'
      )`;
  const { count } = await db.erpDocument.deleteMany({
    where: { connectionId, origin: "LANDED" },
  });
  return count;
}

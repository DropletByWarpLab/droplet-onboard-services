/**
 * What happens to landed records when the owner disconnects the connector that
 * brought them (WARP-2549, the deletion half of ADR-041 §4).
 *
 * "Deletion is a real operation" is one of §4's two binding constraints:
 * disconnecting an account must offer to remove what was synced from it. The
 * credential purge already happens in `integrations.service.ts`; this is the
 * records half.
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

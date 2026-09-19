/**
 * WARP-2737 (ADR-048) — which customer a money document is filed under, when
 * its own payload does not name one.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `propose.ts` writes `companyId` onto a money payload only when the document's
 * counterparty resolved to a customer that ALREADY EXISTED. On the first
 * invoice from a new business — the ordinary way a money document arrives —
 * there is no such customer, so the field is simply absent, and the apply path
 * refused every one of those cards forever. The feature worked for repeat
 * customers and for nobody else.
 *
 * The fix is not a picker, because on that path there is nothing to pick: the
 * customer does not exist yet. What does exist, in the same queue, from the
 * same document, is the `CREATE_CUSTOMER` card that would create them. So the
 * money proposal points at it — `dependsOnProposalId`, which the schema
 * describes as "a child proposal that cannot apply until its parent does" and
 * which nothing in the tree had ever written — and the customer is resolved
 * through that pointer at the moment of applying.
 *
 * ── The rule is DERIVED, never cached ──────────────────────────────────────
 *
 * 🔴 The obvious shortcut is to patch the resolved id into the money payload
 * when the parent is applied. That is a copy, and a copy goes stale in the one
 * direction that matters: undo takes the customer back, and the copy would
 * still point at them. So nothing is written anywhere — the customer is
 * resolved from the parent's LIVE state every time it is asked for, by the
 * review list and by the apply path alike, through this one function.
 *
 * ── What counts as resolved ────────────────────────────────────────────────
 *
 *   1. The parent is APPLIED. Not "has a `createdCompanyId`": that back-pointer
 *      SURVIVES undo on purpose (undo.service.ts reverses through it), so a row
 *      that has been taken back still carries the id of the customer it made.
 *      The status is the only thing that says the create still stands.
 *   2. The customer row is still there. Undo's delete branch removes it, and so
 *      does a person with a delete button. Without this check the create hits a
 *      foreign key and the owner gets a 500 for a card the surface said was
 *      ready.
 *   3. The customer is not archived. Undo's OTHER branch archives rather than
 *      deletes when a human has written on the record, and an owner archives
 *      customers they are done with. Filing money against someone nobody can
 *      see is the same failure the Money-module refusal exists for: a write
 *      that reports success and shows the owner nothing.
 */
import type { PrismaClient } from "@prisma/client";

/** The customer a money card will be filed under. */
export interface ChainedCustomer {
  companyId: string;
  /** Shown on the card. A money payload carries no `companyName`, so without
   *  this the owner would be asked to approve a filing whose subject is not
   *  named anywhere on the screen. */
  companyName: string;
}

/**
 * Structural rather than `PrismaClient`, so the same function runs against the
 * client and against a `Prisma.TransactionClient` inside `applyProposal`'s
 * transaction — where it MUST run, so that the check and the write see the same
 * snapshot.
 */
export type ChainDb = Pick<PrismaClient, "ingestProposal" | "crmCompany">;

export async function resolveChainedCustomer(
  db: ChainDb,
  dependsOnProposalId: string | null | undefined,
): Promise<ChainedCustomer | null> {
  if (!dependsOnProposalId) return null;

  const parent = await db.ingestProposal.findUnique({
    where: { id: dependsOnProposalId },
    select: { status: true, createdCompanyId: true },
  });
  if (!parent || parent.status !== "APPLIED" || !parent.createdCompanyId) return null;

  const company = await db.crmCompany.findUnique({
    where: { id: parent.createdCompanyId },
    select: { id: true, name: true, isArchived: true },
  });
  if (!company || company.isArchived) return null;

  return { companyId: company.id, companyName: company.name };
}

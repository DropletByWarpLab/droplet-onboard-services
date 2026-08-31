/**
 * WARP-2562 (ADR-044) — the party-link seam.
 *
 * A `PartyLink` says "this contact and that upstream record are the same
 * customer", without copying the upstream record in. The ERP stays the system
 * of record; this table holds a provider key and an opaque id, and nothing
 * else. See the model's own doc comment for why this is not
 * `Contact.externalSystem`/`externalId` — that pair is unique on the party and
 * models provenance, which is a different question.
 *
 * Two scoping rules, inherited rather than invented:
 *
 *   · Contacts are OWNER-scoped (`Contact.userId`, the WARP-485 UUID). Every
 *     query here is scoped by it, and another owner's contact is 404 — never
 *     403, because a 403 confirms the row exists to someone who should not
 *     know that. `contacts.service.ts` states the same rule; this file does
 *     not get to differ from it.
 *   · Companies are BUSINESS-SHARED, like the rest of the CRM. No user scope.
 *
 * The XOR — exactly one of contactId/companyId — is checked here for a
 * readable error AND by `PartyLink_party_exactly_one` in the database. The
 * CHECK is the invariant; this is the message. A connector or a hand-written
 * UPDATE never reaches this file.
 */

import type { PrismaClient, PartyLink, PartyLinkOrigin } from "@prisma/client";

export const PARTY_LINK_ERRORS = {
  /** Neither party id was given, or both were. */
  PARTY_AMBIGUOUS: "party_link_needs_exactly_one_party",
  CONTACT_NOT_FOUND: "contact_not_found",
  COMPANY_NOT_FOUND: "company_not_found",
  LINK_NOT_FOUND: "party_link_not_found",
  /** The (externalSystem, externalId) pair is already linked to some party. */
  ALREADY_LINKED: "party_link_already_exists",
  /** A confidence on a link nobody computed, or a MATCHED link without one. */
  CONFIDENCE_NEEDS_MATCHED: "party_link_confidence_needs_matched",
} as const;

export interface ApiPartyLink {
  id: string;
  contactId: string | null;
  companyId: string | null;
  externalSystem: string;
  externalId: string;
  linkedBy: PartyLinkOrigin;
  confidence: number | null;
  isArchived: boolean;
  archivedAt: string | null;
  createdAt: string;
}

function toApi(row: PartyLink): ApiPartyLink {
  return {
    id: row.id,
    contactId: row.contactId,
    companyId: row.companyId,
    externalSystem: row.externalSystem,
    externalId: row.externalId,
    linkedBy: row.linkedBy,
    confidence: row.confidence,
    isArchived: row.isArchived,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface PartyRef {
  contactId?: string | null;
  companyId?: string | null;
}

/**
 * Resolve exactly one party, and prove the caller may see it.
 *
 * Returns the normalised pair rather than a boolean so callers cannot forget
 * to null the other side: passing `{ contactId: "x", companyId: undefined }`
 * straight into `create` would leave `companyId` unset rather than null, and
 * the difference matters to the CHECK constraint.
 */
async function resolveParty(
  prisma: PrismaClient,
  ref: PartyRef,
  userId: string,
): Promise<{ contactId: string | null; companyId: string | null }> {
  const contactId = ref.contactId ?? null;
  const companyId = ref.companyId ?? null;
  if ((contactId === null) === (companyId === null)) {
    // Both or neither. Both is "which party is this?"; neither is a pointer to
    // an upstream record with nothing on this side.
    throw new Error(PARTY_LINK_ERRORS.PARTY_AMBIGUOUS);
  }

  if (contactId !== null) {
    // Scoped by userId in the QUERY, not checked after the fetch — the row of
    // another owner must be indistinguishable from a row that is not there.
    const found = await prisma.contact.findFirst({
      where: { id: contactId, userId },
      select: { id: true },
    });
    if (!found) throw new Error(PARTY_LINK_ERRORS.CONTACT_NOT_FOUND);
  } else {
    const found = await prisma.crmCompany.findUnique({
      where: { id: companyId as string },
      select: { id: true },
    });
    if (!found) throw new Error(PARTY_LINK_ERRORS.COMPANY_NOT_FOUND);
  }

  return { contactId, companyId };
}

export interface CreatePartyLinkInput extends PartyRef {
  externalSystem: string;
  externalId: string;
  linkedBy?: PartyLinkOrigin;
  confidence?: number | null;
}

export async function createPartyLink(
  prisma: PrismaClient,
  input: CreatePartyLinkInput,
  userId: string,
  actorId: string | null,
): Promise<ApiPartyLink> {
  const party = await resolveParty(prisma, input, userId);
  const linkedBy: PartyLinkOrigin = input.linkedBy ?? "MANUAL";
  const confidence = input.confidence ?? null;

  // Mirrors `PartyLink_confidence_matched_only`. A confidence on a hand-made
  // link is a number nobody computed, and a MATCHED link without one hides
  // how sure the matcher was — both would be read later as if they meant
  // something.
  if ((linkedBy === "MATCHED") !== (confidence !== null)) {
    throw new Error(PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED);
  }
  if (confidence !== null && (confidence < 0 || confidence > 100)) {
    throw new Error(PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED);
  }

  // Checked before the write for a clean 409. The unique index is what
  // actually holds under a race, and the route maps Prisma's P2002 to the
  // same code — so two simultaneous links to one upstream record cannot both
  // succeed just because both passed this read.
  const clash = await prisma.partyLink.findUnique({
    where: {
      externalSystem_externalId: {
        externalSystem: input.externalSystem,
        externalId: input.externalId,
      },
    },
    select: { id: true },
  });
  if (clash) throw new Error(PARTY_LINK_ERRORS.ALREADY_LINKED);

  const row = await prisma.partyLink.create({
    data: {
      contactId: party.contactId,
      companyId: party.companyId,
      externalSystem: input.externalSystem,
      externalId: input.externalId,
      linkedBy,
      confidence,
      createdById: actorId,
    },
  });
  return toApi(row);
}

/**
 * The links on one party.
 *
 * Archived links are excluded by default: an unlinking should get the row off
 * the screen, which is the whole reason it is an archive rather than a delete
 * (WARP-2554 made exactly this argument for `Contact`).
 */
export async function listPartyLinks(
  prisma: PrismaClient,
  ref: PartyRef,
  userId: string,
  includeArchived = false,
): Promise<ApiPartyLink[]> {
  const party = await resolveParty(prisma, ref, userId);
  const rows = await prisma.partyLink.findMany({
    where: {
      contactId: party.contactId,
      companyId: party.companyId,
      ...(includeArchived ? {} : { isArchived: false }),
    },
    orderBy: [{ externalSystem: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toApi);
}

/**
 * Unlink, reversibly.
 *
 * NOT a delete. "These were never the same customer" is a claim worth keeping
 * — and the unique index means a hard delete would silently free the upstream
 * id for a different party, with no record that it had ever been claimed.
 *
 * The party is re-resolved from the row so the owner scope is applied to a
 * contact-linked row too; without it, knowing a link id would be enough to
 * archive another owner's link.
 */
export async function archivePartyLink(
  prisma: PrismaClient,
  id: string,
  userId: string,
  archived = true,
): Promise<ApiPartyLink> {
  const row = await prisma.partyLink.findUnique({ where: { id } });
  if (!row) throw new Error(PARTY_LINK_ERRORS.LINK_NOT_FOUND);

  if (row.contactId !== null) {
    const owned = await prisma.contact.findFirst({
      where: { id: row.contactId, userId },
      select: { id: true },
    });
    // 404 on the LINK, not on the contact: the caller asked about a link, and
    // naming the contact would confirm a row they may not know exists.
    if (!owned) throw new Error(PARTY_LINK_ERRORS.LINK_NOT_FOUND);
  }

  const updated = await prisma.partyLink.update({
    where: { id },
    data: { isArchived: archived, archivedAt: archived ? new Date() : null },
  });
  return toApi(updated);
}

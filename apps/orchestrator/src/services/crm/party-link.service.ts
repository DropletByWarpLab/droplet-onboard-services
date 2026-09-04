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
  /** No `IntegrationConnection` with that id. */
  CONNECTION_NOT_FOUND: "connection_not_found",
  /**
   * The connection EXISTS but holds no credential a live fetch could spend —
   * see `LINKABLE_CONNECTION_STATUSES`. Distinct from `CONNECTION_NOT_FOUND`
   * on purpose: the id is right and the owner has something to do about it
   * (reconnect), which a 404 would not tell them.
   */
  CONNECTION_NOT_ACTIVE: "party_link_connection_not_active",
  /** This record in THIS connection is already linked to some LIVE party. */
  ALREADY_LINKED: "party_link_already_exists",
  /** A confidence on a link nobody computed, or a MATCHED link without one. */
  CONFIDENCE_NEEDS_MATCHED: "party_link_confidence_needs_matched",
} as const;

/**
 * Connection statuses a NEW link may be created against.
 *
 * A `PartyLink` is a pointer whose entire value is that its detail is fetched
 * LIVE through the connector. `disconnect()` writes `status: "DISABLED"` and
 * purges `apiCredentialsEnc` and `providerTokensEnc` in the same update, so a
 * link made against a disabled connection points at a record nothing on this
 * box can read — and a browser tab left open across a disconnect is enough to
 * make one.
 *
 * Read from the `status` COLUMN, never inferred from a missing credential
 * (WARP-884): a reader must not have to work out which flavour of null they
 * are holding.
 *
 * Deliberately WIDER than `POLLABLE_CONNECTION_STATUSES` in
 * `erp-sync/cursor.service.ts`, which governs a metered vendor call on a
 * schedule. This governs a human writing a local row, so:
 *
 *   • `DEGRADED` is an explicitly transient sync failure. Refusing it would
 *     block linking for a state the owner can do nothing about and which a
 *     retry is meant to clear.
 *   • `DRIFT_LOCKED` freezes WRITES to the upstream. A party link is a local
 *     row and its detail is a READ, so neither is affected.
 *
 * Excluded, each because the link would point at something unreadable:
 * `NOT_CONFIGURED` and `PROVISIONING` (no completed probe, nothing to spend),
 * `NEEDS_RECONNECT` (the stored credential no longer works), `ERROR`
 * (reconnecting will not fix it), `DISABLED` (turned off, and purged).
 *
 * Not a hard block on EXISTING links: a connection can be disconnected after
 * a link is made, and those links stay — they are the record of a decision a
 * human took, and reconnecting the same row revives them.
 */
export const LINKABLE_CONNECTION_STATUSES = ["CONNECTED", "DEGRADED", "DRIFT_LOCKED"] as const;

export interface ApiPartyLink {
  id: string;
  contactId: string | null;
  companyId: string | null;
  /** WARP-2562 — which connection's upstream, not merely which vendor. */
  connectionId: string;
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
    connectionId: row.connectionId,
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

/**
 * Widened to `string` rather than the generated `IntegrationStatus` union
 * because the caller reads it off a `select`, and a status the enum gains
 * later must default to REFUSED rather than to allowed. A new member is a new
 * decision, and this is the safe side of it.
 */
function isLinkableStatus(status: string): boolean {
  return (LINKABLE_CONNECTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Is this upstream record claimed by a link that is still LIVE?
 *
 * The exact predicate of `PartyLink_connectionId_externalId_active_key`. Kept
 * in one function so the create path and the un-archive path cannot drift into
 * asking two different questions of one index — which is how the shipped
 * version got here: the create path asked a question the index could not
 * answer, and nothing else asked at all.
 */
async function findLiveClaim(
  prisma: PrismaClient,
  connectionId: string,
  externalId: string,
): Promise<{ id: string } | null> {
  return prisma.partyLink.findFirst({
    where: { connectionId, externalId, isArchived: false },
    select: { id: true },
  });
}

export interface CreatePartyLinkInput extends PartyRef {
  /**
   * WARP-2562 — the connection whose upstream holds `externalId`.
   *
   * Replaces a caller-supplied `externalSystem`. The provider is now DERIVED
   * from this connection, so a link cannot claim a vendor its own connection
   * contradicts, and two connections on one provider stay distinguishable —
   * which they must be, because HubSpot object ids are portal-scoped.
   */
  connectionId: string;
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

  // WARP-2562 — the connection must exist, and it is where the provider comes
  // from. Read before the clash check so a bad connection id is a 404 about
  // the connection rather than a confusing "already linked".
  const connection = await prisma.integrationConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, provider: true, status: true },
  });
  if (!connection) throw new Error(PARTY_LINK_ERRORS.CONNECTION_NOT_FOUND);

  // WARP-2562 review — the connection must still be one a live fetch can go
  // through. `disconnect()` flips a row to DISABLED and purges both credential
  // columns in the same write, so without this a stale tab creates a pointer
  // whose detail can never be resolved. See `LINKABLE_CONNECTION_STATUSES` for
  // why the list is what it is; the status comes from the enum COLUMN rather
  // than from "is a credential missing".
  if (!isLinkableStatus(connection.status)) {
    throw new Error(PARTY_LINK_ERRORS.CONNECTION_NOT_ACTIVE);
  }

  // Checked before the write for a clean 409. The partial unique index is what
  // actually holds under a race, and the route maps Prisma's P2002 to the
  // same code — so two simultaneous links to one upstream record cannot both
  // succeed just because both passed this read.
  //
  // Scoped by CONNECTION. Under the old provider-scoped key, linking portal
  // B's object `123` was refused because portal A already had an object `123`
  // — two unrelated customers, and the second one unlinkable forever.
  //
  // `findFirst`, not `findUnique`, and `isArchived: false` is the whole point.
  // The compound key has no `isArchived` column, so a keyed lookup answers
  // "has this record EVER been claimed" — under which archiving a wrong link
  // held the record forever and the correct party could never be linked. The
  // index is now partial (`WHERE "isArchived" = false`) and this read asks it
  // the same question it answers.
  const clash = await findLiveClaim(prisma, connection.id, input.externalId);
  if (clash) throw new Error(PARTY_LINK_ERRORS.ALREADY_LINKED);

  const row = await prisma.partyLink.create({
    data: {
      contactId: party.contactId,
      companyId: party.companyId,
      connectionId: connection.id,
      // DERIVED, never taken from the request. A caller-supplied provider can
      // disagree with its own connection, and nothing downstream could tell
      // which half was true.
      externalSystem: connection.provider,
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
 * The unarchived links on a COMPANY, with no owner scope (WARP-2563).
 *
 * Separate from `listPartyLinks` above rather than a flag on it, because the
 * difference is not cosmetic: that function resolves a party and proves the
 * caller may see it, and its contact branch is owner-scoped. A company is
 * business-shared, so there is nothing to scope — and a `userId` parameter
 * that is accepted and ignored is the kind of signature that gets copied to
 * the contact side by someone reading it quickly.
 *
 * The caller is the customer-record read, which has already resolved the
 * company and returned 404 if it does not exist.
 */
export async function listPartyLinksForCompany(
  prisma: PrismaClient,
  companyId: string,
): Promise<ApiPartyLink[]> {
  const rows = await prisma.partyLink.findMany({
    where: { companyId, isArchived: false },
    orderBy: [{ externalSystem: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toApi);
}

/**
 * Unlink, reversibly.
 *
 * NOT a delete. "These were never the same customer" is a claim worth keeping,
 * and a hard delete would lose the record that the upstream id had ever been
 * claimed at all.
 *
 * The party is re-resolved from the row so the owner scope is applied to a
 * contact-linked row too; without it, knowing a link id would be enough to
 * archive another owner's link.
 *
 * ## Un-archiving can now COLLIDE
 *
 * Archiving frees the `(connectionId, externalId)` slot — that is the point of
 * the partial unique. The dual is that undo is no longer unconditional: if
 * someone linked the correct party in the meantime, restoring this one would
 * mean two live claims on one upstream record. The database refuses that with
 * a P2002, which the route already maps to the same 409 as a create clash;
 * checked here as well so a caller that is not the route (a tool, the
 * WARP-2549 landing seam) gets the service's own code rather than a raw
 * Prisma error.
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

  // Only on the way BACK. Archiving can never collide, and re-archiving an
  // already-archived row is a no-op the caller is entitled to.
  if (!archived && row.isArchived) {
    const claimed = await findLiveClaim(prisma, row.connectionId, row.externalId);
    if (claimed) throw new Error(PARTY_LINK_ERRORS.ALREADY_LINKED);
  }

  const updated = await prisma.partyLink.update({
    where: { id },
    data: { isArchived: archived, archivedAt: archived ? new Date() : null },
  });
  return toApi(updated);
}

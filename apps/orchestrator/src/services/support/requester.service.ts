/**
 * Service desk (ADR-069 §2) — who may ask, and who may answer.
 *
 * A `Contact` is OWNER-scoped (`Contact.userId`): an address book is private to
 * its owner, and `routes/contacts.ts` enforces that hard. The CRM is
 * business-shared, so it makes a contact visible by a deliberate act — linking
 * it to a company or a deal (services/crm/crm.service.ts, "Contacts, read").
 * The desk follows the same rule and adds one more deliberate act: raising a
 * ticket. So a member may attach to a ticket a contact that is
 *
 *   (a) in their own address book, or
 *   (b) CRM-visible — linked to a customer or a deal, or
 *   (c) already the requester of a ticket (somebody on the team chose them).
 *
 * Anyone else's private contact reads as `contact_not_found`, never as
 * forbidden: the desk must not confirm a row in somebody's address book. Once a
 * contact is on a ticket, every agent sees who asked through the ticket itself,
 * which is why the ticket carries a name/email snapshot as well.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { createContact, normalizeEmail } from "../contacts/contacts.service.js";
import { resolveEffectiveAccess, type EffectiveAccessResult } from "../effective-access.service.js";
import {
  SUPPORT_ERRORS,
  type ApiContactCandidate,
  type ApiPerson,
  type RequesterContactInput,
  type SupportCtx,
  type SupportViewer,
} from "./support.types.js";

export interface SupportDeps {
  resolveAccess?: (userId: string) => Promise<EffectiveAccessResult | null>;
  now?: () => Date;
}

/** Thrown by {@link createRequesterContact} when the caller can already see a
 *  contact with that address — the route answers 409 and names it. */
export class SupportContactExistsError extends Error {
  readonly contactId: string;
  constructor(contactId: string) {
    super(SUPPORT_ERRORS.CONTACT_EMAIL_EXISTS);
    this.name = "SupportContactExistsError";
    this.contactId = contactId;
  }
}

const STAFF_ROLES = ["owner", "admin", "family"] as const;
const CANDIDATE_LIMIT = 20;

const CANDIDATE_SELECT = {
  id: true,
  displayName: true,
  organization: true,
  emails: { select: { address: true }, orderBy: [{ isPrimary: "desc" }, { address: "asc" }], take: 1 },
} satisfies Prisma.ContactSelect;
type CandidateRow = Prisma.ContactGetPayload<{ select: typeof CANDIDATE_SELECT }>;

const toCandidate = (row: CandidateRow, via: ApiContactCandidate["via"]): ApiContactCandidate => ({
  id: row.id,
  name: row.displayName,
  email: row.emails[0]?.address ?? null,
  organization: row.organization,
  via,
});

/** Linked to a customer or a deal: the CRM's own definition of "visible". */
const CRM_VISIBLE_ARMS: Prisma.ContactWhereInput[] = [
  { companyLinks: { some: {} } },
  { dealLinks: { some: {} } },
];
const CRM_VISIBLE: Prisma.ContactWhereInput = { OR: CRM_VISIBLE_ARMS };

/**
 * The contact a ticket is being raised for, or CONTACT_NOT_FOUND — whether the
 * row does not exist, is archived, or is simply not the caller's to use.
 * Returns what the ticket snapshots: the name, the primary email and the
 * customer the contact belongs to when there is exactly one.
 */
export async function usableContact(
  prisma: PrismaClient,
  viewerId: string,
  contactId: string,
  ctx: SupportCtx,
): Promise<{ name: string; email: string | null; soleCompanyId: string | null }> {
  const row = await prisma.contact.findFirst({
    where: { id: contactId, isArchived: false },
    select: {
      userId: true,
      displayName: true,
      emails: { select: { address: true }, orderBy: [{ isPrimary: "desc" }, { address: "asc" }], take: 1 },
      companyLinks: { select: { companyId: true } },
      _count: { select: { dealLinks: true } },
    },
  });
  if (!row) throw new Error(SUPPORT_ERRORS.CONTACT_NOT_FOUND);
  // A customer's people are the CRM's data: visible here only to someone who
  // holds the CRM grant as well.
  const visible =
    row.userId === viewerId ||
    (ctx.canReadCrm && (row.companyLinks.length > 0 || row._count.dealLinks > 0));
  if (!visible) {
    const asRequester = await prisma.pmTicket.findFirst({
      where: { requesterContactId: contactId },
      select: { workItemId: true },
    });
    if (!asRequester) throw new Error(SUPPORT_ERRORS.CONTACT_NOT_FOUND);
  }
  return {
    name: row.displayName,
    email: row.emails[0]?.address ?? null,
    // Exactly one company at intake, otherwise left for a human — never guessed.
    // And never read at all for someone without the CRM grant.
    soleCompanyId:
      ctx.canReadCrm && row.companyLinks.length === 1 ? row.companyLinks[0]!.companyId : null,
  };
}

export async function searchRequesterContacts(
  prisma: PrismaClient,
  viewer: SupportViewer,
  q: string,
  ctx: SupportCtx,
): Promise<ApiContactCandidate[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const text: Prisma.ContactWhereInput = {
    OR: [
      { displayName: { contains: term, mode: "insensitive" } },
      { organization: { contains: term, mode: "insensitive" } },
      { emails: { some: { addressLower: { contains: normalizeEmail(term) } } } },
    ],
  };
  const byName = [{ displayName: "asc" as const }];

  const [own, customer, ticketRows] = await Promise.all([
    prisma.contact.findMany({
      where: { AND: [{ isArchived: false, userId: viewer.id }, text] },
      select: CANDIDATE_SELECT,
      orderBy: byName,
      take: CANDIDATE_LIMIT,
    }),
    ctx.canReadCrm
      ? prisma.contact.findMany({
          where: { AND: [{ isArchived: false }, CRM_VISIBLE, text] },
          select: CANDIDATE_SELECT,
          orderBy: byName,
          take: CANDIDATE_LIMIT,
        })
      : Promise.resolve([] as CandidateRow[]),
    prisma.pmTicket.findMany({
      where: {
        requesterKind: "CONTACT",
        requesterContactId: { not: null },
        OR: [
          { requesterName: { contains: term, mode: "insensitive" } },
          { requesterEmail: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { requesterContactId: true },
      distinct: ["requesterContactId"],
      take: CANDIDATE_LIMIT,
    }),
  ]);

  const requesterIds = ticketRows.flatMap((t) => (t.requesterContactId ? [t.requesterContactId] : []));
  const requesters = requesterIds.length
    ? await prisma.contact.findMany({
        where: { id: { in: requesterIds }, isArchived: false },
        select: CANDIDATE_SELECT,
        orderBy: byName,
      })
    : [];

  const seen = new Set<string>();
  const out: ApiContactCandidate[] = [];
  const add = (rows: CandidateRow[], via: ApiContactCandidate["via"]) => {
    for (const row of rows) {
      if (seen.has(row.id) || out.length >= CANDIDATE_LIMIT) continue;
      seen.add(row.id);
      out.push(toCandidate(row, via));
    }
  };
  add(own, "yours");
  add(customer, "customer");
  add(requesters, "requester");
  return out;
}

/**
 * Add a person to the caller's own address book from the new-ticket form, through
 * the same service the CRM uses — never a second person-shaped table. Refuses an
 * address a contact the caller can already see holds, naming that contact, so a
 * typo does not fork one customer into two (email intake matches on address).
 */
export async function createRequesterContact(
  prisma: PrismaClient,
  viewer: SupportViewer,
  input: RequesterContactInput,
  ctx: SupportCtx,
): Promise<ApiContactCandidate> {
  const email = input.email?.trim();
  if (email) {
    const lower = normalizeEmail(email);
    const held = await prisma.contactEmail.findFirst({
      where: {
        addressLower: lower,
        contact: {
          isArchived: false,
          OR: [{ userId: viewer.id }, ...(ctx.canReadCrm ? CRM_VISIBLE_ARMS : [])],
        },
      },
      select: { contactId: true },
    });
    if (held) throw new SupportContactExistsError(held.contactId);
    const asRequester = await prisma.pmTicket.findFirst({
      where: { requesterKind: "CONTACT", requesterEmail: { equals: email, mode: "insensitive" } },
      select: { requesterContactId: true },
    });
    if (asRequester?.requesterContactId) {
      const live = await prisma.contact.findFirst({
        where: { id: asRequester.requesterContactId, isArchived: false },
        select: { id: true },
      });
      if (live) throw new SupportContactExistsError(live.id);
    }
  }
  const created = await createContact(prisma, viewer.id, {
    displayName: input.displayName ?? null,
    givenName: input.givenName ?? null,
    familyName: input.familyName ?? null,
    organization: input.organization ?? null,
    emails: email ? [{ address: email, isPrimary: true }] : [],
    phones: input.phone?.trim() ? [{ number: input.phone, isPrimary: true }] : [],
  });
  return {
    id: created.id,
    name: created.displayName,
    email: created.emails[0]?.address ?? null,
    organization: created.organization,
    via: "yours",
  };
}

// ── Agents ───────────────────────────────────────────────────────────────────

const holdsSupport = (access: EffectiveAccessResult | null): boolean =>
  access !== null && access.features.some((f) => f.moduleId === "support");

/** Resolve access for many users, a few at a time — each is several queries. */
async function holdingSupport(
  userIds: readonly string[],
  deps: SupportDeps,
): Promise<Set<string>> {
  const resolve = deps.resolveAccess ?? resolveEffectiveAccess;
  const held = new Set<string>();
  const CHUNK = 8;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    const verdicts = await Promise.all(chunk.map(async (id) => holdsSupport(await resolve(id))));
    chunk.forEach((id, idx) => {
      if (verdicts[idx]) held.add(id);
    });
  }
  return held;
}

/** The members a ticket can be assigned to: active staff who hold Support. A
 *  guest never does, and a person narrowed away from Support is not offered. */
export async function listAgents(prisma: PrismaClient, deps: SupportDeps = {}): Promise<ApiPerson[]> {
  const users = await prisma.user.findMany({
    where: { directoryStatus: "ACTIVE", role: { in: [...STAFF_ROLES] } },
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
  });
  const held = await holdingSupport(
    users.map((u) => u.id),
    deps,
  );
  return users.filter((u) => held.has(u.id)).map((u) => ({ id: u.id, displayName: u.displayName }));
}

/** Throws INVALID_ASSIGNEE unless every id is an agent ({@link listAgents}'s rule). */
export async function assertAgents(
  prisma: PrismaClient,
  userIds: readonly string[],
  deps: SupportDeps = {},
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  const users = await prisma.user.findMany({
    where: { id: { in: unique }, directoryStatus: "ACTIVE", role: { in: [...STAFF_ROLES] } },
    select: { id: true },
  });
  if (users.length !== unique.length) throw new Error(SUPPORT_ERRORS.INVALID_ASSIGNEE);
  const held = await holdingSupport(unique, deps);
  if (held.size !== unique.length) throw new Error(SUPPORT_ERRORS.INVALID_ASSIGNEE);
}

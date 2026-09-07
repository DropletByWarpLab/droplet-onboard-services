/**
 * Contacts service — the data layer behind `/api/contacts/*`.
 *
 * WARP-2018 defined the schema; this is the LOCAL half of WARP-2032: create,
 * read, update, delete and search a contact that a human typed in. The CardDAV
 * half of 2032 — the discovery/verify handshake, the `cronRuntime` sync ticker
 * and photo storage — is deliberately NOT here. It writes through the same
 * `Contact` table via `AddressBookSource`, which is exactly why this service
 * exists first: the CRM needs to create a person today (WARP-2117), and the
 * alternative was a second person record, which WARP-2117 forbids.
 *
 * Visibility: contacts are OWNED, not household-shared. Every query is scoped
 * by `userId` — unlike PM, and like calendar. A caller can only ever see and
 * mutate their own rows; a row belonging to someone else reads as
 * `contact_not_found`, never as a 403, so the API does not confirm that an id
 * exists for another owner.
 *
 * Rows whose `origin` is EXTERNAL are owned by their source: the local write
 * paths refuse them (`contact_is_external`) rather than making an edit the next
 * sync silently reverts.
 *
 * Errors are thrown as plain `Error(code)` with stable string codes the route
 * layer maps to HTTP status, mirroring `pm.service.ts` and `calendar.service.ts`.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export const CONTACT_ERRORS = {
  CONTACT_NOT_FOUND: "contact_not_found",
  /// The row belongs to an address-book source, which owns its fields. A local
  /// edit would be reverted by the next sync, so it is refused up front.
  CONTACT_IS_EXTERNAL: "contact_is_external",
  /// WARP-2554 — the same refusal, for DELETE specifically, with somewhere to
  /// go. Distinct from CONTACT_IS_EXTERNAL because the remedy differs: an
  /// edit has no alternative (the source owns the field), whereas a delete
  /// does — archive it. A caller that cannot tell the two apart can only
  /// render a flat "no", which is the dead end this ticket removes.
  CONTACT_IS_EXTERNAL_ARCHIVE_INSTEAD: "contact_is_external_archive_instead",
  /// ADR-048 — a contact Droplet filed by itself may never carry a date of
  /// birth. The extraction schema has no field that could produce one, so this
  /// can only fire if a future caller passes both `filing` and `birthday`;
  /// refusing is cheaper than discovering it in a pg_dump.
  FILED_CONTACT_HAS_BIRTHDAY: "filed_contact_has_birthday",
  EMAIL_NOT_FOUND: "contact_email_not_found",
  PHONE_NOT_FOUND: "contact_phone_not_found",
  DUPLICATE_EMAIL: "contact_email_duplicate",
} as const;

/** Bound from WARP-2018: `rawVcard` is capped at 64 KB by the write path. */
export const RAW_VCARD_MAX_BYTES = 64 * 1024;

export interface ApiContactEmail {
  id: string;
  address: string;
  label: string | null;
  isPrimary: boolean;
}

export interface ApiContactPhone {
  id: string;
  number: string;
  label: string | null;
  isPrimary: boolean;
}

export interface ApiContact {
  id: string;
  origin: "LOCAL" | "EXTERNAL" | "EXTRACTED";
  sourceId: string | null;
  externalSystem: string | null;
  externalId: string | null;
  displayName: string;
  givenName: string | null;
  familyName: string | null;
  organization: string | null;
  jobTitle: string | null;
  note: string | null;
  /** String, not a date. RFC 6350 §4.3.1 partial dates such as `--0423`. */
  birthday: string | null;
  emails: ApiContactEmail[];
  phones: ApiContactPhone[];
  /** WARP-2554 — owner state, not vendor state. The only column a sync must
   *  never overwrite on a row it otherwise owns. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

const CONTACT_INCLUDE = {
  emails: { orderBy: [{ isPrimary: "desc" }, { address: "asc" }] },
  phones: { orderBy: [{ isPrimary: "desc" }, { number: "asc" }] },
} satisfies Prisma.ContactInclude;

type ContactRow = Prisma.ContactGetPayload<{ include: typeof CONTACT_INCLUDE }>;

function toApi(row: ContactRow): ApiContact {
  return {
    id: row.id,
    origin: row.origin,
    sourceId: row.sourceId,
    externalSystem: row.externalSystem,
    externalId: row.externalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    organization: row.organization,
    jobTitle: row.jobTitle,
    note: row.note,
    birthday: row.birthday,
    emails: row.emails.map((e) => ({
      id: e.id,
      address: e.address,
      label: e.label,
      isPrimary: e.isPrimary,
    })),
    phones: row.phones.map((p) => ({
      id: p.id,
      number: p.number,
      label: p.label,
      isPrimary: p.isPrimary,
    })),
    archived: row.isArchived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The indexed lookup form of an address. Derived on write and never read from
 * user input, so a caller cannot supply an `addressLower` that disagrees with
 * `address` and quietly poison the dedupe key.
 */
export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * `tel:` scheme stripped, per WARP-2018. Everything else is left alone: phone
 * numbers are formatted by humans in ways no normalizer improves, and rewriting
 * them loses the extension syntax people actually dial.
 */
export function normalizePhone(number: string): string {
  return number.trim().replace(/^tel:/i, "");
}

/**
 * Display name is required by the schema, but "first name and nothing else" is
 * a real contact. Build one rather than rejecting the input, and fall back to
 * the primary email so a row is never a blank line in a list.
 */
export function deriveDisplayName(input: {
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  organization?: string | null;
  emails?: ReadonlyArray<{ address: string }>;
}): string | null {
  const explicit = input.displayName?.trim();
  if (explicit) return explicit;
  const parts = [input.givenName?.trim(), input.familyName?.trim()].filter(
    (p): p is string => !!p,
  );
  if (parts.length) return parts.join(" ");
  const org = input.organization?.trim();
  if (org) return org;
  const email = input.emails?.[0]?.address.trim();
  return email || null;
}

export interface ListContactsOptions {
  /** Substring match over display name, organization and email. */
  query?: string;
  /** Cap, clamped to [1, 200]. Defaults to 50. */
  perPage?: number;
  page?: number;
  /** Include rows owned by an address-book source. Defaults to true. */
  includeExternal?: boolean;
  /**
   * WARP-2554 — include rows the owner archived. Defaults to FALSE.
   *
   * Archiving is the only way to get a synced contact out of the way, so it
   * has to actually get it out of the way: a default that still listed them
   * would make the action pointless for the case it exists to serve.
   */
  includeArchived?: boolean;
}

export async function listContacts(
  prisma: PrismaClient,
  userId: string,
  opts: ListContactsOptions = {},
): Promise<{ contacts: ApiContact[]; total: number }> {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const q = opts.query?.trim();

  const where: Prisma.ContactWhereInput = { userId };
  if (opts.includeExternal === false) where.origin = "LOCAL";
  // WARP-2554 — archived rows are hidden unless asked for. Filtered on the
  // explicit column, never on `archivedAt IS NOT NULL` (WARP-884).
  if (!opts.includeArchived) where.isArchived = false;
  if (q) {
    where.OR = [
      { displayName: { contains: q, mode: "insensitive" } },
      { organization: { contains: q, mode: "insensitive" } },
      // Matched against the derived lowercase column, so the index is used and
      // the comparison does not depend on how the caller cased their input.
      { emails: { some: { addressLower: { contains: normalizeEmail(q) } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      include: CONTACT_INCLUDE,
      orderBy: { displayName: "asc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.contact.count({ where }),
  ]);
  return { contacts: rows.map(toApi), total };
}

/** Scoped by owner: another user's row reads as absent, not as forbidden. */
export async function getContact(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<ApiContact> {
  const row = await prisma.contact.findFirst({ where: { id, userId }, include: CONTACT_INCLUDE });
  if (!row) throw new Error(CONTACT_ERRORS.CONTACT_NOT_FOUND);
  return toApi(row);
}

export interface ContactInput {
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  note?: string | null;
  birthday?: string | null;
  emails?: Array<{ address: string; label?: string | null; isPrimary?: boolean }>;
  phones?: Array<{ number: string; label?: string | null; isPrimary?: boolean }>;
}

/**
 * At most one primary of each kind, and if the caller marked none, the first
 * one becomes primary. Otherwise a list with no primary renders with no
 * headline address, and a list with three renders arbitrarily.
 */
function pickPrimary<T extends { isPrimary?: boolean }>(items: T[]): Array<T & { isPrimary: boolean }> {
  const flagged = items.findIndex((i) => i.isPrimary === true);
  const primaryIndex = flagged >= 0 ? flagged : items.length > 0 ? 0 : -1;
  return items.map((item, i) => ({ ...item, isPrimary: i === primaryIndex }));
}

/**
 * ADR-048 (WARP-2730) — provenance for a contact Droplet filed by itself.
 *
 * 🔴 A filed contact NEVER carries a `birthday`. The column exists on this
 * model and the filing extraction schema has no field that could populate it —
 * a date of birth is the single most identifying thing on a practice box, and
 * `CREATE_CONTACT` is review-only in every mode partly because of it. If a
 * future caller passes `input.birthday` alongside `filing`, that is a bug, and
 * the guard below refuses rather than trusting the caller.
 */
export interface ContactFilingProvenance {
  proposalId: string;
}

export async function createContact(
  prisma: PrismaClient,
  userId: string,
  input: ContactInput,
  filing?: ContactFilingProvenance,
): Promise<ApiContact> {
  if (filing && input.birthday) throw new Error(CONTACT_ERRORS.FILED_CONTACT_HAS_BIRTHDAY);
  const emails = pickPrimary(input.emails ?? []);
  const phones = pickPrimary(input.phones ?? []);
  const displayName = deriveDisplayName({ ...input, emails });
  if (!displayName) throw new Error("contact_needs_a_name");

  const seen = new Set<string>();
  for (const e of emails) {
    const lower = normalizeEmail(e.address);
    if (seen.has(lower)) throw new Error(CONTACT_ERRORS.DUPLICATE_EMAIL);
    seen.add(lower);
  }

  const row = await prisma.contact.create({
    data: {
      userId,
      origin: filing ? "EXTRACTED" : "LOCAL",
      proposalId: filing?.proposalId ?? null,
      displayName,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
      organization: input.organization ?? null,
      jobTitle: input.jobTitle ?? null,
      note: input.note ?? null,
      birthday: input.birthday ?? null,
      emails: {
        create: emails.map((e) => ({
          address: e.address.trim(),
          addressLower: normalizeEmail(e.address),
          label: e.label ?? null,
          isPrimary: e.isPrimary,
        })),
      },
      phones: {
        create: phones.map((p) => ({
          number: normalizePhone(p.number),
          label: p.label ?? null,
          isPrimary: p.isPrimary,
        })),
      },
    },
    include: CONTACT_INCLUDE,
  });
  return toApi(row);
}

/**
 * Field updates only — email and phone collections are replaced wholesale when
 * supplied, because a partial merge of an unordered collection has no
 * well-defined meaning and every attempt at one grows a second API.
 */
export async function updateContact(
  prisma: PrismaClient,
  userId: string,
  id: string,
  input: ContactInput,
): Promise<ApiContact> {
  const existing = await prisma.contact.findFirst({
    where: { id, userId },
    include: CONTACT_INCLUDE,
  });
  if (!existing) throw new Error(CONTACT_ERRORS.CONTACT_NOT_FOUND);
  // Explicit origin check, not `sourceId !== null`: a row can be EXTERNAL
  // because a cloud connector owns it, with no address-book source at all.
  if (existing.origin === "EXTERNAL") throw new Error(CONTACT_ERRORS.CONTACT_IS_EXTERNAL);

  const emails = input.emails ? pickPrimary(input.emails) : undefined;
  const phones = input.phones ? pickPrimary(input.phones) : undefined;

  if (emails) {
    const seen = new Set<string>();
    for (const e of emails) {
      const lower = normalizeEmail(e.address);
      if (seen.has(lower)) throw new Error(CONTACT_ERRORS.DUPLICATE_EMAIL);
      seen.add(lower);
    }
  }

  const displayName = deriveDisplayName({
    displayName: input.displayName ?? existing.displayName,
    givenName: input.givenName ?? existing.givenName,
    familyName: input.familyName ?? existing.familyName,
    organization: input.organization ?? existing.organization,
    emails: emails ?? existing.emails,
  });

  const row = await prisma.$transaction(async (tx) => {
    if (emails) {
      await tx.contactEmail.deleteMany({ where: { contactId: id } });
      await tx.contactEmail.createMany({
        data: emails.map((e) => ({
          contactId: id,
          address: e.address.trim(),
          addressLower: normalizeEmail(e.address),
          label: e.label ?? null,
          isPrimary: e.isPrimary,
        })),
      });
    }
    if (phones) {
      await tx.contactPhone.deleteMany({ where: { contactId: id } });
      await tx.contactPhone.createMany({
        data: phones.map((p) => ({
          contactId: id,
          number: normalizePhone(p.number),
          label: p.label ?? null,
          isPrimary: p.isPrimary,
        })),
      });
    }
    return tx.contact.update({
      where: { id },
      data: {
        displayName: displayName ?? existing.displayName,
        givenName: input.givenName === undefined ? undefined : input.givenName,
        familyName: input.familyName === undefined ? undefined : input.familyName,
        organization: input.organization === undefined ? undefined : input.organization,
        jobTitle: input.jobTitle === undefined ? undefined : input.jobTitle,
        note: input.note === undefined ? undefined : input.note,
        birthday: input.birthday === undefined ? undefined : input.birthday,
      },
      include: CONTACT_INCLUDE,
    });
  });
  return toApi(row);
}

export async function deleteContact(
  prisma: PrismaClient,
  userId: string,
  id: string,
): Promise<void> {
  const existing = await prisma.contact.findFirst({ where: { id, userId } });
  if (!existing) throw new Error(CONTACT_ERRORS.CONTACT_NOT_FOUND);
  // WARP-2554 — still refused, and still for the right reason: the next sync
  // would simply put the row back, and a delete that silently un-deletes is
  // worse than one that declines. What changed is that the caller is now told
  // what to do instead. Hard removal of synced rows belongs to the disconnect
  // purge (WARP-2461), which deletes by connection rather than by row.
  if (existing.origin === "EXTERNAL") {
    throw new Error(CONTACT_ERRORS.CONTACT_IS_EXTERNAL_ARCHIVE_INSTEAD);
  }
  // Emails, phones and the CRM link rows cascade in the schema (WARP-2018 /
  // WARP-2117) — no hand-rolled sweep here, deliberately.
  //
  // ⚠ So do this contact's CrmActivity rows, INCLUDING any whose own `origin`
  // is LOCAL. See the cascade note on `model CrmActivity`.
  await prisma.contact.delete({ where: { id } });
}

/**
 * Archive or restore a contact — WARP-2554.
 *
 * Deliberately permitted on EXTERNAL rows, which is the whole point: it is the
 * ONE action a human can take on a synced person. It records the owner's
 * decision about their own view without contradicting the source, so a
 * re-sync updates the row's fields and leaves it archived.
 *
 * A sync landing an update MUST NOT clear this flag. It is owner state, not
 * vendor state — the only column on a synced row that is.
 */
export async function setContactArchived(
  prisma: PrismaClient,
  userId: string,
  id: string,
  archived: boolean,
): Promise<ApiContact> {
  const existing = await prisma.contact.findFirst({ where: { id, userId } });
  if (!existing) throw new Error(CONTACT_ERRORS.CONTACT_NOT_FOUND);
  const row = await prisma.contact.update({
    where: { id },
    // `archivedAt` is the audit timestamp and moves WITH the state so the two
    // can never disagree; the state itself is always read from `isArchived`.
    data: { isArchived: archived, archivedAt: archived ? new Date() : null },
    include: CONTACT_INCLUDE,
  });
  return toApi(row);
}

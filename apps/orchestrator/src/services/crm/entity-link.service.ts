/**
 * EntityLink service (WARP-2585, ADR-045 slice 6) -- the data layer behind
 * `/api/crm/entity-links/*`.
 *
 * WHAT A LINK IS. A pointer from a file in /files to exactly one business
 * record. It is NOT an upload: `PmAttachment` copies bytes onto a work item
 * under its own `storageKey` and stays exactly as it is. A link grants no byte
 * access and never has -- /files re-runs its own gate on every read.
 *
 * WHY `ncFileId`. `FileComment`'s docstring already adjudicated the three
 * incompatible file identities this box ships: oc:fileid SURVIVES a rename or
 * a move, and `FileCitation.filePath` does not. This table follows that ruling.
 * `filePath`/`fileName`/`fileSpace` are a DISPLAY CACHE, not the key -- the
 * `TeamChatMessage.sharedFileName` / `sharedFilePath` / `sharedFileSpace`
 * precedent -- so a link whose file was later deleted in Nextcloud renders as
 * a name a human can act on instead of a bare integer. There is no FK to
 * enforce the file still exists and there cannot be one: the `File` registry is
 * deliberately incomplete (`upsertFileRegistryEntry` never throws), so an FK
 * would reject a link to any unregistered file. A dangling link is a state
 * this table tolerates and the UI shows; it is not a state a column pretends
 * to track.
 *
 * IDOR. `createdById` is the LOCAL `User.id` UUID (`req.user.id`), NEVER the
 * Nextcloud username (`getUser(req)`). FileComment records the real bug from
 * storing one and filtering on the other -- a `family` user saw zero of their
 * own comments. `createdById` here is PROVENANCE ONLY and gates nothing, the
 * `FileTag.addedByUserId` posture: a link is business-shared, like every other
 * CRM row.
 *
 * VISIBILITY -- the question a link raises that a comment does not. A link
 * carries a file NAME and PATH, so an unfiltered listing tells a reader that a
 * file they cannot open exists, and what it is called. The filter is the same
 * registry+space composition `routes/files.ts` (`gateFileSpaceAccess`) and
 * `routes/team-chat.ts` (file_share) already run:
 *
 *   - file registered to a department -> visible only to a principal who can
 *     READ that department (`readableDepartmentIdsFor`, which is pinned
 *     equivalent to `checkSpaceAccess(..., "reader")` in the .pg. suite);
 *   - file NOT in the registry -> visible, personal-space semantics. This is
 *     deliberate and matches team-chat's file_share: the row carries only the
 *     display fields the linker themselves supplied and the linker had to pass
 *     a PROPFIND as themselves to create it, so there is nothing to leak that
 *     the linker did not already put there on a shared business record.
 *
 * Rows are filtered OUT, never 403'd, and the reported total is the
 * POST-FILTER count -- a total that counted hidden rows would leak exactly the
 * existence this filter exists to hide. That is also why the subject listing
 * does not paginate: a filtered page window cannot report an honest total
 * without a second pass. It returns up to `LINK_LIST_CAP` rows and says so.
 *
 * Errors are thrown as plain `Error(code)` with stable string codes the route
 * layer maps to HTTP status, mirroring `crm.service.ts`.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { readableDepartmentIdsFor, type SpaceAccessCaller } from "../../middleware/space.js";

export const ENTITY_LINK_ERRORS = {
  SUBJECT_NOT_FOUND: "subject_not_found",
  LINK_NOT_FOUND: "link_not_found",
  /** MANUAL carries no confidence; SUGGESTED/EXTRACTED require one. Checked
   *  here as well as in Postgres so a caller gets a 422 naming the field
   *  rather than a driver error naming a constraint. */
  CONFIDENCE_MISMATCH: "confidence_mismatch",
} as const;

export type EntityLinkSubjectType =
  | "COMPANY"
  | "CONTACT"
  | "DEAL"
  | "PROJECT"
  | "WORK_ITEM";

export type EntityLinkRoleValue =
  | "CONTRACT"
  | "INVOICE"
  | "QUOTE"
  | "SCAN"
  | "CORRESPONDENCE"
  | "OTHER";

export type EntityLinkOriginValue = "MANUAL" | "SUGGESTED" | "EXTRACTED";

/**
 * Hard cap on one record's document list. A customer with more than this many
 * linked files is pathological, not merely busy; the flag says so rather than
 * silently returning a window whose total nobody can trust.
 */
export const LINK_LIST_CAP = 500;

/** subjectType -> the one column it licenses. The single place the mapping
 *  lives, so a new subject cannot be half-added. */
export const SUBJECT_COLUMN: Record<EntityLinkSubjectType, string> = {
  COMPANY: "companyId",
  CONTACT: "contactId",
  DEAL: "dealId",
  PROJECT: "projectId",
  WORK_ITEM: "workItemId",
};

export interface ApiEntityLink {
  id: string;
  ncFileId: number;
  fileName: string;
  filePath: string;
  /** "personal" | "shared" | "dept:<uuid>" -- the space `filePath` is relative
   *  to, in the wire vocabulary `/files?space=` understands. */
  fileSpace: string;
  subjectType: EntityLinkSubjectType;
  subjectId: string;
  role: EntityLinkRoleValue;
  linkedBy: EntityLinkOriginValue;
  confidence: number | null;
  note: string | null;
  archived: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

type LinkRow = Prisma.EntityLinkGetPayload<object>;

function subjectIdOf(row: LinkRow): string {
  switch (row.subjectType) {
    case "COMPANY":
      return row.companyId as string;
    case "CONTACT":
      return row.contactId as string;
    case "DEAL":
      return row.dealId as string;
    case "PROJECT":
      return row.projectId as string;
    default:
      return row.workItemId as string;
  }
}

function linkToApi(row: LinkRow): ApiEntityLink {
  return {
    id: row.id,
    ncFileId: row.ncFileId,
    fileName: row.fileName,
    filePath: row.filePath,
    fileSpace: row.fileSpace,
    subjectType: row.subjectType as EntityLinkSubjectType,
    subjectId: subjectIdOf(row),
    role: row.role as EntityLinkRoleValue,
    linkedBy: row.linkedBy as EntityLinkOriginValue,
    confidence: row.confidence,
    note: row.note,
    archived: row.isArchived,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The `where` fragment that addresses one (file, record) pair. Written once
 *  because the write path uses it three times and a drift between them is a
 *  duplicate row. */
function pairWhere(
  ncFileId: number,
  subjectType: EntityLinkSubjectType,
  subjectId: string,
): Prisma.EntityLinkWhereInput {
  return { ncFileId, [SUBJECT_COLUMN[subjectType]]: subjectId };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * The subject row must EXIST before a link points at it. The CHECK constraint
 * enforces the exactly-one shape; it cannot enforce that the id is real -- the
 * FK does that, but only as a 500-shaped driver error. This turns it into a
 * 404. (`crm.service.ts:logActivity` makes the same call for the same reason.)
 */
async function assertSubjectExists(
  prisma: PrismaClient,
  subjectType: EntityLinkSubjectType,
  subjectId: string,
): Promise<void> {
  const select = { id: true } as const;
  const found =
    subjectType === "COMPANY"
      ? await prisma.crmCompany.findUnique({ where: { id: subjectId }, select })
      : subjectType === "CONTACT"
        ? await prisma.contact.findUnique({ where: { id: subjectId }, select })
        : subjectType === "DEAL"
          ? await prisma.crmDeal.findUnique({ where: { id: subjectId }, select })
          : subjectType === "PROJECT"
            ? await prisma.pmProject.findUnique({ where: { id: subjectId }, select })
            : await prisma.pmWorkItem.findUnique({ where: { id: subjectId }, select });
  if (!found) throw new Error(ENTITY_LINK_ERRORS.SUBJECT_NOT_FOUND);
}

/** Nextcloud's display name for a file IS the last path segment. Derived
 *  server-side rather than accepted from the client: one fewer field to
 *  validate, and one fewer place a caller can write prose that later reads as
 *  the file's real name. */
export function fileNameFromPath(filePath: string): string {
  const segments = filePath.split("/").filter((s) => s.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : filePath;
}

export interface EntityLinkInput {
  ncFileId: number;
  /** Absolute, leading-slash path INSIDE `fileSpace`, as the caller browsed it. */
  filePath: string;
  fileSpace: string;
  subjectType: EntityLinkSubjectType;
  subjectId: string;
  role?: EntityLinkRoleValue;
  linkedBy?: EntityLinkOriginValue;
  confidence?: number | null;
  note?: string | null;
}

/** MANUAL <-> no confidence, non-MANUAL <-> a confidence. Matched to
 *  `EntityLink_confidence_matches_origin`. */
function resolveConfidence(
  linkedBy: EntityLinkOriginValue,
  confidence: number | null | undefined,
): number | null {
  if (linkedBy === "MANUAL") {
    if (confidence !== null && confidence !== undefined) {
      throw new Error(ENTITY_LINK_ERRORS.CONFIDENCE_MISMATCH);
    }
    return null;
  }
  if (confidence === null || confidence === undefined) {
    throw new Error(ENTITY_LINK_ERRORS.CONFIDENCE_MISMATCH);
  }
  return confidence;
}

/**
 * Create the link, or update the one that is already there.
 *
 * NOT `prisma.upsert`. Uniqueness here is five PARTIAL unique indexes (one per
 * subject column, `WHERE "<col>" IS NOT NULL`) because a compound unique over
 * five mostly-NULL columns is not a weaker constraint but no constraint at all
 * -- NULL never equals NULL, so no two rows collide. Prisma generates no
 * compound `where` for a partial index, so `upsert` cannot address it.
 *
 * updateMany-then-create-then-updateMany. The trailing update is the race arm:
 * two callers linking the same file to the same record at once both miss on
 * the first updateMany, one create wins, the loser catches P2002 -- which fires
 * only because the partial index is real -- and folds into an update.
 */
export async function linkFileToRecord(
  prisma: PrismaClient,
  input: EntityLinkInput,
  actorId: string | null,
): Promise<ApiEntityLink> {
  const linkedBy = input.linkedBy ?? "MANUAL";
  const confidence = resolveConfidence(linkedBy, input.confidence);
  await assertSubjectExists(prisma, input.subjectType, input.subjectId);

  const where = pairWhere(input.ncFileId, input.subjectType, input.subjectId);
  const mutable = {
    fileName: fileNameFromPath(input.filePath),
    filePath: input.filePath,
    fileSpace: input.fileSpace,
    role: input.role ?? "OTHER",
    linkedBy,
    confidence,
    note: input.note ?? null,
    // Re-linking an archived link is how a human un-archives it: the explicit
    // pair moves together, never derived one from the other (WARP-884).
    isArchived: false,
    archivedAt: null,
  } satisfies Prisma.EntityLinkUpdateManyMutationInput;

  const updated = await prisma.entityLink.updateMany({ where, data: mutable });
  if (updated.count > 0) {
    const row = await prisma.entityLink.findFirst({ where });
    if (!row) throw new Error(ENTITY_LINK_ERRORS.LINK_NOT_FOUND);
    return linkToApi(row);
  }

  try {
    const row = await prisma.entityLink.create({
      data: {
        ncFileId: input.ncFileId,
        subjectType: input.subjectType,
        [SUBJECT_COLUMN[input.subjectType]]: input.subjectId,
        createdById: actorId,
        ...mutable,
      } as Prisma.EntityLinkUncheckedCreateInput,
    });
    return linkToApi(row);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    await prisma.entityLink.updateMany({ where, data: mutable });
    const row = await prisma.entityLink.findFirst({ where });
    if (!row) throw new Error(ENTITY_LINK_ERRORS.LINK_NOT_FOUND);
    return linkToApi(row);
  }
}

/**
 * Drop the rows whose file the viewer cannot read.
 *
 * ONE query for the registry rows and ONE for the viewer's departments,
 * regardless of page size -- and deliberately NOT `checkSpaceAccess` per row.
 * That function AUDITS every denial (`recordAccessDenied` -> ActivityRow), and
 * a filtered listing is not a denial: emitting one warn row per hidden
 * document per page load would drown the audit trail in non-events. The
 * equivalence of the two paths is pinned in `entity-link.pg.test.ts` across the
 * role/membership matrix, so this cannot drift from the truth table it mirrors.
 */
export async function filterVisibleLinks(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  rows: LinkRow[],
): Promise<LinkRow[]> {
  if (rows.length === 0) return rows;

  const ncFileIds = [...new Set(rows.map((r) => r.ncFileId))];
  const registered = await prisma.file.findMany({
    where: { ncFileId: { in: ncFileIds } },
    select: { ncFileId: true, departmentId: true },
  });
  const deptByFile = new Map<number, string | null>(
    registered.map((f) => [f.ncFileId, f.departmentId]),
  );

  // Nothing registered to a department on this page -> nothing to check, and
  // the department query is skipped entirely.
  const needsCheck = rows.some((r) => (deptByFile.get(r.ncFileId) ?? null) !== null);
  if (!needsCheck) return rows;

  const readable = await readableDepartmentIdsFor(prisma, viewer);
  return rows.filter((r) => {
    const departmentId = deptByFile.get(r.ncFileId) ?? null;
    // Unregistered -> personal-space semantics, visible. See the header.
    return departmentId === null || readable.has(departmentId);
  });
}

export interface EntityLinkListing {
  links: ApiEntityLink[];
  /** POST-FILTER. A total that counted hidden rows would leak the existence
   *  this filter hides. */
  total: number;
  /** True when the record holds more than `LINK_LIST_CAP` links and the list
   *  is therefore incomplete. Explicit, never inferred from `total === cap`. */
  truncated: boolean;
}

export async function listLinksForSubject(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  subject: { subjectType: EntityLinkSubjectType; id: string },
  opts: { includeArchived?: boolean; role?: EntityLinkRoleValue } = {},
): Promise<EntityLinkListing> {
  const where: Prisma.EntityLinkWhereInput = {
    [SUBJECT_COLUMN[subject.subjectType]]: subject.id,
  };
  if (!opts.includeArchived) where.isArchived = false;
  if (opts.role) where.role = opts.role;

  const rows = await prisma.entityLink.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: LINK_LIST_CAP + 1,
  });
  const truncated = rows.length > LINK_LIST_CAP;
  const visible = await filterVisibleLinks(prisma, viewer, rows.slice(0, LINK_LIST_CAP));
  return { links: visible.map(linkToApi), total: visible.length, truncated };
}

/** The other direction: "which records is this file attached to". Same filter,
 *  which reads oddly until you remember a caller can name any ncFileId. */
export async function listLinksForFile(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  ncFileId: number,
  opts: { includeArchived?: boolean } = {},
): Promise<EntityLinkListing> {
  const where: Prisma.EntityLinkWhereInput = { ncFileId };
  if (!opts.includeArchived) where.isArchived = false;
  const rows = await prisma.entityLink.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: LINK_LIST_CAP + 1,
  });
  const truncated = rows.length > LINK_LIST_CAP;
  const visible = await filterVisibleLinks(prisma, viewer, rows.slice(0, LINK_LIST_CAP));
  return { links: visible.map(linkToApi), total: visible.length, truncated };
}

/**
 * Read one link, or 404. Goes through the same filter: a viewer who cannot see
 * the link in a listing must not be able to fetch it by id either, and the
 * answer is 404 rather than 403 for the reason team-chat's IDOR cases spell
 * out -- a 403 confirms the row exists.
 */
export async function getLink(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  id: string,
): Promise<ApiEntityLink> {
  const row = await prisma.entityLink.findUnique({ where: { id } });
  if (!row) throw new Error(ENTITY_LINK_ERRORS.LINK_NOT_FOUND);
  const [visible] = await filterVisibleLinks(prisma, viewer, [row]);
  if (!visible) throw new Error(ENTITY_LINK_ERRORS.LINK_NOT_FOUND);
  return linkToApi(visible);
}

export interface EntityLinkPatch {
  role?: EntityLinkRoleValue;
  note?: string | null;
  archived?: boolean;
}

/**
 * `ncFileId` and the subject are NOT patchable. Re-pointing a link is a delete
 * and a create -- allowing it in place would let the (file, record) pair change
 * under a partial unique index without ever passing the create path's file gate.
 */
export async function updateLink(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  id: string,
  patch: EntityLinkPatch,
): Promise<ApiEntityLink> {
  await getLink(prisma, viewer, id); // visibility + existence, as one 404
  const data: Prisma.EntityLinkUpdateInput = {};
  if (patch.role !== undefined) data.role = patch.role;
  if (patch.note !== undefined) data.note = patch.note;
  if (patch.archived !== undefined) {
    data.isArchived = patch.archived;
    data.archivedAt = patch.archived ? new Date() : null;
  }
  const row = await prisma.entityLink.update({ where: { id }, data });
  return linkToApi(row);
}

export async function deleteLink(
  prisma: PrismaClient,
  viewer: SpaceAccessCaller,
  id: string,
): Promise<void> {
  await getLink(prisma, viewer, id);
  await prisma.entityLink.delete({ where: { id } });
}

/**
 * WARP-3522 (ADR-069 §8) — saved views: a named, persisted filter.
 *
 * What a view IS lives in `packages/shared-types/src/pm-views.ts` (the
 * vocabulary, the five built-ins) and `pm-filter.ts` (the grammar). This file is
 * who may see and change one, and the writes.
 *
 * ── who sees what ───────────────────────────────────────────────────────────
 *
 *   built-in   — everyone, always, never a row (see shared-types).
 *   SHARED     — every Projects reader.
 *   PERSONAL   — its owner and NOBODY else. Not an admin, not the project lead:
 *                another person's personal view is not listed to them and is
 *                `view_not_found` — not `view_forbidden` — if they name its id,
 *                so a 403 cannot be used to learn that someone keeps a view
 *                called "Layoffs".
 *
 * ── who may change one ──────────────────────────────────────────────────────
 *
 *   PERSONAL   — its owner.
 *   SHARED     — owner / admin, and the LEAD of the project it belongs to. A
 *                cross-project shared view has no lead, so it is owner / admin.
 *                Everyone else sees a shared view read-only (`canEdit: false`).
 *
 * Creating a PERSONAL view is a preference, not a write to anyone's work, so any
 * role that reaches Projects at all may; the route gates the verbs on the human
 * write roles because the assistant's service principal has no `userId` to own
 * a view.
 *
 * ── limits ──────────────────────────────────────────────────────────────────
 *
 * Brief §3.9: "cap at a sensible small number (e.g. 12)". 12 personal views per
 * owner per place, 12 shared per place, where a place is one project or the
 * cross-project space. Counted and inserted in ONE SERIALIZABLE transaction, so
 * two racing saves cannot both slip under the cap.
 *
 * The stored `filter` is re-validated on every read: it is data a person or the
 * assistant typed, never trusted because it came out of our own column. One that
 * no longer validates (a future DSL change retired an op) reads as "no filter"
 * with a logged warning — the view can still be opened and corrected, which a
 * view that silently vanished could not.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  PM_BUILTIN_VIEWS,
  PM_VIEW_LIMIT,
  isPmBuiltinViewId,
  validatePmColumns,
  validatePmFilter,
  validatePmGroupBy,
  validatePmSort,
  type PmFilter,
  type PmGroupByField,
  type PmSavedViewDto,
  type PmSortSpec,
  type PmViewLayout,
  type PmViewScope,
} from "@droplet/shared-types";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { createLogger } from "../../lib/logger.js";
import { HOME_WORKSPACE_SLUG, PM_ERRORS, isPrismaCode } from "./pm.service.js";

const logger = createLogger("pm-views");

export const PM_VIEW_ERRORS = {
  /** No such view — or somebody else's PERSONAL one. 404. */
  VIEW_NOT_FOUND: "view_not_found",
  /** You can see it (it is shared) and may not change it. 403. */
  VIEW_FORBIDDEN: "view_forbidden",
  /** The five built-ins are not rows: they cannot be renamed, changed or deleted. 409. */
  VIEW_IS_BUILTIN: "view_is_builtin",
  /** Another view in the same place already has this name. 409. */
  VIEW_NAME_TAKEN: "view_name_taken",
  /** {@link PM_VIEW_LIMIT} views in this place already. 409. */
  VIEW_LIMIT_REACHED: "view_limit_reached",
} as const;

/** Who is asking. Always a person: a view needs an owner. */
export interface ViewActor {
  userId: string;
  role: string;
}

// ── permissions (pure) ──────────────────────────────────────────────────────

const ADMIN_ROLES = new Set(["owner", "admin"]);

/** May this actor create or change a SHARED view in a place whose project has
 *  `leadId` (`null` for a cross-project place or a project with no lead)? */
export function canManageSharedViews(actor: ViewActor, leadId: string | null): boolean {
  return ADMIN_ROLES.has(actor.role) || (leadId !== null && leadId === actor.userId);
}

/** May this actor rename, update or delete this view? */
export function canEditView(
  actor: ViewActor,
  view: { scope: PmViewScope; ownerId: string },
  leadId: string | null,
): boolean {
  return view.scope === "PERSONAL" ? view.ownerId === actor.userId : canManageSharedViews(actor, leadId);
}

// ── row ↔ dto ───────────────────────────────────────────────────────────────

type ViewRow = Prisma.PmSavedViewGetPayload<object>;

function readFilter(row: ViewRow): PmFilter {
  const res = validatePmFilter(row.filter);
  if (res.ok) return res.filter;
  logger.warn({ viewId: row.id, error: res.error }, "saved view has a filter that no longer validates; reading it as no filter");
  return { and: [] };
}

function readSort(raw: unknown): PmSortSpec[] | null {
  if (raw === null || raw === undefined) return null;
  const res = validatePmSort(raw);
  return res.ok ? res.sort : null;
}

function readColumns(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  const res = validatePmColumns(raw);
  return res.ok ? res.columns : null;
}

function readGroupBy(raw: string | null): PmGroupByField | null {
  if (raw === null) return null;
  const res = validatePmGroupBy(raw);
  return res.ok ? res.groupBy : null;
}

function toDto(row: ViewRow, canEdit: boolean): PmSavedViewDto {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerId: row.ownerId,
    scope: row.scope,
    name: row.name,
    layout: row.layout,
    filter: readFilter(row),
    groupBy: readGroupBy(row.groupBy),
    sortBy: readSort(row.sortBy),
    columns: readColumns(row.columns),
    sortOrder: row.sortOrder,
    canEdit,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The five built-ins, as the wire shape, in the order the chips show them. */
export function builtinViews(): PmSavedViewDto[] {
  return PM_BUILTIN_VIEWS.map((v, i) => ({
    id: v.id,
    projectId: null,
    ownerId: null,
    scope: "BUILTIN" as const,
    name: v.name,
    layout: null,
    filter: v.filter,
    groupBy: null,
    sortBy: null,
    columns: null,
    sortOrder: i,
    canEdit: false,
    createdAt: null,
    updatedAt: null,
  }));
}

/** Project leads for a set of rows, so `canEdit` costs one query, not one per view. */
async function leadsOf(prisma: PrismaClient, rows: ViewRow[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.flatMap((r) => (r.scope === "SHARED" && r.projectId ? [r.projectId] : [])))];
  if (ids.length === 0) return new Map();
  const projects = await prisma.pmProject.findMany({ where: { id: { in: ids } }, select: { id: true, leadId: true } });
  return new Map(projects.map((p) => [p.id, p.leadId]));
}

// ── reads ───────────────────────────────────────────────────────────────────

export interface ListViewsOptions {
  workspace?: string;
  /** A project id → that project's views. `"none"` → cross-project views only.
   *  Absent → every view the caller can see, in every place (the "Views" index). */
  project?: string;
}

/**
 * The built-ins, plus every saved view the caller may see: all SHARED ones and
 * their OWN personal ones. `actor` is `null` for a caller with no `userId` (the
 * assistant's service principal): shared views only.
 */
export async function listViews(
  prisma: PrismaClient,
  actor: ViewActor | null,
  opts: ListViewsOptions = {},
): Promise<{ builtin: PmSavedViewDto[]; views: PmSavedViewDto[] }> {
  const where: Prisma.PmSavedViewWhereInput = {
    workspace: { slug: opts.workspace ?? HOME_WORKSPACE_SLUG },
    OR: actor ? [{ scope: "SHARED" }, { scope: "PERSONAL", ownerId: actor.userId }] : [{ scope: "SHARED" }],
    AND: [{ OR: [{ projectId: null }, { project: { is: { kind: "PROJECT" } } }] }],
  };
  if (opts.project === "none") where.projectId = null;
  else if (opts.project !== undefined) {
    const project = await prisma.pmProject.findFirst({ where: { id: opts.project, kind: "PROJECT" }, select: { id: true } });
    if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
    where.projectId = opts.project;
  }

  const rows = await prisma.pmSavedView.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const leads = await leadsOf(prisma, rows);
  return {
    builtin: builtinViews(),
    views: rows.map((r) =>
      toDto(r, actor ? canEditView(actor, r, r.projectId ? (leads.get(r.projectId) ?? null) : null) : false),
    ),
  };
}

// ── writes ──────────────────────────────────────────────────────────────────

export interface CreateViewInput {
  workspace?: string;
  /** `null` / absent → a cross-project view. */
  projectId?: string | null;
  scope: PmViewScope;
  name: string;
  layout: PmViewLayout;
  filter: PmFilter;
  groupBy?: PmGroupByField | null;
  sortBy?: PmSortSpec[] | null;
  columns?: string[] | null;
}

export async function createView(
  prisma: PrismaClient,
  actor: ViewActor,
  input: CreateViewInput,
): Promise<PmSavedViewDto> {
  const projectId = input.projectId ?? null;
  let workspaceId: string;
  let leadId: string | null = null;
  if (projectId) {
    const project = await prisma.pmProject.findFirst({
      where: { id: projectId, kind: "PROJECT" },
      select: { workspaceId: true, leadId: true },
    });
    if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
    workspaceId = project.workspaceId;
    leadId = project.leadId;
  } else {
    const ws = await prisma.pmWorkspace.findUnique({ where: { slug: input.workspace ?? HOME_WORKSPACE_SLUG } });
    if (!ws) throw new Error(PM_ERRORS.WORKSPACE_NOT_FOUND);
    workspaceId = ws.id;
  }

  if (input.scope === "SHARED" && !canManageSharedViews(actor, leadId)) {
    throw new Error(PM_VIEW_ERRORS.VIEW_FORBIDDEN);
  }

  try {
    const row = await prisma.$transaction(async (tx) => {
      const place: Prisma.PmSavedViewWhereInput = {
        workspaceId,
        projectId,
        scope: input.scope,
        ...(input.scope === "PERSONAL" ? { ownerId: actor.userId } : {}),
      };
      const [count, last] = await Promise.all([
        tx.pmSavedView.count({ where: place }),
        tx.pmSavedView.aggregate({ where: place, _max: { sortOrder: true } }),
      ]);
      if (count >= PM_VIEW_LIMIT) throw new Error(PM_VIEW_ERRORS.VIEW_LIMIT_REACHED);
      return tx.pmSavedView.create({
        data: {
          workspaceId,
          projectId,
          ownerId: actor.userId,
          scope: input.scope,
          name: input.name,
          layout: input.layout,
          filter: input.filter as unknown as Prisma.InputJsonValue,
          groupBy: input.groupBy ?? null,
          sortBy: input.sortBy ? (input.sortBy as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          columns: input.columns ? (input.columns as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
    }, SERIALIZABLE_TX);
    return toDto(row, true);
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error(PM_VIEW_ERRORS.VIEW_NAME_TAKEN);
    throw err;
  }
}

export interface UpdateViewInput {
  name?: string;
  layout?: PmViewLayout;
  filter?: PmFilter;
  /** `null` clears; absent leaves alone. */
  groupBy?: PmGroupByField | null;
  sortBy?: PmSortSpec[] | null;
  columns?: string[] | null;
  sortOrder?: number;
}

/** Load a view the actor may at least SEE, with the lead that decides who may edit it. */
async function loadVisible(
  prisma: PrismaClient,
  actor: ViewActor,
  id: string,
): Promise<{ row: ViewRow; leadId: string | null }> {
  if (isPmBuiltinViewId(id)) throw new Error(PM_VIEW_ERRORS.VIEW_IS_BUILTIN);
  const row = await prisma.pmSavedView.findUnique({ where: { id } });
  // Somebody else's PERSONAL view does not exist, as far as the caller can tell.
  if (!row || (row.scope === "PERSONAL" && row.ownerId !== actor.userId)) {
    throw new Error(PM_VIEW_ERRORS.VIEW_NOT_FOUND);
  }
  let leadId: string | null = null;
  if (row.projectId) {
    const project = await prisma.pmProject.findFirst({ where: { id: row.projectId, kind: "PROJECT" }, select: { leadId: true } });
    if (!project) throw new Error(PM_VIEW_ERRORS.VIEW_NOT_FOUND);
    leadId = project.leadId;
  }
  return { row, leadId };
}

export async function updateView(
  prisma: PrismaClient,
  actor: ViewActor,
  id: string,
  patch: UpdateViewInput,
): Promise<PmSavedViewDto> {
  const { row, leadId } = await loadVisible(prisma, actor, id);
  if (!canEditView(actor, row, leadId)) throw new Error(PM_VIEW_ERRORS.VIEW_FORBIDDEN);

  const data: Prisma.PmSavedViewUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.layout !== undefined) data.layout = patch.layout;
  if (patch.filter !== undefined) data.filter = patch.filter as unknown as Prisma.InputJsonValue;
  // `undefined` leaves a column alone, `null` clears it. A Json column clears
  // with Prisma.DbNull, not null — and `?? undefined` here would silently turn a
  // clear into "no change" (droplet-pr-review-patterns P17).
  if (patch.groupBy !== undefined) data.groupBy = patch.groupBy;
  if (patch.sortBy !== undefined) {
    data.sortBy = patch.sortBy === null ? Prisma.DbNull : (patch.sortBy as unknown as Prisma.InputJsonValue);
  }
  if (patch.columns !== undefined) {
    data.columns = patch.columns === null ? Prisma.DbNull : (patch.columns as unknown as Prisma.InputJsonValue);
  }
  if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;

  try {
    const updated = await prisma.pmSavedView.update({ where: { id }, data });
    return toDto(updated, true);
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error(PM_VIEW_ERRORS.VIEW_NAME_TAKEN);
    // Deleted between the read above and this write.
    if (isPrismaCode(err, "P2025")) throw new Error(PM_VIEW_ERRORS.VIEW_NOT_FOUND);
    throw err;
  }
}

export async function deleteView(prisma: PrismaClient, actor: ViewActor, id: string): Promise<void> {
  const { row, leadId } = await loadVisible(prisma, actor, id);
  if (!canEditView(actor, row, leadId)) throw new Error(PM_VIEW_ERRORS.VIEW_FORBIDDEN);
  try {
    await prisma.pmSavedView.delete({ where: { id } });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_VIEW_ERRORS.VIEW_NOT_FOUND);
    throw err;
  }
}

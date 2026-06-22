/**
 * Native PM service (ADR-026) — the data layer behind /api/pm/* and, via the
 * orchestrator, behind the 9 `pm_*` MCP tools and the dashboard Projects
 * surface. Replaces the embedded Plane stack: state lives in the orchestrator's
 * own Postgres (Pm* Prisma models), not a third-party container.
 *
 * Visibility model: PM is HOUSEHOLD-SHARED, not per-user. Every authenticated
 * role can read; writes are gated by `requireRole` in the route layer. So the
 * service never filters by userId — `actorId` is recorded for attribution and
 * the activity feed, never used to scope visibility (unlike calendar/chat).
 *
 * Errors are thrown as plain `Error(message)` with stable string codes the
 * route layer maps to HTTP status (mirrors calendar.service.ts):
 *   workspace_not_found | project_not_found | state_not_found |
 *   label_not_found | work_item_not_found | comment_not_found |
 *   identifier_taken | invalid_parent
 */

import type { Prisma, PrismaClient } from "@prisma/client";

// ── Stable error codes ────────────────────────────────────────────────────────
// Shared so catch sites import the same string literals the throw sites emit;
// a rename here produces a compile error on both sides.
export const PM_ERRORS = {
  WORKSPACE_NOT_FOUND: "workspace_not_found",
  PROJECT_NOT_FOUND: "project_not_found",
  STATE_NOT_FOUND: "state_not_found",
  LABEL_NOT_FOUND: "label_not_found",
  WORK_ITEM_NOT_FOUND: "work_item_not_found",
  COMMENT_NOT_FOUND: "comment_not_found",
  IDENTIFIER_TAKEN: "identifier_taken",
  INVALID_PARENT: "invalid_parent",
} as const;

// ── Default workspace + state set ────────────────────────────────────────────

export const HOME_WORKSPACE_SLUG = "home";
const HOME_WORKSPACE_NAME = "Home";

/**
 * The kanban columns every new project starts with. `Todo` is the landing
 * state for newly created work items (isDefault). Colours are design-system
 * adjacent (indigo accent on the active column).
 */
export const DEFAULT_STATES: ReadonlyArray<{
  name: string;
  group: Prisma.PmStateCreateManyProjectInput["group"];
  color: string;
  sortOrder: number;
  isDefault: boolean;
}> = [
  { name: "Backlog", group: "backlog", color: "#94a3b8", sortOrder: 0, isDefault: false },
  { name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
  { name: "Done", group: "completed", color: "#22c55e", sortOrder: 3, isDefault: false },
  { name: "Cancelled", group: "cancelled", color: "#ef4444", sortOrder: 4, isDefault: false },
];

// ── Prisma include shapes + row types ────────────────────────────────────────

const WORK_ITEM_INCLUDE = {
  state: true,
  assignees: true,
  labels: { include: { label: true } },
  _count: { select: { comments: true, children: true } },
} satisfies Prisma.PmWorkItemInclude;

type WorkItemRow = Prisma.PmWorkItemGetPayload<{ include: typeof WORK_ITEM_INCLUDE }>;
type ProjectRow = Prisma.PmProjectGetPayload<{ include: { workspace: true } }>;
type StateRow = Prisma.PmStateGetPayload<object>;
type LabelRow = Prisma.PmLabelGetPayload<object>;
type CommentRow = Prisma.PmCommentGetPayload<object>;
type WorkspaceRow = Prisma.PmWorkspaceGetPayload<object>;

// ── API shapes (rich, camelCase) ─────────────────────────────────────────────
// The native HTTP wire shape. The tools-core handlers (P3) adapt these to the
// `pm_*` contract; the dashboard (P4) consumes them directly.

export interface ApiWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface ApiProject {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  identifier: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  leadId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiState {
  id: string;
  projectId: string;
  name: string;
  group: StateRow["group"];
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
}

export interface ApiLabel {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

export interface ApiWorkItem {
  id: string;
  projectId: string;
  sequenceId: number;
  /** Human key, e.g. INBOX-42. */
  key: string;
  name: string;
  descriptionHtml: string | null;
  stateId: string | null;
  state: ApiState | null;
  priority: WorkItemRow["priority"];
  parentId: string | null;
  cycleId: string | null;
  assignees: string[];
  labels: ApiLabel[];
  startDate: string | null;
  dueDate: string | null;
  sortOrder: number;
  completedAt: string | null;
  createdById: string | null;
  commentCount: number;
  subItemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiComment {
  id: string;
  workItemId: string;
  authorId: string | null;
  commentHtml: string;
  createdAt: string;
  updatedAt: string;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapWorkspace(row: WorkspaceRow): ApiWorkspace {
  return { id: row.id, slug: row.slug, name: row.name };
}

function mapProject(row: ProjectRow): ApiProject {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspace.slug,
    name: row.name,
    identifier: row.identifier,
    description: row.description,
    icon: row.icon,
    color: row.color,
    leadId: row.leadId,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapState(row: StateRow): ApiState {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    group: row.group,
    color: row.color,
    sortOrder: row.sortOrder,
    isDefault: row.isDefault,
  };
}

function mapLabel(row: LabelRow): ApiLabel {
  return { id: row.id, projectId: row.projectId, name: row.name, color: row.color };
}

function mapWorkItem(row: WorkItemRow, identifier: string): ApiWorkItem {
  return {
    id: row.id,
    projectId: row.projectId,
    sequenceId: row.sequenceId,
    key: `${identifier}-${row.sequenceId}`,
    name: row.name,
    descriptionHtml: row.descriptionHtml,
    stateId: row.stateId,
    state: row.state ? mapState(row.state) : null,
    priority: row.priority,
    parentId: row.parentId,
    cycleId: row.cycleId,
    assignees: row.assignees.map((a) => a.userId),
    labels: row.labels.map((l) => mapLabel(l.label)),
    startDate: row.startDate ? row.startDate.toISOString() : null,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    sortOrder: row.sortOrder,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdById: row.createdById,
    commentCount: row._count.comments,
    subItemCount: row._count.children,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapComment(row: CommentRow): ApiComment {
  return {
    id: row.id,
    workItemId: row.workItemId,
    authorId: row.authorId,
    commentHtml: row.commentHtml,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A Prisma client OR an interactive-transaction handle — service helpers that
 *  run inside `$transaction` take this so callers compose them atomically. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Derive a project key prefix from its name: up to 5 uppercase alphanumerics,
 *  falling back to "PROJ". Caller resolves collisions within the workspace. */
function deriveIdentifier(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 5);
  return base.length > 0 ? base : "PROJ";
}

async function writeActivity(
  db: Db,
  input: {
    workItemId: string;
    actorId: string | null;
    verb: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
  },
): Promise<void> {
  await db.pmActivity.create({
    data: {
      workItemId: input.workItemId,
      actorId: input.actorId ?? null,
      verb: input.verb,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
    },
  });
}

/** Re-fetch a work item with all includes and map it. Throws if it vanished
 *  (shouldn't, inside the same request) — keeps the return type non-null. */
async function loadWorkItem(db: Db, id: string, identifier: string): Promise<ApiWorkItem> {
  const row = await db.pmWorkItem.findUnique({ where: { id }, include: WORK_ITEM_INCLUDE });
  if (!row) throw new Error("work_item_not_found");
  return mapWorkItem(row, identifier);
}

// ── Workspaces ───────────────────────────────────────────────────────────────

/** Idempotently ensure the single `home` workspace exists. Returns its row. */
export async function ensureHomeWorkspace(prisma: PrismaClient): Promise<ApiWorkspace> {
  const row = await prisma.pmWorkspace.upsert({
    where: { slug: HOME_WORKSPACE_SLUG },
    create: { slug: HOME_WORKSPACE_SLUG, name: HOME_WORKSPACE_NAME },
    update: {},
  });
  return mapWorkspace(row);
}

export async function listWorkspaces(prisma: PrismaClient): Promise<ApiWorkspace[]> {
  const rows = await prisma.pmWorkspace.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(mapWorkspace);
}

export async function getWorkspaceBySlug(prisma: PrismaClient, slug: string): Promise<ApiWorkspace> {
  const row = await prisma.pmWorkspace.findUnique({ where: { slug } });
  if (!row) throw new Error("workspace_not_found");
  return mapWorkspace(row);
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(
  prisma: PrismaClient,
  opts: { workspaceSlug?: string; includeArchived?: boolean } = {},
): Promise<ApiProject[]> {
  const where: Prisma.PmProjectWhereInput = {};
  if (opts.workspaceSlug) where.workspace = { slug: opts.workspaceSlug };
  if (!opts.includeArchived) where.archivedAt = null;
  const rows = await prisma.pmProject.findMany({
    where,
    include: { workspace: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(mapProject);
}

export async function getProject(prisma: PrismaClient, projectId: string): Promise<ApiProject> {
  const row = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { workspace: true },
  });
  if (!row) throw new Error("project_not_found");
  return mapProject(row);
}

export async function createProject(
  prisma: PrismaClient,
  actorId: string | null,
  input: {
    workspaceSlug?: string;
    name: string;
    identifier?: string;
    description?: string;
    icon?: string;
    color?: string;
  },
): Promise<ApiProject> {
  const workspace = await prisma.pmWorkspace.upsert({
    where: { slug: input.workspaceSlug ?? HOME_WORKSPACE_SLUG },
    create: {
      slug: input.workspaceSlug ?? HOME_WORKSPACE_SLUG,
      name: input.workspaceSlug ? input.workspaceSlug : HOME_WORKSPACE_NAME,
    },
    update: {},
  });

  // Resolve the key prefix, suffixing on collision within the workspace.
  const base = input.identifier ? input.identifier.toUpperCase() : deriveIdentifier(input.name);
  let identifier = base;
  for (let n = 1; ; n += 1) {
    const clash = await prisma.pmProject.findUnique({
      where: { workspaceId_identifier: { workspaceId: workspace.id, identifier } },
    });
    if (!clash) break;
    if (input.identifier) throw new Error("identifier_taken");
    identifier = `${base}${n}`;
  }

  const created = await prisma.pmProject.create({
    data: {
      workspaceId: workspace.id,
      name: input.name,
      identifier,
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
      createdById: actorId,
      states: {
        create: DEFAULT_STATES.map((s) => ({
          name: s.name,
          group: s.group,
          color: s.color,
          sortOrder: s.sortOrder,
          isDefault: s.isDefault,
        })),
      },
    },
    include: { workspace: true },
  });
  return mapProject(created);
}

export async function updateProject(
  prisma: PrismaClient,
  projectId: string,
  fields: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    color?: string | null;
    leadId?: string | null;
    archived?: boolean;
  },
): Promise<ApiProject> {
  const existing = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!existing) throw new Error("project_not_found");
  const data: Prisma.PmProjectUpdateInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.icon !== undefined) data.icon = fields.icon;
  if (fields.color !== undefined) data.color = fields.color;
  if (fields.leadId !== undefined) data.leadId = fields.leadId;
  if (fields.archived !== undefined) data.archivedAt = fields.archived ? new Date() : null;
  const updated = await prisma.pmProject.update({
    where: { id: projectId },
    data,
    include: { workspace: true },
  });
  return mapProject(updated);
}

export async function deleteProject(prisma: PrismaClient, projectId: string): Promise<void> {
  const existing = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!existing) throw new Error("project_not_found");
  await prisma.pmProject.delete({ where: { id: projectId } });
}

// ── States ───────────────────────────────────────────────────────────────────

export async function listStates(prisma: PrismaClient, projectId: string): Promise<ApiState[]> {
  const rows = await prisma.pmState.findMany({
    where: { projectId },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map(mapState);
}

export async function createState(
  prisma: PrismaClient,
  projectId: string,
  input: { name: string; group: ApiState["group"]; color?: string; sortOrder?: number },
): Promise<ApiState> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project_not_found");
  const row = await prisma.pmState.create({
    data: {
      projectId,
      name: input.name,
      group: input.group,
      color: input.color ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  });
  return mapState(row);
}

export async function updateState(
  prisma: PrismaClient,
  stateId: string,
  fields: { name?: string; group?: ApiState["group"]; color?: string | null; sortOrder?: number },
): Promise<ApiState> {
  const existing = await prisma.pmState.findUnique({ where: { id: stateId } });
  if (!existing) throw new Error("state_not_found");
  const row = await prisma.pmState.update({ where: { id: stateId }, data: fields });
  return mapState(row);
}

export async function deleteState(prisma: PrismaClient, stateId: string): Promise<void> {
  const existing = await prisma.pmState.findUnique({ where: { id: stateId } });
  if (!existing) throw new Error("state_not_found");
  await prisma.pmState.delete({ where: { id: stateId } });
}

// ── Labels ───────────────────────────────────────────────────────────────────

export async function listLabels(prisma: PrismaClient, projectId: string): Promise<ApiLabel[]> {
  const rows = await prisma.pmLabel.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  return rows.map(mapLabel);
}

export async function createLabel(
  prisma: PrismaClient,
  projectId: string,
  input: { name: string; color?: string },
): Promise<ApiLabel> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project_not_found");
  const row = await prisma.pmLabel.create({
    data: { projectId, name: input.name, color: input.color ?? null },
  });
  return mapLabel(row);
}

export async function updateLabel(
  prisma: PrismaClient,
  labelId: string,
  fields: { name?: string; color?: string | null },
): Promise<ApiLabel> {
  const existing = await prisma.pmLabel.findUnique({ where: { id: labelId } });
  if (!existing) throw new Error("label_not_found");
  const row = await prisma.pmLabel.update({ where: { id: labelId }, data: fields });
  return mapLabel(row);
}

export async function deleteLabel(prisma: PrismaClient, labelId: string): Promise<void> {
  const existing = await prisma.pmLabel.findUnique({ where: { id: labelId } });
  if (!existing) throw new Error("label_not_found");
  await prisma.pmLabel.delete({ where: { id: labelId } });
}

// ── Work items ───────────────────────────────────────────────────────────────

export async function listWorkItems(
  prisma: PrismaClient,
  projectId: string,
  filters: {
    stateId?: string;
    assignee?: string;
    labelId?: string;
    priority?: ApiWorkItem["priority"];
    parentId?: string | null;
    q?: string;
    perPage?: number;
    page?: number;
  } = {},
): Promise<ApiWorkItem[]> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("project_not_found");

  const where: Prisma.PmWorkItemWhereInput = { projectId, archivedAt: null };
  if (filters.stateId) where.stateId = filters.stateId;
  if (filters.priority) where.priority = filters.priority;
  if (filters.parentId !== undefined) where.parentId = filters.parentId;
  if (filters.assignee) where.assignees = { some: { userId: filters.assignee } };
  if (filters.labelId) where.labels = { some: { labelId: filters.labelId } };
  if (filters.q && filters.q.trim().length > 0) {
    const q = filters.q.trim();
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { descriptionHtml: { contains: q, mode: "insensitive" } },
    ];
  }

  const perPage = Math.max(1, Math.min(200, filters.perPage ?? 100));
  const page = Math.max(1, filters.page ?? 1);
  const rows = await prisma.pmWorkItem.findMany({
    where,
    include: WORK_ITEM_INCLUDE,
    orderBy: [{ sortOrder: "asc" }, { sequenceId: "asc" }],
    skip: (page - 1) * perPage,
    take: perPage,
  });
  return rows.map((r) => mapWorkItem(r, project.identifier));
}

export async function getWorkItem(prisma: PrismaClient, id: string): Promise<ApiWorkItem> {
  const row = await prisma.pmWorkItem.findUnique({ where: { id }, include: WORK_ITEM_INCLUDE });
  if (!row) throw new Error("work_item_not_found");
  const project = await prisma.pmProject.findUnique({ where: { id: row.projectId } });
  return mapWorkItem(row, project?.identifier ?? "");
}

/** Workspace-wide free-text search over work-item name + description. Backs the
 *  `pm_search_work_items` MCP tool, which keys on workspace_slug (not project). */
export async function searchWorkItems(
  prisma: PrismaClient,
  opts: { workspaceSlug?: string; q: string; perPage?: number },
): Promise<ApiWorkItem[]> {
  const q = opts.q.trim();
  if (q.length === 0) return [];
  const perPage = Math.max(1, Math.min(200, opts.perPage ?? 100));
  const where: Prisma.PmWorkItemWhereInput = {
    archivedAt: null,
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { descriptionHtml: { contains: q, mode: "insensitive" } },
    ],
  };
  if (opts.workspaceSlug) where.project = { workspace: { slug: opts.workspaceSlug } };
  const rows = await prisma.pmWorkItem.findMany({
    where,
    include: { ...WORK_ITEM_INCLUDE, project: { select: { identifier: true } } },
    orderBy: { updatedAt: "desc" },
    take: perPage,
  });
  return rows.map((r) => mapWorkItem(r, r.project.identifier));
}

export async function createWorkItem(
  prisma: PrismaClient,
  actorId: string | null,
  projectId: string,
  input: {
    name: string;
    descriptionHtml?: string;
    stateId?: string;
    priority?: ApiWorkItem["priority"];
    assignees?: string[];
    labelIds?: string[];
    parentId?: string;
    startDate?: Date;
    dueDate?: Date;
  },
): Promise<ApiWorkItem> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { states: true },
  });
  if (!project) throw new Error("project_not_found");

  if (input.parentId) {
    const parent = await prisma.pmWorkItem.findFirst({
      where: { id: input.parentId, projectId },
    });
    if (!parent) throw new Error("invalid_parent");
  }

  // Landing state: explicit → isDefault → first by sortOrder → none.
  const stateId =
    input.stateId ??
    project.states.find((s) => s.isDefault)?.id ??
    [...project.states].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id ??
    null;

  const created = await prisma.$transaction(async (tx) => {
    // Bump the per-project counter atomically → the work item's number.
    const bumped = await tx.pmProject.update({
      where: { id: projectId },
      data: { seqCounter: { increment: 1 } },
      select: { seqCounter: true },
    });
    const sequenceId = bumped.seqCounter;

    const item = await tx.pmWorkItem.create({
      data: {
        projectId,
        sequenceId,
        name: input.name,
        descriptionHtml: input.descriptionHtml ?? null,
        stateId,
        priority: input.priority ?? "none",
        parentId: input.parentId ?? null,
        createdById: actorId,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        sortOrder: sequenceId,
        assignees: input.assignees?.length
          ? { create: input.assignees.map((userId) => ({ userId })) }
          : undefined,
        labels: input.labelIds?.length
          ? { create: input.labelIds.map((labelId) => ({ labelId })) }
          : undefined,
      },
    });
    await writeActivity(tx, { workItemId: item.id, actorId, verb: "created" });
    return item;
  });

  return loadWorkItem(prisma, created.id, project.identifier);
}

export async function updateWorkItem(
  prisma: PrismaClient,
  actorId: string | null,
  id: string,
  fields: {
    name?: string;
    descriptionHtml?: string | null;
    stateId?: string | null;
    priority?: ApiWorkItem["priority"];
    parentId?: string | null;
    assignees?: string[];
    labelIds?: string[];
    startDate?: Date | null;
    dueDate?: Date | null;
    sortOrder?: number;
  },
): Promise<ApiWorkItem> {
  const existing = await prisma.pmWorkItem.findUnique({
    where: { id },
    include: { assignees: true, labels: true },
  });
  if (!existing) throw new Error("work_item_not_found");
  const project = await prisma.pmProject.findUnique({ where: { id: existing.projectId } });
  if (!project) throw new Error("project_not_found");

  // When transitioning into a terminal-group state, stamp completedAt.
  let completedAt: Date | null | undefined;
  if (fields.stateId !== undefined && fields.stateId !== existing.stateId) {
    if (fields.stateId === null) {
      completedAt = null;
    } else {
      const target = await prisma.pmState.findFirst({
        where: { id: fields.stateId, projectId: existing.projectId },
      });
      if (!target) throw new Error("state_not_found");
      completedAt =
        target.group === "completed" || target.group === "cancelled" ? new Date() : null;
    }
  }

  await prisma.$transaction(async (tx) => {
    const data: Prisma.PmWorkItemUpdateInput = {};
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.descriptionHtml !== undefined) data.descriptionHtml = fields.descriptionHtml;
    if (fields.priority !== undefined) data.priority = fields.priority;
    if (fields.startDate !== undefined) data.startDate = fields.startDate;
    if (fields.dueDate !== undefined) data.dueDate = fields.dueDate;
    if (fields.sortOrder !== undefined) data.sortOrder = fields.sortOrder;
    if (fields.stateId !== undefined) {
      data.state = fields.stateId ? { connect: { id: fields.stateId } } : { disconnect: true };
      if (completedAt !== undefined) data.completedAt = completedAt;
    }
    if (fields.parentId !== undefined) {
      data.parent = fields.parentId ? { connect: { id: fields.parentId } } : { disconnect: true };
    }
    await tx.pmWorkItem.update({ where: { id }, data });

    // Assignees / labels are full-set replacements (delete-all + re-create).
    if (fields.assignees !== undefined) {
      await tx.pmWorkItemAssignee.deleteMany({ where: { workItemId: id } });
      if (fields.assignees.length) {
        await tx.pmWorkItemAssignee.createMany({
          data: fields.assignees.map((userId) => ({ workItemId: id, userId })),
        });
      }
    }
    if (fields.labelIds !== undefined) {
      await tx.pmWorkItemLabel.deleteMany({ where: { workItemId: id } });
      if (fields.labelIds.length) {
        await tx.pmWorkItemLabel.createMany({
          data: fields.labelIds.map((labelId) => ({ workItemId: id, labelId })),
        });
      }
    }

    // One activity row per meaningful change.
    if (fields.stateId !== undefined && fields.stateId !== existing.stateId) {
      await writeActivity(tx, {
        workItemId: id,
        actorId,
        verb: "state_changed",
        field: "state",
        oldValue: existing.stateId,
        newValue: fields.stateId,
      });
    }
    if (fields.priority !== undefined && fields.priority !== existing.priority) {
      await writeActivity(tx, {
        workItemId: id,
        actorId,
        verb: "updated",
        field: "priority",
        oldValue: existing.priority,
        newValue: fields.priority,
      });
    }
    const scalarChanged =
      (fields.name !== undefined && fields.name !== existing.name) ||
      fields.descriptionHtml !== undefined ||
      fields.dueDate !== undefined ||
      fields.assignees !== undefined ||
      fields.labelIds !== undefined;
    if (scalarChanged) {
      await writeActivity(tx, { workItemId: id, actorId, verb: "updated", field: "fields" });
    }
  });

  return loadWorkItem(prisma, id, project.identifier);
}

export async function transitionWorkItem(
  prisma: PrismaClient,
  actorId: string | null,
  id: string,
  stateId: string,
): Promise<ApiWorkItem> {
  return updateWorkItem(prisma, actorId, id, { stateId });
}

export async function deleteWorkItem(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.pmWorkItem.findUnique({ where: { id } });
  if (!existing) throw new Error("work_item_not_found");
  await prisma.pmWorkItem.delete({ where: { id } });
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function listComments(prisma: PrismaClient, workItemId: string): Promise<ApiComment[]> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId } });
  if (!item) throw new Error("work_item_not_found");
  const rows = await prisma.pmComment.findMany({
    where: { workItemId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapComment);
}

export async function addComment(
  prisma: PrismaClient,
  actorId: string | null,
  workItemId: string,
  commentHtml: string,
): Promise<ApiComment> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId } });
  if (!item) throw new Error("work_item_not_found");
  const row = await prisma.$transaction(async (tx) => {
    const comment = await tx.pmComment.create({
      data: { workItemId, authorId: actorId, commentHtml },
    });
    await writeActivity(tx, { workItemId, actorId, verb: "commented" });
    return comment;
  });
  return mapComment(row);
}

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
 *   identifier_taken | invalid_parent | invalid_state
 *
 * Cross-project link guards (ADR-026 P2): a work item may only reference a
 * parent/state that belongs to its own project. A referenced row that exists
 * but lives in another project throws invalid_parent / invalid_state (→ 422),
 * distinct from a row that does not exist at all (→ *_not_found, 404).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { sanitizePmHtml } from "./sanitize-html.js";

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
  INVALID_STATE: "invalid_state",
  STATE_IS_LAST: "state_is_last",
  STATE_IS_DEFAULT: "state_is_default",
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
  /** Non-terminal items (backlog + unstarted + started). Present on list. */
  openCount: number;
  /** Items in a completed state. Present on list. */
  doneCount: number;
  /** Per-state-group counts, ordered for the index sparkline. Present on list. */
  groups: Record<PmStateGroup, number>;
  createdAt: string;
  updatedAt: string;
}

export interface ApiPmSummary {
  activeProjects: number;
  itemsOpen: number;
  doneThisWeek: number;
  overdue: number;
}

type PmStateGroup = StateRow["group"];
const EMPTY_GROUPS = (): Record<PmStateGroup, number> => ({
  backlog: 0,
  unstarted: 0,
  started: 0,
  completed: 0,
  cancelled: 0,
});
const OPEN_GROUPS: PmStateGroup[] = ["backlog", "unstarted", "started"];

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
    openCount: 0,
    doneCount: 0,
    groups: EMPTY_GROUPS(),
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

/** Structural check for a Prisma known-request error code (`P2002` unique,
 *  `P2025` record-not-found, `P2003` FK violation). Matches both the real
 *  `PrismaClientKnownRequestError` and the test stand-ins the repo uses
 *  (`name === "PrismaClientKnownRequestError"` + a string `code`) — see
 *  middleware/error-handler.ts. Lets a check-then-write helper map the race a
 *  concurrent mutation opens (between the read and the write) onto the same
 *  typed string error the happy path throws, so the route layer returns the
 *  correct HTTP status instead of leaking a raw 500. */
function isPrismaCode(err: unknown, code: "P2002" | "P2025" | "P2003"): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

async function writeActivity(
  db: Db,
  input: {
    workItemId: string;
    actorId: string | null;
    // PmActivity.verb is the PmActivityVerb enum (schema), so type the helper
    // to the generated enum rather than a bare string — keeps the call sites
    // honest and satisfies the Prisma create input.
    verb: Prisma.PmActivityCreateManyInput["verb"];
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
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
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
  if (!row) throw new Error(PM_ERRORS.WORKSPACE_NOT_FOUND);
  return mapWorkspace(row);
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(
  prisma: PrismaClient,
  opts: { workspaceSlug?: string; includeArchived?: boolean; perPage?: number } = {},
): Promise<ApiProject[]> {
  const where: Prisma.PmProjectWhereInput = {};
  if (opts.workspaceSlug) where.workspace = { slug: opts.workspaceSlug };
  if (!opts.includeArchived) where.archivedAt = null;
  const take =
    opts.perPage !== undefined ? Math.max(1, Math.min(200, opts.perPage)) : undefined;
  const rows = await prisma.pmProject.findMany({
    where,
    include: { workspace: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    ...(take !== undefined ? { take } : {}),
  });
  const projects = rows.map(mapProject);

  // Attach per-project counts: one pass over the (non-archived) work items,
  // grouped by project + state group. Cheap at household scale.
  if (projects.length > 0) {
    const items = await prisma.pmWorkItem.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, archivedAt: null },
      select: { projectId: true, state: { select: { group: true } } },
    });
    const byProject = new Map<string, Record<PmStateGroup, number>>();
    for (const p of projects) byProject.set(p.id, EMPTY_GROUPS());
    for (const it of items) {
      const g = it.state?.group;
      const acc = byProject.get(it.projectId);
      if (!acc) continue;
      // Items with no state are open but uncategorised — count as unstarted so
      // they appear in openCount and the sparkline rather than vanishing silently.
      acc[g ?? "unstarted"] += 1;
    }
    for (const p of projects) {
      const g = byProject.get(p.id) ?? EMPTY_GROUPS();
      p.groups = g;
      p.openCount = OPEN_GROUPS.reduce((n, grp) => n + g[grp], 0);
      p.doneCount = g.completed;
    }
  }
  return projects;
}

/** Index KPI strip: active projects, open items, done in the last 7 days, and
 *  overdue (open items past their due date). One scan over the workspace. */
export async function getSummary(
  prisma: PrismaClient,
  workspaceSlug: string = HOME_WORKSPACE_SLUG,
): Promise<ApiPmSummary> {
  const projects = await prisma.pmProject.findMany({
    where: { workspace: { slug: workspaceSlug }, archivedAt: null },
    select: { id: true },
  });
  if (projects.length === 0) {
    return { activeProjects: 0, itemsOpen: 0, doneThisWeek: 0, overdue: 0 };
  }
  const items = await prisma.pmWorkItem.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, archivedAt: null },
    select: { dueDate: true, completedAt: true, state: { select: { group: true } } },
  });
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  let itemsOpen = 0;
  let doneThisWeek = 0;
  let overdue = 0;
  for (const it of items) {
    const g = it.state?.group;
    // Stateless items are uncategorised-but-open (mirrors listProjects bucketing
    // them as "unstarted"); count them in itemsOpen so the KPI strip isn't
    // understated, not silently dropped (finding #5).
    const open = g === undefined || g === "backlog" || g === "unstarted" || g === "started";
    if (open) {
      itemsOpen += 1;
      if (it.dueDate && it.dueDate < now) overdue += 1;
    }
    if ((g === "completed" || g === "cancelled") && it.completedAt && it.completedAt >= weekAgo) doneThisWeek += 1;
  }
  return { activeProjects: projects.length, itemsOpen, doneThisWeek, overdue };
}

export async function getProject(prisma: PrismaClient, projectId: string): Promise<ApiProject> {
  const row = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { workspace: true },
  });
  if (!row) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
    if (input.identifier) throw new Error(PM_ERRORS.IDENTIFIER_TAKEN);
    identifier = `${base}${n}`;
  }

  // The uniqueness loop above and this create are not one transaction, so two
  // concurrent creates can both pass the loop and race to insert the same
  // (workspaceId, identifier). The loser hits the unique constraint → Prisma
  // P2002; map it to the same identifier_taken (→409) the explicit-clash path
  // throws, rather than leaking a raw 500 (review finding: createProject race).
  try {
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
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error(PM_ERRORS.IDENTIFIER_TAKEN);
    throw err;
  }
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
  if (!existing) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  if (!existing) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  // findUnique + delete is two round-trips: a concurrent delete between them
  // makes this delete throw Prisma P2025. Map it to the same 404 the existence
  // check would have raised (review finding: delete-helper TOCTOU → P2025).
  try {
    await prisma.pmProject.delete({ where: { id: projectId } });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
    throw err;
  }
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
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  if (!existing) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
  const row = await prisma.pmState.update({ where: { id: stateId }, data: fields });
  return mapState(row);
}

export async function deleteState(prisma: PrismaClient, stateId: string): Promise<void> {
  const existing = await prisma.pmState.findUnique({ where: { id: stateId } });
  if (!existing) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
  // A project must always retain at least one state, and never lose its sole
  // default landing state — otherwise createWorkItem's fallback chain finds no
  // default and no states, silently setting stateId=null on every new item and
  // destroying the kanban board (review finding: deleteState last/default).
  const siblings = await prisma.pmState.count({ where: { projectId: existing.projectId } });
  if (siblings <= 1) throw new Error(PM_ERRORS.STATE_IS_LAST);
  if (existing.isDefault) {
    const otherDefaults = await prisma.pmState.count({
      where: { projectId: existing.projectId, isDefault: true, id: { not: stateId } },
    });
    if (otherDefaults === 0) throw new Error(PM_ERRORS.STATE_IS_DEFAULT);
  }
  try {
    await prisma.pmState.delete({ where: { id: stateId } });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
    throw err;
  }
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
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  if (!existing) throw new Error(PM_ERRORS.LABEL_NOT_FOUND);
  const row = await prisma.pmLabel.update({ where: { id: labelId }, data: fields });
  return mapLabel(row);
}

export async function deleteLabel(prisma: PrismaClient, labelId: string): Promise<void> {
  const existing = await prisma.pmLabel.findUnique({ where: { id: labelId } });
  if (!existing) throw new Error(PM_ERRORS.LABEL_NOT_FOUND);
  try {
    await prisma.pmLabel.delete({ where: { id: labelId } });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.LABEL_NOT_FOUND);
    throw err;
  }
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
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

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
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findUnique({ where: { id: row.projectId } });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  return mapWorkItem(row, project.identifier);
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
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  if (input.parentId) {
    const parent = await prisma.pmWorkItem.findUnique({ where: { id: input.parentId } });
    if (!parent) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    if (parent.projectId !== projectId) throw new Error(PM_ERRORS.INVALID_PARENT);
  }

  // An explicit state must belong to THIS project — mirror the parent guard so
  // a work item can never reference a state from another project (review
  // findings #4/#1). Missing id → state_not_found (404); wrong project →
  // invalid_state (422).
  if (input.stateId) {
    const state = await prisma.pmState.findUnique({ where: { id: input.stateId } });
    if (!state) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
    if (state.projectId !== projectId) throw new Error(PM_ERRORS.INVALID_STATE);
  }

  // Labels must belong to THIS project — same cross-project isolation invariant
  // as parentId and stateId.
  if (input.labelIds?.length) {
    const labels = await prisma.pmLabel.findMany({
      where: { id: { in: input.labelIds } },
      select: { id: true, projectId: true },
    });
    for (const label of labels) {
      if (label.projectId !== projectId) throw new Error("invalid_label");
    }
  }

  // Landing state: explicit → isDefault → first by sortOrder → none.
  const stateId =
    input.stateId ??
    project.states.find((s) => s.isDefault)?.id ??
    [...project.states].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id ??
    null;

  // Stamp completedAt when the resolved state is terminal (completed/cancelled).
  const resolvedStateGroup = stateId
    ? (project.states.find((s) => s.id === stateId)?.group ?? null)
    : null;
  const initialCompletedAt =
    resolvedStateGroup === "completed" || resolvedStateGroup === "cancelled"
      ? new Date()
      : null;

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
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
          // Stored HTML reaches the dashboard via dangerouslySetInnerHTML — sanitize
          // against the strict PM allowlist at the write boundary (stored-XSS guard).
          descriptionHtml: input.descriptionHtml ? sanitizePmHtml(input.descriptionHtml) : null,
          stateId,
          priority: input.priority ?? "none",
          parentId: input.parentId ?? null,
          createdById: actorId,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          sortOrder: sequenceId,
          completedAt: initialCompletedAt,
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
  } catch (err) {
    // The parent existence check above runs before this transaction; if the
    // parent (or a referenced state/label) is deleted in the window between the
    // check and the insert, the FK constraint fails → Prisma P2003. Surface it
    // as invalid_parent (→422) rather than a raw 500 (review finding: parent FK
    // race → P2003).
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ERRORS.INVALID_PARENT);
    throw err;
  }

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
  if (!existing) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findUnique({ where: { id: existing.projectId } });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  // When transitioning into a terminal-group state, stamp completedAt.
  let completedAt: Date | null | undefined;
  if (fields.stateId !== undefined && fields.stateId !== existing.stateId) {
    if (fields.stateId === null) {
      completedAt = null;
    } else {
      // The target state must belong to THIS work item's project. Distinguish
      // "no such state" (404) from "state belongs to another project" (422) so
      // the cross-project guard mirrors the parent check's shape (findings
      // #4/#2) rather than masking it as a generic not-found.
      const target = await prisma.pmState.findUnique({ where: { id: fields.stateId } });
      if (!target) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
      if (target.projectId !== existing.projectId) throw new Error(PM_ERRORS.INVALID_STATE);
      completedAt =
        target.group === "completed" || target.group === "cancelled" ? new Date() : null;
    }
  }

  // A connected parent must live in the same project — mirror createWorkItem's
  // guard so re-parenting can't cross a project boundary (findings #3/#1).
  // Self-referential parent creates an infinite cycle; reject it explicitly.
  if (fields.parentId !== undefined && fields.parentId !== null) {
    if (fields.parentId === id) throw new Error(PM_ERRORS.INVALID_PARENT);
    const parent = await prisma.pmWorkItem.findUnique({ where: { id: fields.parentId } });
    if (!parent) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    if (parent.projectId !== existing.projectId) throw new Error(PM_ERRORS.INVALID_PARENT);
  }

  // Labels must belong to THIS project before the transaction mutates them.
  if (fields.labelIds?.length) {
    const labels = await prisma.pmLabel.findMany({
      where: { id: { in: fields.labelIds } },
      select: { id: true, projectId: true },
    });
    for (const label of labels) {
      if (label.projectId !== existing.projectId) throw new Error("invalid_label");
    }
  }

  await prisma.$transaction(async (tx) => {
    const data: Prisma.PmWorkItemUpdateInput = {};
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.descriptionHtml !== undefined) {
      // null clears the description; a string is sanitized at the write boundary
      // (stored-XSS guard) before it can reach dangerouslySetInnerHTML.
      data.descriptionHtml = fields.descriptionHtml ? sanitizePmHtml(fields.descriptionHtml) : null;
    }
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
    // Compare a supplied set field against the existing set, order-independent,
    // so an identity PATCH (re-sending the same assignees/labels — common when
    // the dashboard or an agent submits the full work item on every save) does
    // not write a spurious `updated` activity row (review finding: scalarChanged
    // fires on assignees/labelIds presence alone).
    const setChanged = (next: string[] | undefined, current: string[]): boolean => {
      if (next === undefined) return false;
      if (next.length !== current.length) return true;
      const have = new Set(current);
      return next.some((v) => !have.has(v));
    };
    const existingAssignees = existing.assignees.map((a) => a.userId);
    const existingLabelIds = existing.labels.map((l) => l.labelId);
    const scalarChanged =
      (fields.name !== undefined && fields.name !== existing.name) ||
      (fields.descriptionHtml !== undefined && fields.descriptionHtml !== existing.descriptionHtml) ||
      (fields.dueDate !== undefined &&
        fields.dueDate?.toISOString() !== existing.dueDate?.toISOString()) ||
      (fields.startDate !== undefined &&
        fields.startDate?.toISOString() !== existing.startDate?.toISOString()) ||
      setChanged(fields.assignees, existingAssignees) ||
      setChanged(fields.labelIds, existingLabelIds);
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
  if (!existing) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  try {
    await prisma.pmWorkItem.delete({ where: { id } });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }
}

// ── Comments ─────────────────────────────────────────────────────────────────

export async function listComments(prisma: PrismaClient, workItemId: string): Promise<ApiComment[]> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId } });
  if (!item) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
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
  if (!item) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  // Comment HTML is rendered via dangerouslySetInnerHTML in the drawer — sanitize
  // against the strict PM allowlist at the write boundary (stored-XSS guard).
  const safeHtml = sanitizePmHtml(commentHtml);
  const row = await prisma.$transaction(async (tx) => {
    const comment = await tx.pmComment.create({
      data: { workItemId, authorId: actorId, commentHtml: safeHtml },
    });
    await writeActivity(tx, { workItemId, actorId, verb: "commented" });
    return comment;
  });
  return mapComment(row);
}

// ── Activity feed ────────────────────────────────────────────────────────────

export interface ApiActivity {
  id: string;
  workItemId: string;
  actorId: string | null;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

/** Append-only activity for a work item, oldest to newest (timeline order). */
export async function listActivity(
  prisma: PrismaClient,
  workItemId: string,
): Promise<ApiActivity[]> {
  const item = await prisma.pmWorkItem.findUnique({ where: { id: workItemId } });
  if (!item) throw new Error("work_item_not_found");
  const rows = await prisma.pmActivity.findMany({
    where: { workItemId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    workItemId: r.workItemId,
    actorId: r.actorId,
    verb: r.verb,
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    createdAt: r.createdAt.toISOString(),
  }));
}

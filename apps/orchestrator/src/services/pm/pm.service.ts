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
import {
  DEPARTMENT_SELECT,
  PM_DEPARTMENT_ERRORS,
  assertAssignableDepartment,
  departmentWorkItemWhere,
  expandDepartmentScope,
  resolveDepartmentRef,
  type DepartmentRefRow,
  type PmDepartmentRef,
} from "./pm-department.js";

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
  // ADR-045 §5.3 — the department dimension's codes live beside its rules in
  // pm-department.ts and are folded in here so `mapServiceError` keeps ONE
  // vocabulary to switch on.
  ...PM_DEPARTMENT_ERRORS,
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
  // ADR-045 §5.3 — the item's OWN department, which overrides its project's.
  // The project's half is NOT joined per row: every caller already holds the
  // project (listWorkItems / getWorkItem / createWorkItem / updateWorkItem all
  // fetch it), so it is passed to `mapWorkItem` instead of costing a join per
  // card. `searchWorkItems` is the one cross-project reader and adds the join
  // itself.
  department: { select: DEPARTMENT_SELECT },
  _count: { select: { comments: true, children: true } },
} satisfies Prisma.PmWorkItemInclude;

const PROJECT_INCLUDE = {
  workspace: true,
  department: { select: DEPARTMENT_SELECT },
} satisfies Prisma.PmProjectInclude;

type WorkItemRow = Prisma.PmWorkItemGetPayload<{ include: typeof WORK_ITEM_INCLUDE }>;
type ProjectRow = Prisma.PmProjectGetPayload<{ include: typeof PROJECT_INCLUDE }>;
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
  /** ADR-045 §5.3 — the department that owns this project's work, or null.
   *  `source` is always `"project"` here; the field is shaped identically to a
   *  work item's so one dashboard component renders both. */
  department: PmDepartmentRef | null;
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
  /** ADR-045 §5.3 — the department that owns this item, ALREADY RESOLVED: the
   *  item's own overriding its project's, `source` saying which. Null when
   *  neither level owns it. Deliberately carries no provisioning field — see
   *  `pm-department.ts` `DEPARTMENT_SELECT`. */
  department: PmDepartmentRef | null;
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
    department: resolveDepartmentRef(null, row.department),
    archived: row.isArchived,
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

function mapWorkItem(
  row: WorkItemRow,
  identifier: string,
  // ADR-045 §5.3 — the OWNING PROJECT's department, so the override can be
  // resolved without joining the project onto every row. Nullable/optional
  // because the DB-less route suite's Prisma fake does not resolve includes it
  // was never taught.
  projectDepartment?: DepartmentRefRow | null,
): ApiWorkItem {
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
    department: resolveDepartmentRef(row.department, projectDepartment),
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
async function loadWorkItem(
  db: Db,
  id: string,
  identifier: string,
  projectDepartment?: DepartmentRefRow | null,
): Promise<ApiWorkItem> {
  const row = await db.pmWorkItem.findUnique({ where: { id }, include: WORK_ITEM_INCLUDE });
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  return mapWorkItem(row, identifier, projectDepartment);
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
  if (!opts.includeArchived) where.isArchived = false;
  const take =
    opts.perPage !== undefined ? Math.max(1, Math.min(200, opts.perPage)) : undefined;
  const rows = await prisma.pmProject.findMany({
    where,
    include: PROJECT_INCLUDE,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    ...(take !== undefined ? { take } : {}),
  });
  const projects = rows.map(mapProject);

  // Attach per-project counts: one pass over the (non-archived) work items,
  // grouped by project + state group. Cheap at household scale.
  if (projects.length > 0) {
    const items = await prisma.pmWorkItem.findMany({
      where: { projectId: { in: projects.map((p) => p.id) }, isArchived: false },
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
    where: { workspace: { slug: workspaceSlug }, isArchived: false },
    select: { id: true },
  });
  if (projects.length === 0) {
    return { activeProjects: 0, itemsOpen: 0, doneThisWeek: 0, overdue: 0 };
  }
  const items = await prisma.pmWorkItem.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, isArchived: false },
    select: {
      dueDate: true,
      completedAt: true,
      isCompleted: true,
      state: { select: { group: true } },
    },
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
    // WARP-884: `isCompleted` is the canonical completion signal — no longer
    // re-derived from `state.group` combined with a `completedAt` truthy
    // check (the exact dual-signal split-brain this ticket closes).
    if (it.isCompleted && it.completedAt && it.completedAt >= weekAgo) doneThisWeek += 1;
  }
  return { activeProjects: projects.length, itemsOpen, doneThisWeek, overdue };
}

export async function getProject(prisma: PrismaClient, projectId: string): Promise<ApiProject> {
  const row = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: PROJECT_INCLUDE,
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
    /** ADR-045 §5.3 — the department that will own this project's work. */
    departmentId?: string;
  },
): Promise<ApiProject> {
  // ADR-045 §5.3 — refuse HOUSEHOLD and archive-intent departments, but NOT a
  // department that is merely pending / provisioning / failed: storage
  // convergence is not a precondition for owning work.
  if (input.departmentId) await assertAssignableDepartment(prisma, input.departmentId);

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
        departmentId: input.departmentId ?? null,
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
      include: PROJECT_INCLUDE,
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
    /** ADR-045 §5.3 — `undefined` leaves it alone, `null` clears it. */
    departmentId?: string | null;
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
  // ADR-045 §5.3. Clearing is deliberately unguarded: a department whose
  // archive is what prompted the un-routing must not be the thing that blocks
  // it. Note also what is NOT here — no `kickReconcile()` and no `aclVersion`
  // bump. Owning a ticket grants no file access, so neither the reconciler nor
  // the file-search cache has anything to learn from this write.
  if (fields.departmentId !== undefined) {
    if (fields.departmentId !== null) {
      await assertAssignableDepartment(prisma, fields.departmentId);
    }
    // connect/disconnect, not a raw `departmentId` scalar: this update goes
    // through Prisma's CHECKED `PmProjectUpdateInput`, which exposes relations
    // rather than their foreign keys. Same idiom `state` and `parent` already
    // use below — reaching for the Unchecked variant instead would work and
    // would be the one place in this function that does.
    data.department = fields.departmentId
      ? { connect: { id: fields.departmentId } }
      : { disconnect: true };
  }
  if (fields.archived !== undefined) {
    // isArchived is the canonical signal (WARP-884); archivedAt stays the
    // audit timestamp, written/cleared alongside it so the two never diverge.
    data.isArchived = fields.archived;
    data.archivedAt = fields.archived ? new Date() : null;
  }
  const updated = await prisma.pmProject.update({
    where: { id: projectId },
    data,
    include: PROJECT_INCLUDE,
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

/** True for the two terminal PmStateGroup values — the shared predicate
 *  updateState/deleteState use to detect a terminal↔non-terminal flip. */
function isTerminalGroup(group: ApiState["group"]): boolean {
  return group === "completed" || group === "cancelled";
}

export async function updateState(
  prisma: PrismaClient,
  stateId: string,
  fields: { name?: string; group?: ApiState["group"]; color?: string | null; sortOrder?: number },
): Promise<ApiState> {
  const existing = await prisma.pmState.findUnique({ where: { id: stateId } });
  if (!existing) throw new Error(PM_ERRORS.STATE_NOT_FOUND);

  const groupChanged = fields.group !== undefined && fields.group !== existing.group;
  const wasTerminal = isTerminalGroup(existing.group);
  const willBeTerminal = isTerminalGroup(fields.group ?? existing.group);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.pmState.update({ where: { id: stateId }, data: fields });
    // WARP-884: a state's group is the canonical "is this column terminal"
    // signal. When it flips terminal <-> non-terminal, every work item
    // currently sitting in this state must have its completion signal
    // re-synced — otherwise an item shows group="started" (via its live
    // state) yet isCompleted/completedAt still says "done" (or vice versa):
    // the exact split-brain this ticket closes. Scoped to the items whose
    // isCompleted disagrees with the new terminal-ness so a no-op cascade
    // (e.g. completed -> cancelled, both terminal) touches no rows.
    if (groupChanged && wasTerminal !== willBeTerminal) {
      await tx.pmWorkItem.updateMany({
        where: { stateId, isCompleted: !willBeTerminal },
        data: { isCompleted: willBeTerminal, completedAt: willBeTerminal ? new Date() : null },
      });
    }
    return updated;
  });
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
    await prisma.$transaction(async (tx) => {
      // WARP-885: `stateId ON DELETE SET NULL` would otherwise strand every
      // item parked in this state in a NULL-state limbo with no kanban column
      // to land in. Reassign them to the project's default landing state
      // first (the same fallback createWorkItem uses) so deleting a state
      // never orphans work — and re-sync the completion signal (WARP-884) in
      // case the deleted state's terminal-ness differs from the default's, so
      // the reassignment itself can't introduce a split-brain.
      const fallback = await tx.pmState.findFirst({
        where: { projectId: existing.projectId, isDefault: true, id: { not: stateId } },
      });
      if (fallback) {
        const wasTerminal = isTerminalGroup(existing.group);
        const willBeTerminal = isTerminalGroup(fallback.group);
        await tx.pmWorkItem.updateMany({
          where: { stateId },
          data: {
            stateId: fallback.id,
            ...(wasTerminal !== willBeTerminal
              ? { isCompleted: willBeTerminal, completedAt: willBeTerminal ? new Date() : null }
              : {}),
          },
        });
      }
      await tx.pmState.delete({ where: { id: stateId } });
    });
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Normalise a state name/slug for slug-tolerant comparison — lower-cased with
 *  any run of spaces/underscores/hyphens collapsed to one underscore, so
 *  "In Progress", "in progress" and "in_progress" all compare equal. */
function slugifyStateName(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

/**
 * WARP-888 (ADR-026): `?state=` accepts EITHER the native `PmState` UUID
 * (current dashboard contract) OR the legacy Plane state name/slug (e.g.
 * `in_progress`) that older mobile clients may still send — which otherwise
 * changed semantics silently and returned an empty list. A UUID passes straight
 * through (no DB hit — the common path is unaffected); a non-UUID is resolved
 * against the project's `PmState.name` (exact / case-insensitive / slugified);
 * a value that resolves to nothing is passed through unchanged (empty result,
 * exactly as before) rather than erroring.
 */
async function resolveStateFilter(
  prisma: PrismaClient,
  projectId: string,
  state: string,
): Promise<string> {
  if (UUID_RE.test(state)) return state;
  const wanted = slugifyStateName(state);
  const states = await prisma.pmState.findMany({
    where: { projectId },
    select: { id: true, name: true },
  });
  const match = states.find((s) => slugifyStateName(s.name) === wanted);
  return match?.id ?? state;
}

export async function listWorkItems(
  prisma: PrismaClient,
  projectId: string,
  filters: {
    stateId?: string;
    assignee?: string;
    labelId?: string;
    priority?: ApiWorkItem["priority"];
    parentId?: string | null;
    /** ADR-045 §5.3 — an id filters to that department AND its teams; `null`
     *  filters to work no department owns; `undefined` applies no filter.
     *  Mirrors `parentId`'s explicit three-way encoding directly above. */
    departmentId?: string | null;
    q?: string;
    perPage?: number;
    page?: number;
  } = {},
): Promise<ApiWorkItem[]> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  const where: Prisma.PmWorkItemWhereInput = { projectId, isArchived: false };
  if (filters.stateId)
    where.stateId = await resolveStateFilter(prisma, projectId, filters.stateId);
  if (filters.priority) where.priority = filters.priority;
  if (filters.parentId !== undefined) where.parentId = filters.parentId;
  if (filters.assignee) where.assignees = { some: { userId: filters.assignee } };
  if (filters.labelId) where.labels = { some: { labelId: filters.labelId } };
  // ADR-045 §5.3. `where.AND`, NOT `where.OR`: the `?q=` filter below assigns
  // `where.OR` directly, so putting this there would replace it and turn
  // "items in Clinical matching 'sterilise'" into "items in Clinical". Prisma
  // ANDs the two keys together, which is exactly the intent.
  if (filters.departmentId !== undefined) {
    const scope =
      filters.departmentId === null
        ? null
        : await expandDepartmentScope(prisma, filters.departmentId);
    where.AND = [departmentWorkItemWhere(scope)];
  }
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
  return rows.map((r) => mapWorkItem(r, project.identifier, project.department));
}

export async function getWorkItem(prisma: PrismaClient, id: string): Promise<ApiWorkItem> {
  const row = await prisma.pmWorkItem.findUnique({ where: { id }, include: WORK_ITEM_INCLUDE });
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findUnique({
    where: { id: row.projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  return mapWorkItem(row, project.identifier, project.department);
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
    isArchived: false,
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { descriptionHtml: { contains: q, mode: "insensitive" } },
    ],
  };
  if (opts.workspaceSlug) where.project = { workspace: { slug: opts.workspaceSlug } };
  const rows = await prisma.pmWorkItem.findMany({
    where,
    // ADR-045 §5.3 — this is the only reader whose rows span projects, so it
    // joins the project per row. The whole include is respelled rather than
    // spread-and-overridden: `{ ...WORK_ITEM_INCLUDE, project: ... }` would be
    // fine today but a later `project` key inside WORK_ITEM_INCLUDE would be
    // silently clobbered by the later spread member.
    include: {
      ...WORK_ITEM_INCLUDE,
      project: {
        select: { identifier: true, department: { select: DEPARTMENT_SELECT } },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: perPage,
  });
  return rows.map((r) => mapWorkItem(r, r.project.identifier, r.project.department));
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
    /** ADR-045 §5.3 — overrides the project's department for this item. */
    departmentId?: string;
    startDate?: Date;
    dueDate?: Date;
  },
): Promise<ApiWorkItem> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { states: true, department: { select: DEPARTMENT_SELECT } },
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

  // ADR-045 §5.3 — same shape as the guards above: refuse before the write, not
  // after. Refuses HOUSEHOLD (it is the unit everyone is already in, so routing
  // to it is indistinguishable from routing nothing) and archive-intent states.
  // Does NOT refuse pending / provisioning / failed.
  if (input.departmentId) await assertAssignableDepartment(prisma, input.departmentId);

  // Landing state: explicit → isDefault → first by sortOrder → none.
  const stateId =
    input.stateId ??
    project.states.find((s) => s.isDefault)?.id ??
    [...project.states].sort((a, b) => a.sortOrder - b.sortOrder)[0]?.id ??
    null;

  // Stamp completedAt/isCompleted when the resolved state is terminal
  // (completed/cancelled). isCompleted is the canonical signal (WARP-884);
  // completedAt is written alongside it as the audit timestamp.
  const resolvedStateGroup = stateId
    ? (project.states.find((s) => s.id === stateId)?.group ?? null)
    : null;
  const initialIsCompleted =
    resolvedStateGroup === "completed" || resolvedStateGroup === "cancelled";
  const initialCompletedAt = initialIsCompleted ? new Date() : null;

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
          departmentId: input.departmentId ?? null,
          createdById: actorId,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          sortOrder: sequenceId,
          isCompleted: initialIsCompleted,
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

  return loadWorkItem(prisma, created.id, project.identifier, project.department);
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
    /** ADR-045 §5.3 — `undefined` leaves it alone; `null` clears the override
     *  so the item inherits its project's department again (which may itself
     *  be none). */
    departmentId?: string | null;
    sortOrder?: number;
  },
): Promise<ApiWorkItem> {
  const existing = await prisma.pmWorkItem.findUnique({
    where: { id },
    include: { assignees: true, labels: true },
  });
  if (!existing) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findUnique({
    where: { id: existing.projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  // When transitioning into/out of a terminal-group state, sync
  // isCompleted/completedAt. isCompleted is the canonical signal (WARP-884);
  // completedAt is written alongside it as the audit timestamp.
  let completedAt: Date | null | undefined;
  let isCompleted: boolean | undefined;
  if (fields.stateId !== undefined && fields.stateId !== existing.stateId) {
    if (fields.stateId === null) {
      completedAt = null;
      isCompleted = false;
    } else {
      // The target state must belong to THIS work item's project. Distinguish
      // "no such state" (404) from "state belongs to another project" (422) so
      // the cross-project guard mirrors the parent check's shape (findings
      // #4/#2) rather than masking it as a generic not-found.
      const target = await prisma.pmState.findUnique({ where: { id: fields.stateId } });
      if (!target) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
      if (target.projectId !== existing.projectId) throw new Error(PM_ERRORS.INVALID_STATE);
      isCompleted = target.group === "completed" || target.group === "cancelled";
      completedAt = isCompleted ? new Date() : null;
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

  // ADR-045 §5.3 — guard before the transaction, like every check above.
  // Clearing (null) is deliberately unguarded so an item can always be routed
  // back out of a department that has since been archived.
  if (fields.departmentId !== undefined && fields.departmentId !== null) {
    await assertAssignableDepartment(prisma, fields.departmentId);
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
    // connect/disconnect for the same reason as `state` and `parent` below —
    // the checked UpdateInput exposes the relation, not its foreign key.
    if (fields.departmentId !== undefined) {
      data.department = fields.departmentId
        ? { connect: { id: fields.departmentId } }
        : { disconnect: true };
    }
    if (fields.stateId !== undefined) {
      data.state = fields.stateId ? { connect: { id: fields.stateId } } : { disconnect: true };
      if (completedAt !== undefined) data.completedAt = completedAt;
      if (isCompleted !== undefined) data.isCompleted = isCompleted;
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
    // ADR-045 §5.3 — re-routing work is a decision someone made about who owns
    // it, so it gets its OWN row rather than disappearing into the generic
    // `fields` entry below. `PmActivityVerb` has no `department_changed`
    // member; adding one would be a migration for no gain, so this reuses
    // `updated` with an explicit `field`, exactly as `priority` does.
    if (
      fields.departmentId !== undefined &&
      fields.departmentId !== existing.departmentId
    ) {
      await writeActivity(tx, {
        workItemId: id,
        actorId,
        verb: "updated",
        field: "department",
        oldValue: existing.departmentId,
        newValue: fields.departmentId,
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

  return loadWorkItem(prisma, id, project.identifier, project.department);
}

export async function transitionWorkItem(
  prisma: PrismaClient,
  actorId: string | null,
  id: string,
  stateId: string,
): Promise<ApiWorkItem> {
  return updateWorkItem(prisma, actorId, id, { stateId });
}

export async function deleteWorkItem(
  prisma: PrismaClient,
  actorId: string | null,
  id: string,
): Promise<void> {
  const existing = await prisma.pmWorkItem.findUnique({ where: { id } });
  if (!existing) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  try {
    await prisma.$transaction(async (tx) => {
      // WARP-885: `parentId ON DELETE SET NULL` would otherwise silently
      // promote every sub-issue to a root item with zero audit trail the
      // instant the parent is deleted. Emit one parent_removed activity row
      // per orphaned child BEFORE the delete, so the DB cascade is always
      // preceded by an explainable entry in the child's own history feed.
      const children = await tx.pmWorkItem.findMany({
        where: { parentId: id },
        select: { id: true },
      });
      for (const child of children) {
        await writeActivity(tx, {
          workItemId: child.id,
          actorId,
          verb: "parent_removed",
          field: "parentId",
          oldValue: id,
          newValue: null,
        });
      }
      await tx.pmWorkItem.delete({ where: { id } });
    });
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

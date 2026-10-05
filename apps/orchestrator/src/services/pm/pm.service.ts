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
import { READ_COMMITTED_TX, SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { sanitizePmHtml } from "./sanitize-html.js";
import { PM_PLANNING_ERRORS, lockAttachableCycle } from "./pm-planning.js";
import { nudgeOutbox } from "./pm-outbox.js";
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
import { dateToDateOnly, parseDateInput, todayDateOnly } from "./pm-dates.js";
import {
  INVALID_CURSOR,
  ORDER_ACTIVITY,
  ORDER_ASSIGNED,
  ORDER_BOARD,
  ORDER_COMMENTS,
  ORDER_SEARCH,
  clampLimit,
  decodeCursor,
  encodeCursor,
  keysetAfter,
  sliceToPage,
  type Page,
} from "./pm-paging.js";

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
  /** ADR-048 — a project filed under a customer that does not exist. */
  COMPANY_NOT_FOUND: "company_not_found",
  INVALID_PARENT: "invalid_parent",
  INVALID_STATE: "invalid_state",
  STATE_IS_LAST: "state_is_last",
  STATE_IS_DEFAULT: "state_is_default",
  /** SERIALIZABLE loser -- nothing was applied, the route answers 409, retry. */
  CONCURRENT_MUTATION: "concurrent_mutation",
  /** WARP-3365 -- an external guest cannot lead a project (Romain, 2026-09-30).
   *  A guest is admitted to the ONE work item assigned to them, never to a
   *  project, so "project lead" names a role they cannot hold. */
  LEAD_IS_GUEST: "lead_is_guest",
  /** WARP-3371 — a `cursor` this list did not mint. The route answers 400. */
  INVALID_CURSOR,
  /** WARP-3370 — hard delete is for an ARCHIVED project only. The route answers 409. */
  PROJECT_NOT_ARCHIVED: "project_not_archived",
  /** WARP-3370 — the identifier typed to confirm a hard delete is not the project's. 422. */
  IDENTIFIER_MISMATCH: "identifier_mismatch",
  /** WARP-3371 — a re-parent that would make an item its own ancestor. 422. */
  PARENT_CYCLE: "parent_cycle",
  /** WARP-3371 — a work item keeps a state; PATCH state_id:null is refused. 422. */
  STATE_REQUIRED: "state_required",
  /** WARP-3371 — a label id that is unknown or belongs to another project. 422, with the ids. */
  INVALID_LABEL: "invalid_label",
  /** WARP-3371 — an assignee id that is not an active person. 422, with the ids. */
  INVALID_ASSIGNEE: "invalid_assignee",
  // ADR-045 §5.3 — the department dimension's codes live beside its rules in
  // pm-department.ts and are folded in here so `mapServiceError` keeps ONE
  // vocabulary to switch on.
  ...PM_DEPARTMENT_ERRORS,
  // WARP-3521 — cycles and modules. Same arrangement: the codes live in the
  // leaf both the cycle/module services and this file import, and are folded in
  // here. `cycle_not_found` / `invalid_cycle` / `cycle_completed` are the ones
  // createWorkItem / updateWorkItem can throw (planning an item into a cycle).
  ...PM_PLANNING_ERRORS,
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

export const WORK_ITEM_INCLUDE = {
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
  /** ADR-048 (WARP-2729) — the customer this project is filed under, or null.
   *  Exposed as the bare id (like `leadId`) so a `company_id` write is
   *  confirmable through GET/list; without it the writer is unobservable. */
  companyId: string | null;
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
  /** Open items with nobody assigned (ADR-044 follow-up, WARP-3524). */
  unassigned: number;
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
  /** WARP-3372 — a CALENDAR DATE, `YYYY-MM-DD`, never an instant (pm-dates.ts). */
  startDate: string | null;
  /** WARP-3372 — a CALENDAR DATE, `YYYY-MM-DD`, never an instant (pm-dates.ts). */
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
    companyId: row.companyId,
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

export function mapWorkItem(
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
    startDate: row.startDate ? dateToDateOnly(row.startDate) : null,
    dueDate: row.dueDate ? dateToDateOnly(row.dueDate) : null,
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
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * WARP-3528 (ADR-069 §1) — a SERVICE_DESK project, and everything under it
 * (states, labels, items, comments, activity, relations, assignments), belongs
 * to /api/support. Every PM reader answers for such a row exactly as it does for
 * one that does not exist -- same error, same status -- so the `pm` grant is
 * never a way into a customer conversation.
 *
 * Takes the row a lookup already fetched, so the lookup MUST carry `kind`: the
 * parameter type is the compiler's proof it does (a check on a field the query
 * did not select would read `undefined` and fail open). The column is NOT NULL,
 * so only PROJECT and SERVICE_DESK occur.
 */
export function isServiceDesk(row: { kind: ProjectRow["kind"] } | null | undefined): boolean {
  return row?.kind === "SERVICE_DESK";
}

/** Derive a project key prefix from its name: up to 5 uppercase alphanumerics,
 *  falling back to "PROJ". Caller resolves collisions within the workspace. */
export function deriveIdentifier(name: string): string {
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
/** Shared with pm-relations.service.ts -- one Prisma-code predicate, not two copies. */
/**
 * ADR-048 — is this P2003 the *company* foreign key?
 *
 * `PmProject` carries three FKs a caller can set (company, department, lead), so
 * mapping any P2003 to `company_not_found` would mislabel a department race as a
 * customer problem. Prisma names the constraint in `meta.field_name`
 * (e.g. `PmProject_companyId_fkey`), so match on that and let anything else
 * surface unchanged.
 */
function isCompanyFkViolation(err: unknown): boolean {
  if (!isPrismaCode(err, "P2003")) return false;
  const field = (err as { meta?: { field_name?: unknown } }).meta?.field_name;
  return typeof field === "string" && field.toLowerCase().includes("company");
}

export function isPrismaCode(
  err: unknown,
  code: "P2002" | "P2025" | "P2003" | "P2034",
): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/** The one place a PM activity row is written. Exported (WARP-3526) so a sibling
 *  service writes its rows through it instead of re-spelling the insert. */
export async function writeActivity(
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
    nudge?: boolean;
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
  // ADR-069 §7 — wake the outbox consumers. Runs inside the caller's
  // transaction, which is fine: the wake-up is deferred past the settle window,
  // and the consumers' interval is what guarantees the row is read.
  if (input.nudge !== false) nudgeOutbox();
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

// ── Reference validation (WARP-3371) ─────────────────────────────────────────

/** A reference id the caller sent that points at nothing usable. `ids` names
 *  every offender, so the 422 can say WHICH ones, not just that one was wrong. */
export class PmRefError extends Error {
  constructor(
    message: string,
    readonly ids: string[],
  ) {
    super(message);
    this.name = "PmRefError";
  }
}

const uniq = (ids: readonly string[]): string[] => [...new Set(ids)];

/** The roles a person on this box can hold and still be named on, or assigned,
 *  PM work — everyone but the machines. `listPeople` and assignee validation
 *  share it: who can be shown is who can be assigned. */
const PM_PERSON_ROLES = ["owner", "admin", "family", "guest"] as const;

/**
 * Every label id must EXIST and belong to THIS project. An unknown id used to
 * pass this check (only the ids that came back were inspected), reach the
 * insert, trip the foreign key and surface as `invalid_parent` or a 500. Scoping
 * the lookup to the project makes "unknown" and "another project's" the same
 * answer — missing — and every offender is named. Duplicates are folded: the
 * join table is unique per (item, label) and a repeated id would be a P2002.
 */
async function assertLabelsInProject(
  db: Db,
  projectId: string,
  labelIds: readonly string[],
): Promise<string[]> {
  const wanted = uniq(labelIds);
  if (wanted.length === 0) return wanted;
  const found = await db.pmLabel.findMany({
    where: { id: { in: wanted }, projectId },
    select: { id: true },
  });
  const have = new Set(found.map((l) => l.id));
  const missing = wanted.filter((id) => !have.has(id));
  if (missing.length > 0) throw new PmRefError(PM_ERRORS.INVALID_LABEL, missing);
  return wanted;
}

/**
 * Every assignee id must be a person who exists and is ACTIVE (never a service
 * principal, never someone deactivated). Assignee ids are plain strings, not a
 * foreign key, so nothing else would notice `"Bob"` or a leaver's id: the item
 * would carry it and the board would render "Former member" for a person who
 * was never one.
 */
async function assertAssignable(db: Db, userIds: readonly string[]): Promise<void> {
  const wanted = uniq(userIds);
  if (wanted.length === 0) return;
  const found = await db.user.findMany({
    where: { id: { in: wanted }, directoryStatus: "ACTIVE", role: { in: [...PM_PERSON_ROLES] } },
    select: { id: true },
  });
  const have = new Set(found.map((u) => u.id));
  const missing = wanted.filter((id) => !have.has(id));
  if (missing.length > 0) throw new PmRefError(PM_ERRORS.INVALID_ASSIGNEE, missing);
}

/** Levels the parent walk climbs before it refuses — the relations BFS's bound
 *  (RELATION_SCAN_MAX_DEPTH), restated here because pm-relations imports this file. */
const PARENT_WALK_MAX_DEPTH = 32;

/**
 * Would making `parentId` the parent of `itemId` close a loop? Walk UP from the
 * proposed parent: if the chain reaches the item, the item is that parent's
 * ancestor and the move would make it its own. One query per level, bounded.
 *
 * Fails CLOSED: a chain that revisits a node (a loop already in the data — only
 * self-parenting used to be refused) or is deeper than the bound is refused
 * rather than extended; walking on could not end, or would only guess.
 */
async function assertNoParentCycle(db: Db, itemId: string, parentId: string): Promise<void> {
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  for (let depth = 0; cursor !== null; depth += 1) {
    if (cursor === itemId || depth >= PARENT_WALK_MAX_DEPTH || seen.has(cursor)) {
      throw new Error(PM_ERRORS.PARENT_CYCLE);
    }
    seen.add(cursor);
    const row: { parentId: string | null } | null = await db.pmWorkItem.findUnique({
      where: { id: cursor },
      select: { parentId: true },
    });
    cursor = row?.parentId ?? null;
  }
}

/** The SERIALIZABLE loser of a re-parent (P2034): nothing was applied; the
 *  route answers 409 and the client retries. */
function rethrowSerializationLoser(err: unknown): never {
  if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
  throw err;
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

// ── People ───────────────────────────────────────────────────────────────────

/** A person a PM id can name — the whole of what Projects needs to render one. */
export interface ApiPerson {
  id: string;
  displayName: string;
  /** Always null today: the box stores no avatar images. The field is part of
   *  the contract so a future avatar source needs a server change and nothing
   *  else; the dashboard draws initials until then. */
  avatarUrl: string | null;
}

/**
 * WARP-3372 — the people a lead, assignee, creator, comment author or activity
 * actor id can name: every ACTIVE person on the box, owner and admin through
 * member and external guest (a guest can be assigned an item, WARP-3369).
 *
 * Why this exists: the roster the dashboard read for names, GET /auth/users,
 * is owner/admin-only, so a member saw "User 1a2b" for every colleague. PM is
 * household-shared — every role that can read the board has to be able to name
 * the people on it — and this is the minimal projection that lets them: id,
 * name, avatar. No email, no role, no source, no deletion state.
 *
 * Who is NOT here, on purpose: service principals (machines), and anyone
 * deactivated or on their way out — their ids still sit on old work, and the
 * dashboard renders an id this list does not know as "Former member" rather
 * than keep a leaver's name in circulation.
 */
export async function listPeople(prisma: PrismaClient): Promise<ApiPerson[]> {
  const rows = await prisma.user.findMany({
    where: { directoryStatus: "ACTIVE", role: { in: [...PM_PERSON_ROLES] } },
    select: { id: true, displayName: true },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, displayName: r.displayName, avatarUrl: null }));
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function listProjects(
  prisma: PrismaClient,
  opts: {
    workspaceSlug?: string;
    includeArchived?: boolean;
    perPage?: number;
    /**
     * WARP-2719 — an id filters to that department AND its teams; `null`
     * filters to projects no department owns; `undefined` applies no filter.
     * The same three-way encoding `listWorkItems` uses.
     *
     * 🔴 NO INHERITANCE HERE, and `departmentWorkItemWhere` must not be used.
     * A work item can borrow its project's department when it has none of its
     * own; a project has nothing to borrow from. Reaching for the work-item
     * helper would ask whether the project's own project has a department,
     * which is not a question.
     */
    departmentId?: string | null;
  } = {},
): Promise<ApiProject[]> {
  // WARP-3528 — projects only; a service desk is listed by /api/support.
  const where: Prisma.PmProjectWhereInput = { kind: "PROJECT" };
  if (opts.workspaceSlug) where.workspace = { slug: opts.workspaceSlug };
  if (!opts.includeArchived) where.isArchived = false;
  if (opts.departmentId !== undefined) {
    where.departmentId =
      opts.departmentId === null
        ? null
        : { in: await expandDepartmentScope(prisma, opts.departmentId) };
  }
  const take = opts.perPage !== undefined ? clampLimit(opts.perPage) : undefined;
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

/** Index KPI strip: active projects, open items, done in the last 7 days,
 *  overdue (open items past their due date) and unassigned (open items nobody
 *  owns). Four counts in the database, not a scan of every row in JS — the
 *  numbers must stay exact however many items the workspace holds.
 *
 *  "Open" is the same rule as `listProjects`: a state in backlog / unstarted /
 *  started, or no state at all (WARP-884 / finding #5). `doneThisWeek` counts
 *  anything with `isCompleted` — cancelled included — which is what the strip
 *  has always shown and what finding #6 pinned. `now` is injectable for tests. */
export async function getSummary(
  prisma: PrismaClient,
  workspaceSlug: string = HOME_WORKSPACE_SLUG,
  today: string = todayDateOnly(),
  now: Date = new Date(),
): Promise<ApiPmSummary> {
  const startOfToday = parseDateInput(today);
  // The route validates `today` at the boundary; a bad value here is a bug in a
  // caller, not input to guess about.
  if (!startOfToday) throw new Error("invalid_today");
  const projects = await prisma.pmProject.findMany({
    where: { workspace: { slug: workspaceSlug }, isArchived: false, kind: "PROJECT" },
    select: { id: true },
  });
  if (projects.length === 0) {
    return { activeProjects: 0, itemsOpen: 0, doneThisWeek: 0, overdue: 0, unassigned: 0 };
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const inScope: Prisma.PmWorkItemWhereInput = {
    projectId: { in: projects.map((p) => p.id) },
    isArchived: false,
  };
  const open: Prisma.PmWorkItemWhereInput = {
    OR: [{ stateId: null }, { state: { group: { in: OPEN_GROUPS } } }],
  };
  const [itemsOpen, overdue, doneThisWeek, unassigned] = await Promise.all([
    prisma.pmWorkItem.count({ where: { ...inScope, ...open } }),
    prisma.pmWorkItem.count({ where: { ...inScope, ...open, dueDate: { lt: startOfToday } } }),
    // WARP-884: `isCompleted` is the canonical completion signal — not
    // re-derived from `state.group` plus a `completedAt` check.
    prisma.pmWorkItem.count({ where: { ...inScope, isCompleted: true, completedAt: { gte: weekAgo } } }),
    prisma.pmWorkItem.count({ where: { ...inScope, ...open, assignees: { none: {} } } }),
  ]);
  return { activeProjects: projects.length, itemsOpen, doneThisWeek, overdue, unassigned };
}

export async function getProject(prisma: PrismaClient, projectId: string): Promise<ApiProject> {
  const row = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: PROJECT_INCLUDE,
  });
  if (!row || isServiceDesk(row)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  return mapProject(row);
}

/**
 * ADR-048 (WARP-2729) — refuse a project→customer link to a customer that is
 * not there.
 *
 * Existence only. Origin is deliberately NOT checked: linking is additive and
 * writes nothing to the company, so a project may be filed under a synced
 * (EXTERNAL) customer exactly as under one somebody typed. The EXTERNAL guards
 * in `crm.service.ts` exist to stop a caller EDITING a vendor-owned row, which
 * this does not do.
 */
async function assertCompanyExists(prisma: PrismaClient, companyId: string): Promise<void> {
  const found = await prisma.crmCompany.findUnique({
    where: { id: companyId },
    select: { id: true },
  });
  if (!found) throw new Error(PM_ERRORS.COMPANY_NOT_FOUND);
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
    /**
     * ADR-048 (WARP-2729) — the customer this project is FOR.
     *
     * The column has existed since WARP-2562 with NO writer anywhere: not here,
     * not in `updateProject`, not on the route, not in `pm_create_project`, not
     * in the dashboard. The customer record already READS it
     * (`customer-record.service.ts` lists projects by `companyId`), so filing a
     * project under a customer has been half-built the whole time — this is the
     * missing half.
     *
     * Deliberately NOT derived from `CrmDeal.projectId`: deriving drops every
     * job that never had a deal (a warranty callout, a second phase, work that
     * predates the CRM being switched on), which is the schema comment's own
     * stated reason for the column existing.
     */
    companyId?: string;
  },
): Promise<ApiProject> {
  // ADR-045 §5.3 — refuse HOUSEHOLD and archive-intent departments, but NOT a
  // department that is merely pending / provisioning / failed: storage
  // convergence is not a precondition for owning work.
  //
  // 🔴 WARP-2724 — `!== undefined`, not truthiness, and the reason is written
  // out three lines below this for `companyId`: `department_id: ""` is FALSY,
  // so a truthy check skipped the guard entirely, and `??` does not coerce ""
  // either — so the empty string survived to `departmentId: input.departmentId
  // ?? null` and reached Postgres as an empty FK. A raw P2003 500 on a request
  // the API had every chance to refuse in words.
  //
  // The two columns had the same bug; only one of them had been found. Now
  // `assertAssignableDepartment` sees the "" and answers `department_not_found`
  // (→404), which is what the two UPDATE paths in this file already do.
  if (input.departmentId !== undefined) {
    await assertAssignableDepartment(prisma, input.departmentId);
  }
  // ADR-048 — a project may only be filed under a customer that exists.
  // Checked here rather than left to the FK so the caller gets
  // `company_not_found` (→404) instead of a redacted P2003 500 — the exact
  // defect WARP-2577 fixed on five CRM columns, not re-introduced here.
  // `!== undefined`, not truthiness: `company_id: ""` is falsy, so a truthy
  // check skipped the existence probe AND survived the `?? null` write (`??`
  // does not coerce ""), reaching Postgres as an empty FK — a raw P2003 500.
  // The zod schemas reject "" at the boundary; this keeps the service honest on
  // its own, and matches `updateProject`'s shape below.
  if (input.companyId !== undefined) await assertCompanyExists(prisma, input.companyId);

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
        companyId: input.companyId ?? null,
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
    // A company hard-deleted between `assertCompanyExists` and this insert
    // fails the FK. Companies CAN be hard-deleted (crm.service.ts), unlike
    // departments, so the race is reachable — surface `company_not_found`
    // (→404) rather than a redacted 500. Same idiom as the parent-FK race in
    // `createWorkItem`.
    if (isCompanyFkViolation(err)) throw new Error(PM_ERRORS.COMPANY_NOT_FOUND);
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
    /**
     * ADR-048 — the customer. `undefined` leaves it alone, `null` clears it.
     *
     * The service is deliberately permissive: a human may re-point a project at
     * a different customer, because correcting a mistake is the whole reason
     * the field is editable. The "only fill a NULL, never overwrite" rule is an
     * AUTO-APPLY policy (WARP-2733's class table), enforced there — a
     * restriction on what the box may do unattended is not a restriction on
     * what a person may do.
     */
    companyId?: string | null;
  },
): Promise<ApiProject> {
  const existing = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!existing || isServiceDesk(existing)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  const data: Prisma.PmProjectUpdateInput = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.icon !== undefined) data.icon = fields.icon;
  if (fields.color !== undefined) data.color = fields.color;
  if (fields.leadId) {
    const lead = await prisma.user.findUnique({ where: { id: fields.leadId }, select: { role: true } });
    if (lead?.role === "guest") throw new Error(PM_ERRORS.LEAD_IS_GUEST);
  }
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
  // ADR-048. Same connect/disconnect idiom as `department` above: this update
  // goes through Prisma's CHECKED `PmProjectUpdateInput`, which exposes
  // relations rather than their foreign keys. Clearing is unguarded — removing
  // a wrong customer must never be blocked by the customer's own state.
  if (fields.companyId !== undefined) {
    if (fields.companyId !== null) {
      await assertCompanyExists(prisma, fields.companyId);
    }
    data.company = fields.companyId
      ? { connect: { id: fields.companyId } }
      : { disconnect: true };
  }
  // WARP-3370 — archive / restore is NOT a field of this update any more: it has
  // its own function (`setProjectArchived`) because a change of that kind has to
  // say whether it actually moved the project, so the caller can audit it.
  // Same FK race as `createProject`: the existence check above and this write
  // are two round-trips, and the customer can vanish in between.
  let updated;
  try {
    updated = await prisma.pmProject.update({
      where: { id: projectId },
      data,
      include: PROJECT_INCLUDE,
    });
  } catch (err) {
    if (isCompanyFkViolation(err)) throw new Error(PM_ERRORS.COMPANY_NOT_FOUND);
    throw err;
  }
  return mapProject(updated);
}

/**
 * WARP-3370 — archive or restore a project.
 *
 * Archiving is the reversible half of "delete project": the project leaves the
 * index (behind its Archived filter), its work items stay where they are, and
 * restoring puts it back. `isArchived` is the canonical signal (WARP-884);
 * `archivedAt` is its audit timestamp, written and cleared with it so the two
 * never diverge.
 *
 * The write is a compare-and-set on the CURRENT value, so two concurrent
 * requests move the project once, and `changed` tells the caller whether THIS
 * call was the one that did — the route audits a transition, never a no-op
 * repeat. Asking for the state a project is already in is not an error.
 */
export async function setProjectArchived(
  prisma: PrismaClient,
  projectId: string,
  archived: boolean,
): Promise<{ project: ApiProject; changed: boolean }> {
  const moved = await prisma.pmProject.updateMany({
    where: { id: projectId, kind: "PROJECT", isArchived: !archived },
    data: { isArchived: archived, archivedAt: archived ? new Date() : null },
  });
  // Also the existence check: a project that is not there is a 404 either way.
  const project = await getProject(prisma, projectId);
  return { project, changed: moved.count === 1 };
}

/** What the audit row for a hard delete is told about the project that is going. */
export interface DeletedProjectInfo {
  id: string;
  name: string;
  identifier: string;
  /** How many work items went with it — the number an audit reader needs. */
  workItemCount: number;
}

/** A project with thousands of items cascades through several tables; the
 *  interactive-transaction default of 5s is not a bound this delete can promise. */
const DELETE_TX_TIMEOUT_MS = 60_000;

/**
 * WARP-3370 — delete a project, its work items and everything under them, for
 * good. Three conditions, each its own refusal, checked in this order:
 *
 *   1. the project is ARCHIVED (`project_not_archived`, 409) — archiving is the
 *      step that makes a deletion deliberate, and until then nothing here runs;
 *   2. the caller typed the project's identifier (`identifier_mismatch`, 422) —
 *      the route also pins who may ask (owner / admin only);
 *   3. the project is still archived when the delete lands. The delete is a
 *      compare-and-set on `isArchived: true`, so a restore that wins the race
 *      cancels it (409) instead of being cascaded away.
 *
 * `audit` appends the ActivityRow INSIDE the delete's transaction
 * (`recordActivityInTx`): a project is never destroyed without its audit row,
 * because the row and the delete commit together — and if the row cannot be
 * written the delete rolls back. It runs AFTER the delete, as that helper
 * requires (row-locking writes first, the chain-append lock last).
 */
export async function deleteProject(
  prisma: PrismaClient,
  projectId: string,
  opts: {
    /** The identifier the caller typed. Compared exactly. */
    confirmIdentifier: string;
    audit: (tx: Prisma.TransactionClient, project: DeletedProjectInfo) => Promise<unknown>;
  },
): Promise<void> {
  const existing = await prisma.pmProject.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, identifier: true, isArchived: true, kind: true },
  });
  if (!existing || isServiceDesk(existing)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  if (!existing.isArchived) throw new Error(PM_ERRORS.PROJECT_NOT_ARCHIVED);
  if (opts.confirmIdentifier !== existing.identifier) throw new Error(PM_ERRORS.IDENTIFIER_MISMATCH);

  try {
    await prisma.$transaction(
      async (tx) => {
        const workItemCount = await tx.pmWorkItem.count({ where: { projectId } });
        const gone = await tx.pmProject.deleteMany({ where: { id: projectId, kind: "PROJECT", isArchived: true } });
        // Restored (or already deleted) between the read above and here. Throwing
        // rolls back; nothing was applied.
        if (gone.count === 0) throw new Error(PM_ERRORS.PROJECT_NOT_ARCHIVED);
        await opts.audit(tx, {
          id: existing.id,
          name: existing.name,
          identifier: existing.identifier,
          workItemCount,
        });
      },
      { ...READ_COMMITTED_TX, timeout: DELETE_TX_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof Error && err.message === PM_ERRORS.PROJECT_NOT_ARCHIVED) {
      // Which of the two it was: restored (409) or deleted by someone else (404).
      const still = await prisma.pmProject.findUnique({ where: { id: projectId }, select: { id: true } });
      throw new Error(still ? PM_ERRORS.PROJECT_NOT_ARCHIVED : PM_ERRORS.PROJECT_NOT_FOUND);
    }
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
    throw err;
  }
}

// ── States ───────────────────────────────────────────────────────────────────

export async function listStates(prisma: PrismaClient, projectId: string): Promise<ApiState[]> {
  // Still no 404 for an id that is not there (an empty list, as ever); a desk's
  // id is project_not_found (WARP-3528), never its states.
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    select: { kind: true },
  });
  if (isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  const existing = await prisma.pmState.findUnique({
    where: { id: stateId },
    include: { project: { select: { kind: true } } },
  });
  if (!existing || isServiceDesk(existing.project)) throw new Error(PM_ERRORS.STATE_NOT_FOUND);

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
  const existing = await prisma.pmState.findUnique({
    where: { id: stateId },
    include: { project: { select: { kind: true } } },
  });
  if (!existing || isServiceDesk(existing.project)) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
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
  // Same shape as listStates: an unknown id stays an empty list, a desk's id is
  // project_not_found (WARP-3528).
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    select: { kind: true },
  });
  if (isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  const rows = await prisma.pmLabel.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  return rows.map(mapLabel);
}

export async function createLabel(
  prisma: PrismaClient,
  projectId: string,
  input: { name: string; color?: string },
): Promise<ApiLabel> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId } });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
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
  const existing = await prisma.pmLabel.findUnique({
    where: { id: labelId },
    include: { project: { select: { kind: true } } },
  });
  if (!existing || isServiceDesk(existing.project)) throw new Error(PM_ERRORS.LABEL_NOT_FOUND);
  const row = await prisma.pmLabel.update({ where: { id: labelId }, data: fields });
  return mapLabel(row);
}

export async function deleteLabel(prisma: PrismaClient, labelId: string): Promise<void> {
  const existing = await prisma.pmLabel.findUnique({
    where: { id: labelId },
    include: { project: { select: { kind: true } } },
  });
  if (!existing || isServiceDesk(existing.project)) throw new Error(PM_ERRORS.LABEL_NOT_FOUND);
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
    /** Page size, `1..PM_PAGE_MAX`, default `PM_PAGE_DEFAULT`. */
    limit?: number;
    /** WARP-3371 — the previous page's `nextCursor`. Wins over `page`. */
    cursor?: string;
    /** Legacy 1-based offset page, kept for callers that predate the cursor. */
    page?: number;
  } = {},
): Promise<Page<ApiWorkItem>> {
  // Decoded before any read: a malformed cursor is the caller's 400, and it
  // should not cost a query (or be hidden behind a 404 on the project).
  const after = filters.cursor ? decodeCursor(ORDER_BOARD, filters.cursor) : null;
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

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
  const and: Prisma.PmWorkItemWhereInput[] = [];
  if (filters.departmentId !== undefined) {
    const scope =
      filters.departmentId === null
        ? null
        : await expandDepartmentScope(prisma, filters.departmentId);
    and.push(departmentWorkItemWhere(scope));
  }
  if (filters.q && filters.q.trim().length > 0) {
    const q = filters.q.trim();
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { descriptionHtml: { contains: q, mode: "insensitive" } },
    ];
  }
  if (and.length > 0) where.AND = and;

  // WARP-3371 — a page, never a silent ceiling. `total` is counted over the
  // FILTERED set without the cursor, so it is the same number on every page and
  // the view can say "100 of 250". The page itself asks for one row more than
  // it returns: that extra row is the only proof there is a next page.
  const limit = clampLimit(filters.limit);
  const pageWhere: Prisma.PmWorkItemWhereInput = after
    ? { ...where, AND: [...and, keysetAfter("sortOrder", "asc", after) as Prisma.PmWorkItemWhereInput] }
    : where;
  const skip = after ? 0 : (Math.max(1, filters.page ?? 1) - 1) * limit;
  const [total, rows] = await Promise.all([
    prisma.pmWorkItem.count({ where }),
    prisma.pmWorkItem.findMany({
      where: pageWhere,
      include: WORK_ITEM_INCLUDE,
      // `id` closes the tie: `sortOrder` is not unique (a PATCH can set two
      // rows to the same value), and a cursor over a non-unique key would skip
      // or repeat the rows that share it.
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      ...(skip > 0 ? { skip } : {}),
      take: limit + 1,
    }),
  ]);
  const { items, nextCursor } = sliceToPage(rows, limit, (r) =>
    encodeCursor(ORDER_BOARD, r.sortOrder, r.id),
  );
  return {
    items: items.map((r) => mapWorkItem(r, project.identifier, project.department)),
    nextCursor,
    total,
  };
}

/**
 * WARP-3521 — a project's work items narrowed by one extra predicate, with the
 * EXACT total beside them. Backs the cycle detail, the cycle backlog and the
 * module detail: "this cycle's items" has to be a server-side question, because
 * the board's own list is a capped page and a cycle's items can sit beyond it.
 *
 * It is a sibling of `listWorkItems`, not a parameter on it, so the board's list
 * (and its callers — the mobile router, the assistant's tools) keep exactly the
 * signature they have. Archived items are excluded, like every other list.
 * `perPage` defaults to the 200 maximum: these are scoped sets (one sprint, one
 * epic), and the caller that wants a smaller page asks for one.
 */
export async function listWorkItemsWhere(
  prisma: PrismaClient,
  projectId: string,
  extra: Prisma.PmWorkItemWhereInput,
  opts: { perPage?: number; page?: number } = {},
): Promise<{ items: ApiWorkItem[]; total: number }> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  const where: Prisma.PmWorkItemWhereInput = { AND: [{ projectId, isArchived: false }, extra] };
  const perPage = Math.max(1, Math.min(200, opts.perPage ?? 200));
  const page = Math.max(1, opts.page ?? 1);
  const [rows, total] = await Promise.all([
    prisma.pmWorkItem.findMany({
      where,
      include: WORK_ITEM_INCLUDE,
      orderBy: [{ sortOrder: "asc" }, { sequenceId: "asc" }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.pmWorkItem.count({ where }),
  ]);
  return { items: rows.map((r) => mapWorkItem(r, project.identifier, project.department)), total };
}

export async function getWorkItem(prisma: PrismaClient, id: string): Promise<ApiWorkItem> {
  const row = await prisma.pmWorkItem.findUnique({ where: { id }, include: WORK_ITEM_INCLUDE });
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findUnique({
    where: { id: row.projectId },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  // WARP-3528 — an item in a service desk is a ticket: not found, like a missing one.
  if (isServiceDesk(project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  return mapWorkItem(row, project.identifier, project.department);
}

/** Workspace-wide free-text search over work-item name + description. Backs the
 *  `pm_search_work_items` MCP tool, which keys on workspace_slug (not project). */
export async function searchWorkItems(
  prisma: PrismaClient,
  opts: {
    workspaceSlug?: string;
    q: string;
    /** WARP-2719 — same three-way encoding as `listWorkItems`, and the same
     *  override rule: an item's own department wins, and an item with none
     *  inherits its project's. */
    departmentId?: string | null;
    /** Page size, `1..PM_PAGE_MAX`, default `PM_PAGE_DEFAULT`. */
    limit?: number;
    /** WARP-3371 — the previous page's `nextCursor`. */
    cursor?: string;
  },
): Promise<Page<ApiWorkItem>> {
  const after = opts.cursor ? decodeCursor(ORDER_SEARCH, opts.cursor) : null;
  const q = opts.q.trim();
  // 🔴 An empty `q` used to be an unconditional empty list, which was right
  // while free text was the only filter this reader had. It is now the answer
  // to "what is Front Desk working on?" — a question with no search term in it
  // at all — so the short-circuit narrows to "no filter of any kind".
  if (q.length === 0 && opts.departmentId === undefined) {
    return { items: [], nextCursor: null, total: 0 };
  }
  const limit = clampLimit(opts.limit);
  // 🔴 The free-text `OR` is added CONDITIONALLY, and it did not used to be:
  // it was an unconditional member of this literal, safe only because the
  // guard above made an empty `q` unreachable. With that guard relaxed, an
  // unconditional member would run `contains: ""` — an `ILIKE '%%'` pair — on
  // every department-only query.
  const where: Prisma.PmWorkItemWhereInput = { isArchived: false };
  if (q.length > 0) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { descriptionHtml: { contains: q, mode: "insensitive" } },
    ];
  }
  // `where.AND`, never `where.OR` — the free-text filter above owns `OR`, and
  // `departmentWorkItemWhere` returns a bare-`OR` fragment for exactly this
  // reason. Writing it to `where.OR` would turn "items in Front Desk matching
  // X" into "items in Front Desk".
  const and: Prisma.PmWorkItemWhereInput[] = [];
  if (opts.departmentId !== undefined) {
    const scope =
      opts.departmentId === null
        ? null
        : await expandDepartmentScope(prisma, opts.departmentId);
    and.push(departmentWorkItemWhere(scope));
  }
  if (and.length > 0) where.AND = and;
  where.project = {
    kind: "PROJECT",
    ...(opts.workspaceSlug ? { workspace: { slug: opts.workspaceSlug } } : {}),
  };
  const pageWhere: Prisma.PmWorkItemWhereInput = after
    ? { ...where, AND: [...and, keysetAfter("updatedAt", "desc", after) as Prisma.PmWorkItemWhereInput] }
    : where;
  const [total, rows] = await Promise.all([
    prisma.pmWorkItem.count({ where }),
    prisma.pmWorkItem.findMany({
      where: pageWhere,
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
      // Newest change first, `id` closing the tie (two rows can share a
      // millisecond), so the cursor below names exactly one position.
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
  ]);
  const { items, nextCursor } = sliceToPage(rows, limit, (r) =>
    encodeCursor(ORDER_SEARCH, r.updatedAt, r.id),
  );
  return {
    items: items.map((r) => mapWorkItem(r, r.project.identifier, r.project.department)),
    nextCursor,
    total,
  };
}

/** WARP-3407 — the work items assigned to ONE person, across projects, newest
 *  change first. Backs `GET /pm/assigned-to-me`, which passes only the caller's
 *  own id: for an external guest this is how they find the items shared with
 *  them by assignment (WARP-3369), and it names nothing that isn't. */
export async function listAssignedWorkItems(
  prisma: PrismaClient,
  userId: string,
  opts: {
    /** Page size, `1..PM_PAGE_MAX`, default `PM_PAGE_DEFAULT`. */
    limit?: number;
    /** WARP-3371 — the previous page's `nextCursor`. Wins over `page`. */
    cursor?: string;
    /** Legacy 1-based offset page, kept for callers that predate the cursor. */
    page?: number;
  } = {},
): Promise<Page<ApiWorkItem>> {
  const after = opts.cursor ? decodeCursor(ORDER_ASSIGNED, opts.cursor) : null;
  const limit = clampLimit(opts.limit);
  const where: Prisma.PmWorkItemWhereInput = {
    isArchived: false,
    assignees: { some: { userId } },
    project: { kind: "PROJECT" },
  };
  const skip = after ? 0 : (Math.max(1, opts.page ?? 1) - 1) * limit;
  const [total, rows] = await Promise.all([
    prisma.pmWorkItem.count({ where }),
    prisma.pmWorkItem.findMany({
      where: after
        ? { ...where, AND: [keysetAfter("updatedAt", "desc", after) as Prisma.PmWorkItemWhereInput] }
        : where,
      // Spans projects, so it joins the project per row (searchWorkItems' rule).
      include: {
        ...WORK_ITEM_INCLUDE,
        project: {
          select: { identifier: true, department: { select: DEPARTMENT_SELECT } },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(skip > 0 ? { skip } : {}),
      take: limit + 1,
    }),
  ]);
  const { items, nextCursor } = sliceToPage(rows, limit, (r) =>
    encodeCursor(ORDER_ASSIGNED, r.updatedAt, r.id),
  );
  return {
    items: items.map((r) => mapWorkItem(r, r.project.identifier, r.project.department)),
    nextCursor,
    total,
  };
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
    /** WARP-3521 — plan the new item into a cycle of THIS project. */
    cycleId?: string;
    startDate?: Date;
    dueDate?: Date;
  },
): Promise<ApiWorkItem> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { states: true, department: { select: DEPARTMENT_SELECT } },
  });
  if (!project || isServiceDesk(project)) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);

  // WARP-3528 — a parent / state / label that lives in a service desk is "not
  // found", never "in another project" (422): the difference would tell a
  // caller an id they were not given is a ticket's.
  if (input.parentId) {
    const parent = await prisma.pmWorkItem.findUnique({
      where: { id: input.parentId },
      include: { project: { select: { kind: true } } },
    });
    if (!parent || isServiceDesk(parent.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    if (parent.projectId !== projectId) throw new Error(PM_ERRORS.INVALID_PARENT);
  }

  // An explicit state must belong to THIS project — mirror the parent guard so
  // a work item can never reference a state from another project (review
  // findings #4/#1). Missing id → state_not_found (404); wrong project →
  // invalid_state (422).
  if (input.stateId) {
    const state = await prisma.pmState.findUnique({
      where: { id: input.stateId },
      include: { project: { select: { kind: true } } },
    });
    if (!state || isServiceDesk(state.project)) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
    if (state.projectId !== projectId) throw new Error(PM_ERRORS.INVALID_STATE);
  }

  // Labels must exist AND belong to THIS project — same cross-project isolation
  // invariant as parentId and stateId — and assignees must be active people.
  // Both answer 422 naming the offending ids (WARP-3371).
  const labelIds = await assertLabelsInProject(prisma, projectId, input.labelIds ?? []);
  const assignees = uniq(input.assignees ?? []);
  await assertAssignable(prisma, assignees);

  // ADR-045 §5.3 — same shape as the guards above: refuse before the write, not
  // after. Refuses HOUSEHOLD (it is the unit everyone is already in, so routing
  // to it is indistinguishable from routing nothing) and archive-intent states.
  // Does NOT refuse pending / provisioning / failed.
  // 🔴 WARP-2724 — TWO fixes, and they are separate defects that happened to
  // sit on one line.
  //
  // 1. `!== undefined`, not truthiness. `department_id: ""` is FALSY, so a
  //    truthy check skipped the guard, and `??` does not coerce "" either — so
  //    the empty string survived to `departmentId: input.departmentId ?? null`
  //    and reached Postgres as an empty FK: a raw P2003 500 on a request the
  //    API could have refused in words. The same bug was on `createProject`,
  //    three lines under a comment describing it for `companyId`.
  //
  // 2. The check MOVED INSIDE the transaction (below). It used to run here,
  //    before `prisma.$transaction` opened, so a department archived in the
  //    window between the two was checked in one world and written in another.
  //    The window is small and the write is the thing that matters, so the
  //    check now runs against `tx` — same connection, same snapshot, no gap.
  //
  // `createProject` keeps its check outside, because it has no transaction to
  // move into: its own comment records that the identifier loop and the create
  // are deliberately not one. Narrowing that window is a different change with
  // a different risk, and is not smuggled in here.

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
      // WARP-2724 — inside the tx, against `tx`, so the department that is
      // checked is the department the row is written against.
      if (input.departmentId !== undefined) {
        await assertAssignableDepartment(tx, input.departmentId);
      }
      // WARP-3521 — same place, same reason: the cycle that is checked (and
      // row-locked, so a racing `completeCycle` cannot finish it under us) is
      // the cycle the item is written against.
      if (input.cycleId !== undefined) {
        await lockAttachableCycle(tx, input.cycleId, projectId);
      }
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
          ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
          createdById: actorId,
          startDate: input.startDate ?? null,
          dueDate: input.dueDate ?? null,
          sortOrder: sequenceId,
          isCompleted: initialIsCompleted,
          completedAt: initialCompletedAt,
          assignees: assignees.length ? { create: assignees.map((userId) => ({ userId })) } : undefined,
          labels: labelIds.length ? { create: labelIds.map((labelId) => ({ labelId })) } : undefined,
        },
      });
      await writeActivity(tx, { workItemId: item.id, actorId, verb: "created" });
      // WARP-3521 — planned into a cycle at birth: the burndown reads this row.
      if (input.cycleId !== undefined) {
        await writeActivity(tx, {
          workItemId: item.id,
          actorId,
          verb: "cycle_added",
          field: "cycle",
          oldValue: null,
          newValue: input.cycleId,
        });
      }
      // WARP-2587: a create WITH assignees is an assignment, and `created`
      // does not say who. One `assigned` row per assignee, so the notify
      // sweep sees the same shape whether the assignment happened at create
      // time or in a later PATCH. `actorId` is on the row, so somebody who
      // creates an item assigned to themselves is never notified about it.
      for (const userId of assignees) {
        await writeActivity(tx, {
          workItemId: item.id,
          actorId,
          verb: "assigned",
          field: "assignees",
          oldValue: null,
          newValue: userId,
        });
      }
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
    /** WARP-3521 — `undefined` leaves the cycle alone; `null` takes the item out
     *  of its cycle (back to the backlog); an id plans it into that cycle. */
    cycleId?: string | null;
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
  // WARP-3528 — before any validation or write: a ticket is not found here.
  if (isServiceDesk(project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);

  // When transitioning into/out of a terminal-group state, sync
  // isCompleted/completedAt. isCompleted is the canonical signal (WARP-884);
  // completedAt is written alongside it as the audit timestamp.
  let completedAt: Date | null | undefined;
  let isCompleted: boolean | undefined;
  if (fields.stateId !== undefined && fields.stateId !== existing.stateId) {
    if (fields.stateId === null) {
      // WARP-3371 — a work item keeps its state: with none, the board has no
      // column for it and the card silently disappears. (An item that already
      // has none and is sent null again is not a change, so it never gets here.)
      throw new Error(PM_ERRORS.STATE_REQUIRED);
    } else {
      // The target state must belong to THIS work item's project. Distinguish
      // "no such state" (404) from "state belongs to another project" (422) so
      // the cross-project guard mirrors the parent check's shape (findings
      // #4/#2) rather than masking it as a generic not-found.
      const target = await prisma.pmState.findUnique({
        where: { id: fields.stateId },
        include: { project: { select: { kind: true } } },
      });
      if (!target || isServiceDesk(target.project)) throw new Error(PM_ERRORS.STATE_NOT_FOUND);
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
    const parent = await prisma.pmWorkItem.findUnique({
      where: { id: fields.parentId },
      include: { project: { select: { kind: true } } },
    });
    if (!parent || isServiceDesk(parent.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    if (parent.projectId !== existing.projectId) throw new Error(PM_ERRORS.INVALID_PARENT);
  }

  // Labels must exist AND belong to THIS project before the transaction mutates
  // them, and a person ADDED as an assignee must exist and be active; both name
  // the offending ids (WARP-3371). Only the assignees this update ADDS are
  // checked: re-sending a set that still holds someone who has since left must
  // not block editing the item, and removing them must always work.
  const labelIds =
    fields.labelIds === undefined
      ? undefined
      : await assertLabelsInProject(prisma, existing.projectId, fields.labelIds);
  const assignees = fields.assignees === undefined ? undefined : uniq(fields.assignees);
  if (assignees) {
    const current = new Set(existing.assignees.map((a) => a.userId));
    await assertAssignable(prisma, assignees.filter((u) => !current.has(u)));
  }

  // ADR-045 §5.3 — guard before the transaction, like every check above.
  // Clearing (null) is deliberately unguarded so an item can always be routed
  // back out of a department that has since been archived.
  if (fields.departmentId !== undefined && fields.departmentId !== null) {
    await assertAssignableDepartment(prisma, fields.departmentId);
  }

  // WARP-3371 — re-parenting reads a chain and then writes: two concurrent moves
  // (A under B, B under A) each pass the walk against a graph without the other
  // and together close a loop. SERIALIZABLE makes one of them lose (P2034 → 409),
  // as pm-relations does for BLOCKS cycles; only a real re-parent pays for it.
  const reparentTo = fields.parentId && fields.parentId !== existing.parentId ? fields.parentId : null;

  await prisma.$transaction(async (tx) => {
    if (reparentTo) await assertNoParentCycle(tx, id, reparentTo);
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
    // WARP-3521 — planning into / out of a cycle. The item's CURRENT cycle is
    // re-read here, inside the transaction, rather than trusted from the read
    // above: `completeCycle` moves items under a SERIALIZABLE transaction of its
    // own, and an activity row whose `oldValue` names a cycle the item left a
    // moment earlier would corrupt exactly the history the burndown is rebuilt
    // from. `undefined` below means "no cycle change"; `null` is a real
    // previous value (no cycle).
    let previousCycleId: string | null | undefined;
    if (fields.cycleId !== undefined) {
      const current = await tx.pmWorkItem.findUnique({ where: { id }, select: { cycleId: true } });
      if (!current) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
      if (current.cycleId !== fields.cycleId) {
        // Only an attach is guarded. Taking an item OUT of a cycle (null) is
        // always allowed, including out of a completed one.
        if (fields.cycleId !== null) {
          await lockAttachableCycle(tx, fields.cycleId, existing.projectId);
        }
        // Compare-and-set the foreign key so overlapping moves cannot both
        // write history from the same stale `oldValue`. The target cycle is
        // locked first (the same cycle→item order as completeCycle), so an
        // attach cannot slip into a cycle as it completes.
        let oldCycleId = current.cycleId;
        let moved = await tx.pmWorkItem.updateMany({
          where: { id, cycleId: oldCycleId },
          data: { cycleId: fields.cycleId },
        });
        if (moved.count === 0) {
          const latest = await tx.pmWorkItem.findUnique({ where: { id }, select: { cycleId: true } });
          if (!latest) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
          oldCycleId = latest.cycleId;
          // Another request may already have moved it to this destination. In
          // that case this request is a no-op; otherwise retry once against the
          // value that now owns the row.
          if (oldCycleId !== fields.cycleId) {
            moved = await tx.pmWorkItem.updateMany({
              where: { id, cycleId: oldCycleId },
              data: { cycleId: fields.cycleId },
            });
            if (moved.count !== 1) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
            previousCycleId = oldCycleId;
          }
        } else {
          previousCycleId = oldCycleId;
        }
      }
    }
    if (Object.keys(data).length > 0) await tx.pmWorkItem.update({ where: { id }, data });

    // Assignees / labels are full-set replacements (delete-all + re-create).
    if (assignees !== undefined) {
      await tx.pmWorkItemAssignee.deleteMany({ where: { workItemId: id } });
      if (assignees.length) {
        await tx.pmWorkItemAssignee.createMany({
          data: assignees.map((userId) => ({ workItemId: id, userId })),
        });
      }
    }
    if (labelIds !== undefined) {
      await tx.pmWorkItemLabel.deleteMany({ where: { workItemId: id } });
      if (labelIds.length) {
        await tx.pmWorkItemLabel.createMany({
          data: labelIds.map((labelId) => ({ workItemId: id, labelId })),
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
    // WARP-3521 — one row per cycle change, `oldValue` / `newValue` being the
    // cycle left and the cycle joined (either may be null). A move A -> B is ONE
    // `cycle_added` row {A -> B}; the burndown reads such a row as a leave for A
    // and a join for B, so the verb only has to say which side is non-null.
    if (previousCycleId !== undefined) {
      await writeActivity(tx, {
        workItemId: id,
        actorId,
        verb: fields.cycleId ? "cycle_added" : "cycle_removed",
        field: "cycle",
        oldValue: previousCycleId,
        newValue: fields.cycleId ?? null,
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

    // WARP-2587 — assignee churn gets its OWN verbs. `assigned`,
    // `unassigned` and `due_date_changed` have been members of
    // PmActivityVerb since WARP-884 with zero writers anywhere in the repo:
    // both changes were folded into the `updated`/`fields` bucket below, so
    // "who is on this" and "when is it due" were unrecoverable from the
    // history feed and unnotifiable by anything downstream. The identity-PATCH
    // guard is preserved — `setChanged` still gates the whole block, so
    // re-sending the same assignee set writes nothing.
    if (setChanged(assignees, existingAssignees)) {
      const next = new Set(assignees ?? []);
      const before = new Set(existingAssignees);
      for (const userId of next) {
        if (before.has(userId)) continue;
        await writeActivity(tx, {
          workItemId: id,
          actorId,
          verb: "assigned",
          field: "assignees",
          oldValue: null,
          newValue: userId,
        });
      }
      for (const userId of before) {
        if (next.has(userId)) continue;
        await writeActivity(tx, {
          workItemId: id,
          actorId,
          verb: "unassigned",
          field: "assignees",
          oldValue: userId,
          newValue: null,
        });
      }
    }
    const dueDateChanged =
      fields.dueDate !== undefined &&
      fields.dueDate?.toISOString() !== existing.dueDate?.toISOString();
    if (dueDateChanged) {
      await writeActivity(tx, {
        workItemId: id,
        actorId,
        verb: "due_date_changed",
        field: "dueDate",
        oldValue: existing.dueDate?.toISOString() ?? null,
        newValue: fields.dueDate?.toISOString() ?? null,
      });
    }

    // The residual. `assignees` and `dueDate` are deliberately NOT in this
    // disjunction any more: they now have verbs that name them, and leaving
    // them here would write a second, less informative row for the same edit
    // — which is how the feed gets noisy and how a notifier ends up firing
    // twice.
    const scalarChanged =
      (fields.name !== undefined && fields.name !== existing.name) ||
      (fields.descriptionHtml !== undefined && fields.descriptionHtml !== existing.descriptionHtml) ||
      (fields.startDate !== undefined &&
        fields.startDate?.toISOString() !== existing.startDate?.toISOString()) ||
      setChanged(labelIds, existingLabelIds);
    if (scalarChanged) {
      await writeActivity(tx, { workItemId: id, actorId, verb: "updated", field: "fields" });
    }
  }, reparentTo ? SERIALIZABLE_TX : undefined).catch(rethrowSerializationLoser);

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
  const existing = await prisma.pmWorkItem.findUnique({
    where: { id },
    include: { project: { select: { kind: true } } },
  });
  if (!existing || isServiceDesk(existing.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  try {
    await prisma.$transaction(async (tx) => {
      const assignees = await tx.pmWorkItemAssignee.findMany({
        where: { workItemId: id },
        select: { userId: true },
      });
      const assignedUserIds = assignees.map(({ userId }) => userId);
      const guests = assignedUserIds.length === 0
        ? []
        : await tx.user.findMany({
            where: { id: { in: assignedUserIds }, role: "guest" },
            select: { id: true },
          });
      // A detached PmActivity tombstone is the transactional live-update event
      // for the deleted leaf. Ordinary activity rows cascade with the item;
      // this snapshot survives and contains only project/item/user IDs.
      await tx.pmActivity.create({
        data: {
          workItemId: null,
          actorId,
          verb: "deleted",
          deletedProjectId: existing.projectId,
          deletedWorkItemId: id,
          deletedGuestUserIds: guests.map(({ id: userId }) => userId),
          notifyStatus: "not_needed",
        },
      });
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
          nudge: false,
        });
      }
      // WARP-2586: the PmWorkItemRelation FKs cascade on BOTH ends, so this
      // delete silently erases every blocks/relates/duplicates edge touching
      // the item — including edges into OTHER projects, whose owners have no
      // other way to learn the link is gone. Same defect class as the
      // parent_removed case above, and the same answer: emit the audit row on
      // the SURVIVING end BEFORE the cascade, in the same transaction, so the
      // DB behaviour is never the only record. The transaction runs at
      // SERIALIZABLE (below) so a relation committed between this read and
      // the delete aborts the delete instead of being cascaded with no row.
      const relations = await tx.pmWorkItemRelation.findMany({
        where: { OR: [{ fromId: id }, { toId: id }] },
        select: { fromId: true, toId: true, kind: true },
      });
      if (relations.length > 0) {
        await tx.pmActivity.createMany({
          data: relations.map((rel) => {
            const otherId = rel.fromId === id ? rel.toId : rel.fromId;
            return {
              workItemId: otherId,
              actorId,
              verb: "relation_removed" as const,
              field: "relation",
              oldValue: `${rel.kind}:${id}`,
              newValue: null,
            };
          }),
        });
      }

      await tx.pmWorkItem.delete({ where: { id } });
    }, { ...SERIALIZABLE_TX, timeout: 5_000 });
    // Wake only after the delete and its tombstone have committed. If the
    // transaction rolls back, no consumer is nudged for an event that vanished.
    // This one post-commit wake also covers the surviving-end relation audit
    // rows written directly with createMany above.
    nudgeOutbox();
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
    // The SERIALIZABLE loser: an edge was committed under us between the audit
    // read and the delete. Nothing was applied -- the route answers 409 and the
    // client retries, rather than the cascade eating an edge nobody recorded.
    if (isPrismaCode(err, "P2034")) throw new Error(PM_ERRORS.CONCURRENT_MUTATION);
    throw err;
  }
}

// ── Comments ─────────────────────────────────────────────────────────────────

/**
 * A work item's comments, oldest to newest — a PAGE (WARP-3371), like every PM
 * list: `limit` (default 100, max 500), the previous page's opaque `cursor`, and
 * an exact `total`. A caller that sends nothing gets the first page and a
 * `nextCursor` that says whether there is more; it used to get every row, so a
 * thread of any length was one unbounded response.
 */
export async function listComments(
  prisma: PrismaClient,
  workItemId: string,
  opts: { limit?: number; cursor?: string; page?: number } = {},
): Promise<Page<ApiComment>> {
  const after = opts.cursor ? decodeCursor(ORDER_COMMENTS, opts.cursor) : null;
  const item = await prisma.pmWorkItem.findUnique({
    where: { id: workItemId },
    include: { project: { select: { kind: true } } },
  });
  if (!item || isServiceDesk(item.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const limit = clampLimit(opts.limit);
  const where: Prisma.PmCommentWhereInput = { workItemId };
  const skip = after ? 0 : (Math.max(1, opts.page ?? 1) - 1) * limit;
  const [total, rows] = await Promise.all([
    prisma.pmComment.count({ where }),
    prisma.pmComment.findMany({
      where: after ? { ...where, ...(keysetAfter("createdAt", "asc", after) as Prisma.PmCommentWhereInput) } : where,
      // `id` closes the tie: two comments can share a millisecond.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(skip > 0 ? { skip } : {}),
      take: limit + 1,
    }),
  ]);
  const { items, nextCursor } = sliceToPage(rows, limit, (r) => encodeCursor(ORDER_COMMENTS, r.createdAt, r.id));
  return { items: items.map(mapComment), nextCursor, total };
}

export async function addComment(
  prisma: PrismaClient,
  actorId: string | null,
  workItemId: string,
  commentHtml: string,
): Promise<ApiComment> {
  const item = await prisma.pmWorkItem.findUnique({
    where: { id: workItemId },
    include: { project: { select: { kind: true } } },
  });
  if (!item || isServiceDesk(item.project)) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
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

/** Append-only activity for a work item, oldest to newest (timeline order) — a
 *  PAGE (WARP-3371), under the same rules as `listComments`. */
export async function listActivity(
  prisma: PrismaClient,
  workItemId: string,
  opts: { limit?: number; cursor?: string; page?: number } = {},
): Promise<Page<ApiActivity>> {
  const after = opts.cursor ? decodeCursor(ORDER_ACTIVITY, opts.cursor) : null;
  const item = await prisma.pmWorkItem.findUnique({
    where: { id: workItemId },
    include: { project: { select: { kind: true } } },
  });
  if (!item || isServiceDesk(item.project)) throw new Error("work_item_not_found");
  const limit = clampLimit(opts.limit);
  const where: Prisma.PmActivityWhereInput = { workItemId };
  const skip = after ? 0 : (Math.max(1, opts.page ?? 1) - 1) * limit;
  const [total, rows] = await Promise.all([
    prisma.pmActivity.count({ where }),
    prisma.pmActivity.findMany({
      where: after ? { ...where, ...(keysetAfter("createdAt", "asc", after) as Prisma.PmActivityWhereInput) } : where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(skip > 0 ? { skip } : {}),
      take: limit + 1,
    }),
  ]);
  const { items, nextCursor } = sliceToPage(rows, limit, (r) => encodeCursor(ORDER_ACTIVITY, r.createdAt, r.id));
  return {
    items: items.map((r) => ({
      id: r.id,
      workItemId: r.workItemId ?? workItemId,
      actorId: r.actorId,
      verb: r.verb,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
    total,
  };
}

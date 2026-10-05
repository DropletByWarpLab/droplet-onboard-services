// Wire types for the native Projects (PM) surface — mirror the orchestrator's
// /api/pm/* responses (apps/orchestrator/src/services/pm/pm.service.ts).

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

/** WARP-3520 — what KIND of work an item is (orchestrator `PmWorkItemType`). */
export type WorkItemType = "task" | "bug" | "feature" | "improvement" | "question" | "incident";

/** WARP-3520 — custom-field types (orchestrator `PmPropertyType`). */
export type PropertyType =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "select"
  | "multi_select"
  | "member";

/** One choice of a select / multi_select custom field. */
export interface PmPropertyOption {
  id: string;
  label: string;
  color: string | null;
}

/** A custom-field DEFINITION on a project. `options` is null for every type
 *  except select / multi_select. */
export interface PmProperty {
  id: string;
  projectId: string;
  name: string;
  type: PropertyType;
  options: PmPropertyOption[] | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A custom-field VALUE as the API stores and returns it — type-tagged JSON,
 *  one shape per {@link PropertyType}. The orchestrator validates it; the
 *  dashboard only builds and reads it. */
export type PmPropertyValue =
  | { text: string }
  | { number: number }
  | { date: string }
  | { boolean: boolean }
  | { optionIds: string[] }
  | { userIds: string[] };

export type RelationKind = "BLOCKS" | "RELATES" | "DUPLICATES";

/** One relation, ORIENTED on the work item it was read for (the orchestrator's
 *  `ApiWorkItemRelation`). `direction` is explicit — never re-derive it. */
export interface PmRelation {
  id: string;
  kind: RelationKind;
  direction: "blocks" | "blocked_by" | "symmetric";
  relatedId: string;
  relatedKey: string;
  relatedName: string;
  relatedProjectId: string;
  crossProject: boolean;
  createdById: string | null;
  createdAt: string;
}

export interface PmWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface PmState {
  id: string;
  projectId: string;
  name: string;
  group: StateGroup;
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
}

export interface PmLabel {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

/** ADR-045 §5.3 — the department that owns a project or work item, as the PM
 *  API projects it.
 *
 *  Deliberately NOT the `Department` in `@/lib/types`: no `state`, no
 *  `provisionError`, no `quotaBytes`, no Nextcloud group. A PM surface cannot
 *  gate on a provisioning field it was never handed, which is how "the ticket
 *  is invisible because the groupfolder has not converged yet" is prevented
 *  structurally rather than by review. */
export interface PmDepartmentRef {
  id: string;
  name: string;
  kind: "HOUSEHOLD" | "DEPARTMENT" | "TEAM";
  parentId: string | null;
  /** `"item"` — this work item overrides its project's department.
   *  `"project"` — inherited from the project. Always `"project"` on a
   *  project itself. */
  source: "item" | "project";
}

export interface PmProject {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  identifier: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  leadId: string | null;
  /** ADR-045 §5.3 — the department that owns this project's work, or null. */
  department: PmDepartmentRef | null;
  /** ADR-048 — the customer this project is filed under, or null. Optional on
   *  the wire type: an orchestrator that predates the field omits it. */
  companyId?: string | null;
  archived: boolean;
  openCount: number;
  doneCount: number;
  groups: Record<StateGroup, number>;
  createdAt: string;
  updatedAt: string;
}

export interface PmWorkItem {
  id: string;
  projectId: string;
  sequenceId: number;
  key: string;
  name: string;
  descriptionHtml: string | null;
  stateId: string | null;
  state: PmState | null;
  priority: Priority;
  parentId: string | null;
  cycleId: string | null;
  /** ADR-045 §5.3 — already resolved server-side: the item's own department
   *  overriding its project's, with `source` saying which. */
  department: PmDepartmentRef | null;
  assignees: string[];
  labels: PmLabel[];
  /** WARP-3372 — a calendar date, `YYYY-MM-DD`; read it through ./date-only. */
  startDate: string | null;
  /** WARP-3372 — a calendar date, `YYYY-MM-DD`; read it through ./date-only. */
  dueDate: string | null;
  sortOrder: number;
  completedAt: string | null;
  createdById: string | null;
  commentCount: number;
  subItemCount: number;
  createdAt: string;
  updatedAt: string;
  // WARP-3520 — OPTIONAL on purpose. The orchestrator always sends them, but a
  // required field here would break every fixture that builds a `PmWorkItem`
  // literal (including other slices' tests) for no behavioural gain; readers
  // default them (`type ?? "task"`, `properties ?? {}`).
  /** What kind of work this is. Absent ⇒ "task". */
  type?: WorkItemType;
  /** Story points; null/absent ⇒ not estimated. */
  estimate?: number | null;
  /** Archived items are hidden from the board and list. */
  isArchived?: boolean;
  archivedAt?: string | null;
  /** Custom-field values keyed by property id. */
  properties?: Record<string, PmPropertyValue>;
}

export interface PmComment {
  id: string;
  workItemId: string;
  authorId: string | null;
  commentHtml: string;
  createdAt: string;
  updatedAt: string;
}

export interface PmSummary {
  activeProjects: number;
  itemsOpen: number;
  doneThisWeek: number;
  overdue: number;
}

export interface Person {
  id: string;
  name: string;
  initials: string;
  tone: number;
  /** Set only when the box has an image for this person (none does yet). */
  avatarUrl?: string;
}

/** Roles that may write PM data (mirrors requireRole on the API). */
export function canWrite(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "family";
}

/** Roles that may delete a project for good (WARP-3370, mirrors `DELETE
 *  /api/pm/projects/:id`). Members can archive and restore; they cannot destroy. */
export function canDeleteProject(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

export interface PmActivity {
  id: string;
  workItemId: string;
  actorId: string | null;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

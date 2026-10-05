// Wire types for the native Projects (PM) surface — mirror the orchestrator's
// /api/pm/* responses (apps/orchestrator/src/services/pm/pm.service.ts).

import type { PmActivityVerbName } from "@droplet/shared-types";

export type Priority = "urgent" | "high" | "medium" | "low" | "none";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

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
}

/** WARP-3519 — one emoji's tally on a comment, in allowlist order, count > 0. */
export interface PmReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface PmComment {
  id: string;
  workItemId: string;
  /** null = Droplet AI. */
  authorId: string | null;
  /** Server-sanitized HTML; "" for a tombstone. */
  commentHtml: string;
  createdAt: string;
  updatedAt: string;
  /** WARP-3519 — when the author last changed the body; null = never edited. */
  editedAt: string | null;
  /** WARP-3519 — a deleted comment stays in the thread as a tombstone. */
  deleted: boolean;
  deletedAt: string | null;
  deletedById: string | null;
  /** User ids @mentioned in the comment (derived server-side). */
  mentions: string[];
  reactions: PmReaction[];
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
  /** A newer server may send a verb this build has never heard of;
   *  `describeActivity` renders a generic sentence for it instead of crashing. */
  verb: PmActivityVerbName;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

/** WARP-3519 — the merged comment + activity stream, oldest first. */
export type PmTimelineEntry =
  | { type: "comment"; id: string; at: string; comment: PmComment }
  | { type: "activity"; id: string; at: string; activity: PmActivity };

/** Names for the ids the activity rows on a page carry — resolved server-side
 *  at read time, so a renamed state reads right and a deleted one is absent. */
export interface PmTimelineRefs {
  /** stateId → name */
  states: Record<string, string>;
  labels: Record<string, { name: string; color: string | null }>;
  /** relation_* / parent_removed targets */
  workItems: Record<string, { key: string; name: string }>;
}

export type PmWatchReason = "CREATOR" | "ASSIGNEE" | "COMMENTER" | "MENTIONED" | "MANUAL";

export interface PmWatcher {
  userId: string;
  reason: PmWatchReason;
  createdAt: string;
}

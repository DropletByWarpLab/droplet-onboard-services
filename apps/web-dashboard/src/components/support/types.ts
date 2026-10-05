// Wire types for the Support (service desk) surface — mirror the orchestrator's
// /api/support/* responses by hand (apps/orchestrator/src/services/support/
// support.types.ts is the contract; the two workspaces share no code, so a
// change there is a change here).

import type { PmDepartmentRef } from "@/components/projects/types";

export type { PmDepartmentRef };

export const SUPPORT_QUEUES = [
  "unassigned",
  "mine",
  "open",
  "pending",
  "solved_recent",
  "all",
] as const;
export type SupportQueue = (typeof SUPPORT_QUEUES)[number];

export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export type SlaClock = "RUNNING" | "PAUSED" | "STOPPED";
export type SlaStatus = "NONE" | "ON_TRACK" | "AT_RISK" | "BREACHED" | "MET" | "PAUSED";
export type TicketPriority = "urgent" | "high" | "medium" | "low" | "none";
export type TicketChannel = "EMAIL" | "INTERNAL" | "WEB_FORM" | "CHAT" | "API" | "PHONE";
export type RequesterKind = "CONTACT" | "USER";
export type CommentVisibility = "INTERNAL" | "PUBLIC";
export type AuthorKind = "USER" | "CONTACT" | "SYSTEM" | "AUTOMATION";

/** A person, resolved by the server (`Former member` when the id is gone). */
export interface SupportPerson {
  id: string;
  displayName: string;
}

export interface DeskState {
  id: string;
  name: string;
  group: StateGroup;
  slaClock: SlaClock;
  /** Data, not a token: render the value the API returns. */
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
}

export interface DeskLabel {
  id: string;
  name: string;
  color: string | null;
  /** True for the four seeded type labels (Question, Incident, Problem, Task). */
  isType: boolean;
}

/** Always `[]` until the email channel lands; the composer's copy reads off it. */
export interface DeskChannel {
  id: string;
  kind: "EMAIL";
  enabled: boolean;
}

export interface Desk {
  id: string;
  name: string;
  /** The key prefix, e.g. `SUP` -> `SUP-12`. */
  identifier: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  department: PmDepartmentRef | null;
  archived: boolean;
  states: DeskState[];
  labels: DeskLabel[];
  channels: DeskChannel[];
  createdAt: string;
  updatedAt: string;
}

export interface Requester {
  kind: RequesterKind;
  id: string;
  name: string;
  email: string | null;
  /** True when the Contact/User row no longer exists; name/email are the intake snapshot. */
  gone: boolean;
}

export interface TicketSummary {
  /** The work item id. */
  id: string;
  /** Human key, e.g. `SUP-12` — render in `--font-mono`. */
  key: string;
  deskId: string;
  deskName: string;
  subject: string;
  status: DeskState;
  priority: TicketPriority;
  assignees: SupportPerson[];
  requester: Requester;
  channel: TicketChannel;
  labels: DeskLabel[];
  department: PmDepartmentRef | null;
  slaStatus: SlaStatus;
  sla?: {
    firstResponseDueAt: string | null;
    nextResponseDueAt: string | null;
    resolutionDueAt: string | null;
    remainingBusinessMins: number | null;
    paused: boolean;
  } | null;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  reopenCount: number;
  lastPublicActivityAt: string | null;
  createdAt: string;
  /** Bumped by every change, including a reply or a note. */
  updatedAt: string;
}

export interface LinkedItem {
  relationId: string;
  /** True when the viewer lacks the Projects grant: every other field is null. */
  restricted: boolean;
  id: string | null;
  key: string | null;
  name: string | null;
  projectName: string | null;
  state: { name: string; group: StateGroup } | null;
}

export interface RequesterCard extends Requester {
  organization: string | null;
  phone: string | null;
  company: { id: string; name: string } | null;
}

export interface Ticket extends TicketSummary {
  descriptionHtml: string | null;
  createdBy: SupportPerson | null;
  requesterCard: RequesterCard;
  linkedItems: LinkedItem[];
}

export interface TicketList {
  tickets: TicketSummary[];
  total: number;
  nextCursor: string | null;
}

export type QueueCounts = Record<SupportQueue, number>;

export type ConversationEntry =
  | {
      type: "comment";
      id: string;
      visibility: CommentVisibility;
      authorKind: AuthorKind;
      author: SupportPerson | null;
      html: string;
      createdAt: string;
    }
  | {
      type: "activity";
      id: string;
      verb: string;
      field: string | null;
      from: string | null;
      to: string | null;
      actor: SupportPerson | null;
      createdAt: string;
    };

export type CommentEntry = Extract<ConversationEntry, { type: "comment" }>;

export interface Conversation {
  entries: ConversationEntry[];
  truncated: boolean;
}

export interface ContactCandidate {
  id: string;
  name: string;
  email: string | null;
  organization: string | null;
  via: "yours" | "customer" | "requester";
}

export interface Escalation {
  workItem: { id: string; key: string; name: string; projectId: string; projectName: string };
  ticket: Ticket;
}

// ── Request bodies ──────────────────────────────────────────────────────────

export type TicketRequesterInput =
  | { kind: "CONTACT"; contactId: string }
  | { kind: "USER"; userId?: string };

export interface CreateTicketInput {
  deskId: string;
  subject: string;
  descriptionHtml?: string;
  requester?: TicketRequesterInput;
  channel?: "INTERNAL" | "PHONE";
  stateId?: string;
  priority?: TicketPriority;
  assigneeIds?: string[];
  labelIds?: string[];
  departmentId?: string;
  companyId?: string;
}

export interface UpdateTicketInput {
  subject?: string;
  descriptionHtml?: string | null;
  stateId?: string;
  priority?: TicketPriority;
  assigneeIds?: string[];
  departmentId?: string | null;
  labelIds?: string[];
  companyId?: string | null;
}

export interface CreateDeskInput {
  name: string;
  identifier?: string;
  description?: string;
  icon?: string;
  color?: string;
  departmentId?: string;
}

export interface UpdateDeskInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  departmentId?: string | null;
  archived?: boolean;
}

export interface CreateContactInput {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  phone?: string;
  organization?: string;
}

/** Everyone who may use /support is owner, admin or family (a guest holds
 *  nothing, and the box answers 404 before any of this renders). */
export function canWrite(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "family";
}

/** Desk setup is admin work (the `manage` level floors at admin). */
export function canManageDesks(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

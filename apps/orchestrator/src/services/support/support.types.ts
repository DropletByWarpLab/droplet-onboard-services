/**
 * Service desk (ADR-069, WS-12 / WARP-3528) — the wire contract of `/api/support/*`.
 *
 * Types and constants only: no I/O, nothing that can drift from the rows. The
 * services build these shapes, the routes serialise them, and the dashboard's
 * `components/support/types.ts` mirrors them by hand (the two workspaces share
 * no code), so a change here is a change to both.
 *
 * Conventions, all inherited from the PM surface it sits beside:
 *   - request bodies and responses are camelCase (the CRM routes' casing);
 *   - an id the service cannot resolve to a person is `Former member`, never a
 *     raw `User 1a2b` (WARP-3372) — names are resolved server-side;
 *   - timestamps are ISO strings;
 *   - errors are `{ error: <code> }` with the codes in {@link SUPPORT_ERRORS}
 *     (and the PM / department codes the shared helpers throw).
 */
import type { PmDepartmentRef } from "../pm/pm-department.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The system queues, in the order the rail shows them. Each is a named
 *  predicate over explicit columns (`state.group`, `state.slaClock`, the
 *  assignee set, `ticket.solvedAt`) — never over a state's NAME, because a desk
 *  may rename "Pending" (ADR-069 §5). */
export const SUPPORT_QUEUES = [
  "unassigned",
  "mine",
  "open",
  "pending",
  "solved_recent",
  "all",
] as const;
export type SupportQueue = (typeof SUPPORT_QUEUES)[number];

/** `solved_recent` is "solved in the last N days". */
export const SOLVED_RECENT_DAYS = 7;

export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
export type SlaClock = "RUNNING" | "PAUSED" | "STOPPED";
export type SlaStatus = "NONE" | "ON_TRACK" | "AT_RISK" | "BREACHED" | "MET" | "PAUSED";
export type TicketPriority = "urgent" | "high" | "medium" | "low" | "none";
export type TicketChannel = "EMAIL" | "INTERNAL" | "WEB_FORM" | "CHAT" | "API" | "PHONE";
export type RequesterKind = "CONTACT" | "USER";
export type CommentVisibility = "INTERNAL" | "PUBLIC";
export type AuthorKind = "USER" | "CONTACT" | "SYSTEM" | "AUTOMATION";

/** Channels a member of staff may stamp on a ticket they file by hand. The rest
 *  (EMAIL, WEB_FORM, CHAT, API) are produced only by the path that owns them —
 *  email intake, the assistant, an API token — and a person cannot forge one. */
export const STAFF_TICKET_CHANNELS = ["INTERNAL", "PHONE"] as const;
export type StaffTicketChannel = (typeof STAFF_TICKET_CHANNELS)[number];

// ── What a new desk is seeded with (ADR-069 §5, WS-12 data) ─────────────────
// Colours are DATA, stored on the row like `DEFAULT_STATES` in pm.service.ts —
// the dashboard renders what the API returns and never hard-codes them.

export interface DeskStateSeed {
  name: string;
  group: StateGroup;
  slaClock: SlaClock;
  color: string;
  sortOrder: number;
  isDefault: boolean;
}

export const DESK_STATES: ReadonlyArray<DeskStateSeed> = [
  { name: "New", group: "unstarted", slaClock: "RUNNING", color: "#6366f1", sortOrder: 0, isDefault: true },
  { name: "Open", group: "started", slaClock: "RUNNING", color: "#f59e0b", sortOrder: 1, isDefault: false },
  { name: "Pending", group: "started", slaClock: "PAUSED", color: "#0ea5e9", sortOrder: 2, isDefault: false },
  { name: "On hold", group: "started", slaClock: "PAUSED", color: "#94a3b8", sortOrder: 3, isDefault: false },
  { name: "Solved", group: "completed", slaClock: "STOPPED", color: "#22c55e", sortOrder: 4, isDefault: false },
  { name: "Closed", group: "completed", slaClock: "STOPPED", color: "#64748b", sortOrder: 5, isDefault: false },
];

/** The four labels a desk is seeded with. They double as the ticket TYPE: a
 *  ticket's "type" is the one of these it carries. Until WS-4 gives every work
 *  item a `type` column this is the explicit definition — the same constant
 *  seeds the labels and flags them `isType` in the API, so nothing downstream
 *  guesses by name. A desk's labels are not editable in this slice, so the names
 *  cannot drift from it. */
export const TICKET_TYPE_LABELS = ["Question", "Incident", "Problem", "Task"] as const;

export const DESK_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: "Question", color: "#6366f1" },
  { name: "Incident", color: "#ef4444" },
  { name: "Problem", color: "#f59e0b" },
  { name: "Task", color: "#22c55e" },
];

// ── Stable error codes ───────────────────────────────────────────────────────
// Thrown as `Error(code)`; the route's `mapSupportError` is the one place that
// knows the HTTP status. The PM and department codes the shared helpers throw
// (`state_not_found`, `department_not_found`, `concurrent_mutation`,
// `identifier_taken`, …) pass through unchanged.

export const SUPPORT_ERRORS = {
  /** 404 — no such desk, or the id names a project. */
  DESK_NOT_FOUND: "desk_not_found",
  /** 404 — no such ticket, or the id names a project work item. */
  TICKET_NOT_FOUND: "ticket_not_found",
  /** 404 — the requester contact does not exist or is not visible to the caller. */
  CONTACT_NOT_FOUND: "contact_not_found",
  /** 404 — the escalation target is not a project the caller can reach. */
  PROJECT_NOT_FOUND: "project_not_found",
  /** 404 — a label / state / company id that does not exist. */
  LABEL_NOT_FOUND: "label_not_found",
  STATE_NOT_FOUND: "state_not_found",
  COMPANY_NOT_FOUND: "company_not_found",
  /** 422 — the state / label belongs to another desk. */
  INVALID_STATE: "invalid_state",
  INVALID_LABEL: "invalid_label",
  /** 422 — an assignee who is not an active member holding the support grant. */
  INVALID_ASSIGNEE: "invalid_assignee",
  /** 422 — a USER requester who is not an active member. */
  INVALID_REQUESTER: "invalid_requester",
  /** 422 — channel other than INTERNAL / PHONE on a hand-filed ticket. */
  INVALID_CHANNEL: "invalid_channel",
  /** 409 — a new ticket in an archived desk. */
  DESK_ARCHIVED: "desk_archived",
  /** 409 — another contact the caller can see already has this address. */
  CONTACT_EMAIL_EXISTS: "contact_email_exists",
} as const;

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A person, resolved server-side. `displayName` is `Former member` when the
 *  id no longer names a user. */
export interface ApiPerson {
  id: string;
  displayName: string;
}

export interface ApiDeskState {
  id: string;
  name: string;
  group: StateGroup;
  slaClock: SlaClock;
  /** Data, not a token: render the value the API returns. */
  color: string | null;
  sortOrder: number;
  isDefault: boolean;
}

export interface ApiDeskLabel {
  id: string;
  name: string;
  color: string | null;
  /** True for the four seeded type labels ({@link TICKET_TYPE_LABELS}). */
  isType: boolean;
}

/** A channel bound to a desk. Always `[]` in WS-12 — the email channel (WS-13)
 *  is what fills it — but it is in the contract now so the composer's "connect
 *  an email channel" copy reads off data rather than a guess. */
export interface ApiDeskChannel {
  id: string;
  kind: "EMAIL";
  enabled: boolean;
}

export interface ApiDesk {
  id: string;
  name: string;
  /** The key prefix, e.g. `SUP` → `SUP-12`. */
  identifier: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  department: PmDepartmentRef | null;
  archived: boolean;
  states: ApiDeskState[];
  labels: ApiDeskLabel[];
  channels: ApiDeskChannel[];
  createdAt: string;
  updatedAt: string;
}

/** Who asked. `name` / `email` are the live Contact or User while it exists and
 *  the intake snapshot (`PmTicket.requesterName` / `requesterEmail`) once it is
 *  gone — `gone` says which. Never a blank line, never an invented person. */
export interface ApiRequester {
  kind: RequesterKind;
  /** The stored `Contact.id` / `User.id`. */
  id: string;
  name: string;
  email: string | null;
  gone: boolean;
}

export interface ApiTicketSummary {
  /** The work item id. */
  id: string;
  /** The human key, e.g. `SUP-12`. */
  key: string;
  deskId: string;
  deskName: string;
  subject: string;
  status: ApiDeskState;
  priority: TicketPriority;
  assignees: ApiPerson[];
  requester: ApiRequester;
  channel: TicketChannel;
  labels: ApiDeskLabel[];
  /** Already resolved: the item's own department, else the desk's. */
  department: PmDepartmentRef | null;
  slaStatus: SlaStatus;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  reopenCount: number;
  lastPublicActivityAt: string | null;
  createdAt: string;
  /** Bumped by every change, including a reply or a note — the list's "last update". */
  updatedAt: string;
}

/** A PM work item linked to a ticket (an escalation). Needs the Projects grant
 *  to read; without it the item is `restricted` and names nothing. */
export interface ApiLinkedItem {
  relationId: string;
  restricted: boolean;
  id: string | null;
  key: string | null;
  name: string | null;
  projectName: string | null;
  state: { name: string; group: StateGroup } | null;
}

export interface ApiRequesterCard extends ApiRequester {
  organization: string | null;
  phone: string | null;
  /** The customer the ticket is filed under — `PmTicket.companyId`. Null when
   *  the requester has several or none: a human sets it, nothing guesses. */
  company: { id: string; name: string } | null;
}

export interface ApiTicket extends ApiTicketSummary {
  descriptionHtml: string | null;
  /** Who logged it: the member who filed it by hand, or null for the system. */
  createdBy: ApiPerson | null;
  requesterCard: ApiRequesterCard;
  linkedItems: ApiLinkedItem[];
}

export interface ApiTicketList {
  tickets: ApiTicketSummary[];
  /** Exact count of the tickets the filter matches, not of this page. */
  total: number;
  /** Opaque; null at the end. Pass back as `cursor`. */
  nextCursor: string | null;
}

export type ApiQueueCounts = Record<SupportQueue, number>;

/** One entry of a ticket's conversation, oldest first. */
export type ApiConversationEntry =
  | {
      type: "comment";
      id: string;
      visibility: CommentVisibility;
      authorKind: AuthorKind;
      /** Null for SYSTEM / AUTOMATION. For a CONTACT it is the requester. */
      author: ApiPerson | null;
      html: string;
      createdAt: string;
    }
  | {
      type: "activity";
      id: string;
      verb: string;
      field: string | null;
      /** Already resolved to words — a state name, a person's name, a priority. */
      from: string | null;
      to: string | null;
      actor: ApiPerson | null;
      createdAt: string;
    };

export interface ApiConversation {
  entries: ApiConversationEntry[];
  /** True when older entries were cut to keep the response bounded. */
  truncated: boolean;
}

export interface ApiContactCandidate {
  id: string;
  name: string;
  email: string | null;
  organization: string | null;
  /** Why the caller can see them: their own address book, a customer's
   *  people, or someone who has already raised a ticket. */
  via: "yours" | "customer" | "requester";
}

export interface ApiEscalation {
  workItem: { id: string; key: string; name: string; projectId: string; projectName: string };
  ticket: ApiTicket;
}

// ── Service inputs (what the routes hand the services) ───────────────────────
// The routes validate with zod and build these; the services trust their shape
// and re-check every id against the database.

/** The acting member. Never the MCP service principal: `/api/support/*` admits
 *  human roles only until the assistant's ticket tools land (WS-15). */
export interface SupportViewer {
  id: string;
  role: "owner" | "admin" | "family";
}

/** What a request knows about the caller that the services cannot look up
 *  cheaply themselves: which neighbouring grants they hold. A linked work item
 *  is masked (`restricted`) unless they hold Projects (ADR-069 §1: "degrades to
 *  linked item (no access)"), and the customer record's data — which contacts
 *  belong to a customer, a customer's name — is the CRM's, so Support shows it
 *  only to a person who holds the CRM grant too. */
export interface SupportCtx {
  canReadProjects: boolean;
  canReadCrm: boolean;
}

export interface DeskCreateInput {
  name: string;
  /** 1-10 alphanumerics; derived from the name when omitted, like a project's. */
  identifier?: string;
  description?: string;
  icon?: string;
  color?: string;
  departmentId?: string;
}

export interface DeskUpdateInput {
  name?: string;
  /** `null` clears; omitted leaves alone (Prisma skips `undefined` — never `?? undefined` on a clear). */
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  departmentId?: string | null;
  archived?: boolean;
}

export interface TicketListQuery {
  /** Narrow to one desk; omitted = every desk that is not archived. */
  deskId?: string;
  /** Defaults to `open`. */
  queue?: SupportQueue;
  /** Free text over subject, description, key and the requester's name / email. */
  q?: string;
  stateId?: string;
  priority?: TicketPriority;
  assigneeId?: string;
  /** 1-200, default 50. */
  limit?: number;
  cursor?: string;
}

export type TicketRequesterInput =
  | { kind: "CONTACT"; contactId: string }
  /** `userId` omitted = the caller themselves. */
  | { kind: "USER"; userId?: string };

export interface TicketCreateInput {
  deskId: string;
  subject: string;
  descriptionHtml?: string;
  /** Omitted = the caller themselves as a USER requester. */
  requester?: TicketRequesterInput;
  /** INTERNAL or PHONE only ({@link STAFF_TICKET_CHANNELS}); default INTERNAL. */
  channel?: StaffTicketChannel;
  stateId?: string;
  priority?: TicketPriority;
  assigneeIds?: string[];
  labelIds?: string[];
  departmentId?: string;
  companyId?: string;
}

export interface TicketUpdateInput {
  subject?: string;
  descriptionHtml?: string | null;
  stateId?: string;
  priority?: TicketPriority;
  /** The complete desired set; omitted leaves it alone. */
  assigneeIds?: string[];
  /** `null` clears the override so the ticket inherits the desk's department. */
  departmentId?: string | null;
  labelIds?: string[];
  companyId?: string | null;
}

export interface ConversationInput {
  bodyHtml: string;
  /** Move the ticket to this state in the same transaction ("send and set to Pending"). */
  stateId?: string;
}

export interface EscalateInput {
  projectId: string;
  /** The work item's title. Defaults to `Escalated from SUP-12` — never the
   *  ticket's subject: the agent chooses what leaves the desk (the dialog
   *  pre-fills the subject and lets them edit it). */
  title?: string;
}

export interface RequesterContactInput {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  phone?: string;
  organization?: string;
}

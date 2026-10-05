/**
 * Payload v1 — the JSON body of a work-event webhook (WARP-3532).
 * Documented for receivers in docs/work-webhooks.md; this file is the contract
 * that document describes, and `webhook-payload.test.ts` pins both.
 *
 * Built ONCE at fan-out and stored on the delivery row, so every retry, every
 * re-delivery and every chat-app rendering of one event says the same thing. It
 * therefore reflects the work item as it was when the event was PROCESSED — a few
 * seconds after it happened (the outbox settle window) — while `changes` carries
 * the event's own before/after.
 *
 * What is deliberately NOT in it:
 *   - comment text. The `commented` activity row does not point at its comment,
 *     and comments are where customer data lives; the receiver follows `url`.
 *   - the work item's description, labels or custom fields.
 *   - anyone's email or username: an actor and an assignee are `{ id, name }`.
 * Adding to v1 is compatible; removing or retyping is a v2.
 */

export const WEBHOOK_PAYLOAD_VERSION = 1 as const;

export interface WebhookChange {
  /** What changed: `state`, `priority`, `assignees`, `dueDate`, `department`,
   *  `relation` (`KIND:<work item id>`), `parentId`, … */
  field: string;
  from: string | null;
  to: string | null;
  /** Human-readable form of `from` / `to` when those are identifiers (a state
   *  id, a user id). Absent when the value already reads as itself. */
  fromLabel?: string | null;
  toLabel?: string | null;
}

export interface WebhookPayloadV1 {
  version: typeof WEBHOOK_PAYLOAD_VERSION;
  /** The event's id. Stable across retries, re-deliveries and webhooks, so a
   *  receiver de-duplicates on it. For work-item events it is the PmActivity
   *  row's id. */
  id: string;
  event: string;
  /** When the change was recorded (ISO 8601, UTC). */
  occurredAt: string;
  workspace: { id: string; slug: string; name: string };
  project: { id: string; identifier: string; name: string } | null;
  workItem: {
    id: string;
    /** `ENG-12`. */
    key: string;
    name: string;
    /** Deep link into the dashboard (`/projects?p=ENG&item=ENG-12`), on the
     *  box's own canonical address — reachable from the LAN or the VPN, not the
     *  internet. */
    url: string;
    state: { id: string; name: string; group: string } | null;
    priority: string;
    assignees: Array<{ id: string; name: string | null }>;
    /** Calendar dates, `YYYY-MM-DD`. */
    startDate: string | null;
    dueDate: string | null;
  } | null;
  actor: { kind: "user" | "system"; id: string | null; name: string | null };
  changes: WebhookChange[];
}

/** `2026-10-10T00:00:00.000Z` → `2026-10-10`. Anything else is returned as is. */
function dateOnly(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(value) ? value.slice(0, 10) : value;
}

export interface WorkItemPayloadInput {
  eventId: string;
  event: string;
  occurredAt: Date;
  /** Origin the deep link is built on, no trailing slash. */
  origin: string;
  workspace: { id: string; slug: string; name: string };
  project: { id: string; identifier: string; name: string };
  item: {
    id: string;
    sequenceId: number;
    name: string;
    priority: string;
    startDate: Date | null;
    dueDate: Date | null;
    state: { id: string; name: string; group: string } | null;
    assignees: ReadonlyArray<{ userId: string }>;
  };
  actor: { id: string | null; name: string | null };
  /** The PmActivity row's own diff. */
  activity: { field: string | null; oldValue: string | null; newValue: string | null };
  /** userId → display name, for actors and assignees. A missing id is `null`. */
  userNames: ReadonlyMap<string, string>;
  /** stateId → name, for `state` changes. */
  stateNames: ReadonlyMap<string, string>;
}

export function workItemUrl(origin: string, identifier: string, key: string): string {
  const q = new URLSearchParams({ p: identifier, item: key });
  return `${origin}/projects?${q.toString()}`;
}

function changesOf(input: WorkItemPayloadInput): WebhookChange[] {
  const { field, oldValue, newValue } = input.activity;
  // `fields` is pm.service's residual bucket (name, description, start date,
  // labels) and carries no values: reporting it as a change would be an
  // internal token with nothing behind it.
  if (!field || field === "fields") return [];
  const change: WebhookChange = {
    field,
    from: field === "dueDate" ? dateOnly(oldValue) : oldValue,
    to: field === "dueDate" ? dateOnly(newValue) : newValue,
  };
  if (field === "state") {
    change.fromLabel = oldValue ? (input.stateNames.get(oldValue) ?? null) : null;
    change.toLabel = newValue ? (input.stateNames.get(newValue) ?? null) : null;
  } else if (field === "assignees") {
    change.fromLabel = oldValue ? (input.userNames.get(oldValue) ?? null) : null;
    change.toLabel = newValue ? (input.userNames.get(newValue) ?? null) : null;
  }
  return [change];
}

export function buildWorkItemPayload(input: WorkItemPayloadInput): WebhookPayloadV1 {
  const key = `${input.project.identifier}-${input.item.sequenceId}`;
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    id: input.eventId,
    event: input.event,
    occurredAt: input.occurredAt.toISOString(),
    workspace: input.workspace,
    project: input.project,
    workItem: {
      id: input.item.id,
      key,
      name: input.item.name,
      url: workItemUrl(input.origin, input.project.identifier, key),
      state: input.item.state,
      priority: input.item.priority,
      assignees: input.item.assignees.map((a) => ({
        id: a.userId,
        name: input.userNames.get(a.userId) ?? null,
      })),
      startDate: input.item.startDate ? input.item.startDate.toISOString().slice(0, 10) : null,
      dueDate: input.item.dueDate ? input.item.dueDate.toISOString().slice(0, 10) : null,
    },
    actor: input.actor.id
      ? { kind: "user", id: input.actor.id, name: input.actor.name }
      : { kind: "system", id: null, name: null },
    changes: changesOf(input),
  };
}

/** The body of `POST /webhooks/:id/test`: the same envelope with nothing in it. */
export function buildTestPayload(input: {
  eventId: string;
  event: string;
  occurredAt: Date;
  workspace: { id: string; slug: string; name: string };
  actor: { id: string | null; name: string | null };
}): WebhookPayloadV1 {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    id: input.eventId,
    event: input.event,
    occurredAt: input.occurredAt.toISOString(),
    workspace: input.workspace,
    project: null,
    workItem: null,
    actor: input.actor.id
      ? { kind: "user", id: input.actor.id, name: input.actor.name }
      : { kind: "system", id: null, name: null },
    changes: [],
  };
}

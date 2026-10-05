/**
 * The vocabulary of work-event webhooks (WARP-3532, ADR-069 §9).
 *
 * One PmActivity row produces exactly ONE event, for two reasons that are the
 * same reason: a delivery is keyed `(webhook, activity row)`, so a replayed
 * outbox row cannot deliver twice, and a receiver subscribed to everything never
 * hears one change twice. That makes the events a partition of the verbs, not an
 * umbrella and its specialisations:
 *
 *   created                         work_item.created
 *   state_changed                   work_item.state_changed
 *   assigned                        work_item.assigned
 *   commented                       work_item.commented
 *   archived                        work_item.archived
 *   everything else                 work_item.updated  (with `changes`)
 *
 * `unassigned` is deliberately in the last row, not under `assigned`: an event
 * named "assigned" that also means "someone was taken off" would be a lie the
 * receiver has to special-case. Subscribe to `work_item.updated` for it.
 *
 * `Record<PmActivityVerb, …>` makes the mapping exhaustive at compile time: a
 * verb added to the enum (WS-2's `comment_edited`, WS-3's `attachment_added`)
 * fails the build here until somebody decides which event it is.
 */
import type { PmActivityVerb } from "@prisma/client";

/** Events that fire today, and that a webhook may subscribe to. */
export const WORK_ITEM_EVENTS = [
  "work_item.created",
  "work_item.updated",
  "work_item.state_changed",
  "work_item.assigned",
  "work_item.commented",
  "work_item.archived",
] as const;
export type WorkItemEvent = (typeof WORK_ITEM_EVENTS)[number];

/**
 * RESERVED, not emitted. The SLA engine (WS-14) raises these from its own tick —
 * they are not PmActivity rows — through `enqueueWebhookDeliveries`
 * (webhook-fanout.ts), which takes a caller-chosen idempotence key for exactly
 * that. They join `SUBSCRIBABLE_EVENTS` in the same PR that starts emitting them.
 */
export const SLA_EVENTS = ["sla.at_risk", "sla.breached"] as const;

/**
 * RESERVED, not emitted. WS-13 and WS-14 add these through the Support surface.
 * The work-item fan-out and webhook management range only over PROJECT rows;
 * SERVICE_DESK items never produce `work_item.*` events.
 */
export const TICKET_EVENTS = ["ticket.created", "ticket.replied", "ticket.solved"] as const;

/** What `POST /webhooks/:id/test` sends. Never subscribable; never a PmActivity. */
export const WEBHOOK_TEST_EVENT = "webhook.test" as const;

/** The only names a webhook may subscribe to. Today: the work-item events. */
export const SUBSCRIBABLE_EVENTS: readonly string[] = WORK_ITEM_EVENTS;

export function isSubscribableEvent(name: string): name is WorkItemEvent {
  return (SUBSCRIBABLE_EVENTS as readonly string[]).includes(name);
}

/** What the event picker shows. Plain language, no jargon (brief §6). */
export const WORK_EVENT_CATALOG: ReadonlyArray<{
  name: WorkItemEvent;
  label: string;
  description: string;
}> = [
  { name: "work_item.created", label: "Created", description: "A work item is created." },
  {
    name: "work_item.state_changed",
    label: "Moved to another state",
    description: "A work item moves between states, such as To do to Done.",
  },
  { name: "work_item.assigned", label: "Assigned", description: "Someone is assigned to a work item." },
  { name: "work_item.commented", label: "Commented", description: "Someone comments on a work item." },
  {
    name: "work_item.updated",
    label: "Changed",
    description:
      "Anything else changes: title, description, priority, due date, labels, someone taken off, relations.",
  },
  { name: "work_item.archived", label: "Archived", description: "A work item is archived." },
];

const VERB_EVENT: Record<PmActivityVerb, WorkItemEvent> = {
  created: "work_item.created",
  state_changed: "work_item.state_changed",
  assigned: "work_item.assigned",
  commented: "work_item.commented",
  archived: "work_item.archived",
  updated: "work_item.updated",
  unassigned: "work_item.updated",
  priority_changed: "work_item.updated",
  due_date_changed: "work_item.updated",
  start_date_changed: "work_item.updated",
  type_changed: "work_item.updated",
  estimate_changed: "work_item.updated",
  property_changed: "work_item.updated",
  title_changed: "work_item.updated",
  description_changed: "work_item.updated",
  label_added: "work_item.updated",
  label_removed: "work_item.updated",
  restored: "work_item.updated",
  cycle_added: "work_item.updated",
  cycle_removed: "work_item.updated",
  parent_removed: "work_item.updated",
  module_added: "work_item.updated",
  module_removed: "work_item.updated",
  relation_added: "work_item.updated",
  relation_removed: "work_item.updated",
  time_logged: "work_item.updated",
  time_log_updated: "work_item.updated",
  time_log_removed: "work_item.updated",
};

export function eventForVerb(verb: PmActivityVerb): WorkItemEvent {
  return VERB_EVENT[verb];
}

/**
 * Event fan-out: PmActivity row → one delivery per interested webhook
 * (WARP-3532, ADR-069 §7 + §9).
 *
 * This is the `webhooks` consumer on the outbox framework (pm-outbox.ts). It
 * decides WHO hears about an event and writes down what they will be told; the
 * delivery worker (webhook-delivery.service.ts) does the telling.
 *
 * Idempotent, because the framework is at-least-once: a delivery's key is
 * `(webhookId, "activity:<row id>")` and the insert is `skipDuplicates`, so
 * handling the same row twice creates nothing the second time.
 *
 * Cheapest exit first. A box with no webhooks — nearly every box — pays one tiny
 * indexed query per activity row and nothing else: the work item, its project and
 * the people's names are loaded only once some enabled webhook has subscribed to
 * this event.
 *
 * `enqueueWebhookDeliveries` is the same last step, exported for events that are
 * not PmActivity rows. WS-14's SLA transitions come from a tick, not a write; it
 * calls this with its own idempotence key (`sla:<ticket>:<kind>:<n>`).
 */
import type { PmActivity, Prisma, PrismaClient } from "@prisma/client";
import { boxDisplayName } from "../../lib/box-identity.js";
import { resolveTrustedOrigin } from "../../lib/trusted-origin.js";
import type { OutboxConsumer } from "./pm-outbox.js";
import { eventForVerb } from "./webhook-events.js";
import { buildWorkItemPayload, type WebhookPayloadV1 } from "./webhook-payload.js";

type FanOutPrisma = Pick<
  PrismaClient,
  "pmWebhook" | "pmWebhookDelivery" | "pmWorkItem" | "pmState" | "user"
>;

interface Candidate {
  id: string;
  workspaceId: string;
  projectId: string | null;
}

/** Enabled webhooks subscribed to `event`, in any workspace. Tiny table, indexed. */
async function subscribedTo(prisma: FanOutPrisma, event: string): Promise<Candidate[]> {
  return prisma.pmWebhook.findMany({
    where: { enabled: true, events: { has: event } },
    select: { id: true, workspaceId: true, projectId: true },
  });
}

/** A workspace-wide webhook (`projectId` null) hears every project in it; a
 *  project-scoped one hears only its own. */
function inScope(c: Candidate, workspaceId: string, projectId: string | null): boolean {
  if (c.workspaceId !== workspaceId) return false;
  return c.projectId === null || c.projectId === projectId;
}

async function createDeliveries(
  prisma: FanOutPrisma,
  webhookIds: readonly string[],
  event: string,
  payload: WebhookPayloadV1,
  sourceKey: string,
  now: Date,
): Promise<number> {
  if (webhookIds.length === 0) return 0;
  const { count } = await prisma.pmWebhookDelivery.createMany({
    data: webhookIds.map((webhookId) => ({
      webhookId,
      event,
      payload: payload as unknown as Prisma.InputJsonValue,
      sourceKey,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
  return count;
}

/**
 * Queue `payload` for every enabled webhook subscribed to `event` in this
 * workspace (and project). `sourceKey` makes it idempotent per webhook.
 * Returns how many deliveries were created.
 */
export async function enqueueWebhookDeliveries(
  prisma: FanOutPrisma,
  input: {
    workspaceId: string;
    projectId: string | null;
    event: string;
    payload: WebhookPayloadV1;
    sourceKey: string;
    now?: Date;
  },
): Promise<number> {
  const candidates = await subscribedTo(prisma, input.event);
  const ids = candidates
    .filter((c) => inScope(c, input.workspaceId, input.projectId))
    .map((c) => c.id);
  return createDeliveries(prisma, ids, input.event, input.payload, input.sourceKey, input.now ?? new Date());
}

/** The address the deep link is built on, with no request to read it from. */
async function linkOrigin(): Promise<string> {
  const origin = await resolveTrustedOrigin();
  if (origin.canonicalHost) {
    return `${origin.canonicalIsHttps ? "https" : "http"}://${origin.canonicalHost}`;
  }
  return `https://${boxDisplayName()}`;
}

export interface FanOutDeps {
  now?: () => Date;
  /** Seam for the deep-link origin. */
  origin?: () => Promise<string>;
  /** Called after deliveries were queued, so the delivery worker can run now
   *  instead of waiting out its interval. Must not throw. */
  onQueued?: () => void;
}

/**
 * Handle one PmActivity row. Returns how many deliveries it queued.
 */
export async function fanOutActivity(
  prisma: FanOutPrisma,
  row: PmActivity,
  deps: FanOutDeps = {},
): Promise<number> {
  // Detached deletion tombstones belong only to pm-live; never turn one into
  // a webhook event or try to load the deleted work item.
  if (!row.workItemId) return 0;
  const event = eventForVerb(row.verb);
  const candidates = await subscribedTo(prisma, event);
  if (candidates.length === 0) return 0;

  const item = await prisma.pmWorkItem.findUnique({
    where: { id: row.workItemId },
    include: { project: { include: { workspace: true } }, state: true, assignees: true },
  });
  // Deleted between the write and now. Its activity rows cascade with it, so
  // there is nothing left to describe.
  if (!item) return 0;

  const { project } = item;
  const matched = candidates.filter((c) => inScope(c, project.workspaceId, project.id));
  if (matched.length === 0) return 0;

  const userIds = new Set<string>(item.assignees.map((a) => a.userId));
  if (row.actorId) userIds.add(row.actorId);
  if (row.field === "assignees") {
    if (row.oldValue) userIds.add(row.oldValue);
    if (row.newValue) userIds.add(row.newValue);
  }
  const stateIds = new Set<string>();
  if (row.field === "state") {
    if (row.oldValue) stateIds.add(row.oldValue);
    if (row.newValue) stateIds.add(row.newValue);
  }
  const [users, states, origin] = await Promise.all([
    userIds.size > 0
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, displayName: true },
        })
      : Promise.resolve([]),
    stateIds.size > 0
      ? prisma.pmState.findMany({ where: { id: { in: [...stateIds] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
    (deps.origin ?? linkOrigin)(),
  ]);
  const userNames = new Map(users.map((u) => [u.id, u.displayName]));

  const payload = buildWorkItemPayload({
    eventId: row.id,
    event,
    occurredAt: row.createdAt,
    origin,
    workspace: {
      id: project.workspace.id,
      slug: project.workspace.slug,
      name: project.workspace.name,
    },
    project: { id: project.id, identifier: project.identifier, name: project.name },
    item: {
      id: item.id,
      sequenceId: item.sequenceId,
      name: item.name,
      priority: item.priority,
      startDate: item.startDate,
      dueDate: item.dueDate,
      state: item.state ? { id: item.state.id, name: item.state.name, group: item.state.group } : null,
      assignees: item.assignees,
    },
    actor: { id: row.actorId, name: row.actorId ? (userNames.get(row.actorId) ?? null) : null },
    activity: { field: row.field, oldValue: row.oldValue, newValue: row.newValue },
    userNames,
    stateNames: new Map(states.map((s) => [s.id, s.name])),
  });

  const queued = await createDeliveries(
    prisma,
    matched.map((c) => c.id),
    event,
    payload,
    `activity:${row.id}`,
    (deps.now ?? (() => new Date()))(),
  );
  if (queued > 0) deps.onQueued?.();
  return queued;
}

/** The `webhooks` outbox consumer; index.ts registers it. */
export function createWebhookFanOutConsumer(
  prisma: PrismaClient,
  deps: FanOutDeps = {},
): OutboxConsumer {
  return {
    name: "webhooks",
    intervalMs: 5_000,
    handle: async (row) => {
      await fanOutActivity(prisma, row, deps);
    },
  };
}

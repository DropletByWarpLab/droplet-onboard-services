/**
 * WARP-3532 — event fan-out: one PmActivity row → one delivery per interested
 * webhook, idempotently. In-memory Prisma; the (webhookId, sourceKey) unique
 * index that makes the replay safe in the database is `pm-webhook.pg.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import type { PmActivity } from "@prisma/client";
import {
  createWebhookFanOutConsumer,
  enqueueWebhookDeliveries,
  fanOutActivity,
} from "./webhook-fanout.js";
import { buildTestPayload } from "./webhook-payload.js";

const T0 = new Date("2026-10-04T12:00:00.000Z");

interface HookRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  enabled: boolean;
  events: string[];
}

function activity(over: Partial<PmActivity> = {}): PmActivity {
  return {
    id: "act-1",
    workItemId: "wi-1",
    actorId: "u-1",
    verb: "state_changed",
    field: "state",
    oldValue: "s-1",
    newValue: "s-2",
    notifyStatus: "pending",
    notifiedAt: null,
    createdAt: T0,
    ...over,
  } as PmActivity;
}

const ITEM = {
  id: "wi-1",
  projectId: "p-1",
  sequenceId: 12,
  name: "Fix the login bug",
  priority: "high",
  startDate: null,
  dueDate: null,
  state: { id: "s-2", name: "In progress", group: "started" },
  assignees: [{ userId: "u-2" }],
  project: {
    id: "p-1",
    kind: "PROJECT" as "PROJECT" | "SERVICE_DESK",
    workspaceId: "ws-1",
    identifier: "ENG",
    name: "Engineering",
    workspace: { id: "ws-1", slug: "home", name: "Home" },
  },
};

function makePrisma(hooks: HookRow[], item: typeof ITEM | null = ITEM) {
  const deliveries: Array<Record<string, unknown>> = [];
  const prisma = {
    deliveries,
    pmWebhook: {
      findMany: vi.fn(async ({ where }: { where: { enabled: boolean; events: { has: string } } }) =>
        hooks.filter((h) => h.enabled === where.enabled && h.events.includes(where.events.has)),
      ),
    },
    pmWorkItem: { findFirst: vi.fn(async ({ where }: { where: { project: { is: { kind: string } } } }) =>
      item?.project.kind === where.project.is.kind ? item : null) },
    user: {
      findMany: vi.fn(async () => [
        { id: "u-1", displayName: "Ana Cruz" },
        { id: "u-2", displayName: "Ben Ortiz" },
      ]),
    },
    pmState: {
      findMany: vi.fn(async () => [
        { id: "s-1", name: "Todo" },
        { id: "s-2", name: "In progress" },
      ]),
    },
    pmWebhookDelivery: {
      createMany: vi.fn(
        async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates: boolean }) => {
          let count = 0;
          for (const row of data) {
            const dup = deliveries.some((d) => d.webhookId === row.webhookId && d.sourceKey === row.sourceKey);
            if (dup && !skipDuplicates) throw new Error("unique constraint");
            if (!dup) {
              deliveries.push(row);
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
  };
  return prisma;
}

const hook = (over: Partial<HookRow> = {}): HookRow => ({
  id: "hook-1",
  workspaceId: "ws-1",
  projectId: null,
  enabled: true,
  events: ["work_item.state_changed"],
  ...over,
});

const deps = { now: () => T0, origin: async () => "https://droplet.example" };

describe("fanOutActivity", () => {
  it("does not load audience or queue private ticket data for a Projects subscriber", async () => {
    const prisma = makePrisma([hook()], { ...ITEM, project: { ...ITEM.project, kind: "SERVICE_DESK" } });
    const origin = vi.fn(async () => "https://droplet.example");
    expect(await fanOutActivity(prisma as never, activity(), { ...deps, origin })).toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.pmState.findMany).not.toHaveBeenCalled();
    expect(prisma.pmWebhookDelivery.createMany).not.toHaveBeenCalled();
    expect(origin).not.toHaveBeenCalled();
  });

  it("does not fan out a detached deletion activity", async () => {
    const prisma = makePrisma([hook()]);
    expect(await fanOutActivity(prisma as never, activity({ workItemId: null } as unknown as Partial<PmActivity>), deps)).toBe(0);
    expect(prisma.pmWebhook.findMany).not.toHaveBeenCalled();
    expect(prisma.pmWorkItem.findFirst).not.toHaveBeenCalled();
  });
  it("queues one delivery per interested webhook, keyed by the activity row", async () => {
    const prisma = makePrisma([hook({ id: "a" }), hook({ id: "b" })]);
    const queued = await fanOutActivity(prisma as never, activity(), deps);

    expect(queued).toBe(2);
    expect(prisma.deliveries.map((d) => [d.webhookId, d.event, d.sourceKey, d.nextAttemptAt])).toEqual([
      ["a", "work_item.state_changed", "activity:act-1", T0],
      ["b", "work_item.state_changed", "activity:act-1", T0],
    ]);
    expect(prisma.pmWebhookDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("stores payload v1, with names and labels resolved and the deep link on the box's origin", async () => {
    const prisma = makePrisma([hook()]);
    await fanOutActivity(prisma as never, activity(), deps);
    expect(prisma.deliveries[0]?.payload).toMatchObject({
      version: 1,
      id: "act-1",
      event: "work_item.state_changed",
      occurredAt: T0.toISOString(),
      workspace: { slug: "home" },
      project: { identifier: "ENG" },
      workItem: {
        key: "ENG-12",
        url: "https://droplet.example/projects?p=ENG&item=ENG-12",
        state: { name: "In progress" },
        assignees: [{ id: "u-2", name: "Ben Ortiz" }],
      },
      actor: { kind: "user", id: "u-1", name: "Ana Cruz" },
      changes: [{ field: "state", fromLabel: "Todo", toLabel: "In progress" }],
    });
  });

  it("is idempotent: handling the same row again creates nothing", async () => {
    const prisma = makePrisma([hook()]);
    expect(await fanOutActivity(prisma as never, activity(), deps)).toBe(1);
    expect(await fanOutActivity(prisma as never, activity(), deps)).toBe(0);
    expect(prisma.deliveries).toHaveLength(1);
  });

  it("wakes the delivery worker when it queued something, and only then", async () => {
    const onQueued = vi.fn();
    const prisma = makePrisma([hook()]);
    await fanOutActivity(prisma as never, activity(), { ...deps, onQueued });
    expect(onQueued).toHaveBeenCalledTimes(1);
    // A replay queues nothing, so there is nothing to wake it for.
    await fanOutActivity(prisma as never, activity(), { ...deps, onQueued });
    // Nobody subscribed: nothing queued, nobody woken.
    await fanOutActivity(makePrisma([]) as never, activity(), { ...deps, onQueued });
    expect(onQueued).toHaveBeenCalledTimes(1);
  });

  it("does the cheap thing first: with nobody subscribed it never loads the work item", async () => {
    const prisma = makePrisma([hook({ events: ["work_item.created"] }), hook({ id: "off", enabled: false })]);
    expect(await fanOutActivity(prisma as never, activity(), deps)).toBe(0);
    expect(prisma.pmWorkItem.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.pmWebhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it("only asks for ENABLED webhooks subscribed to THIS event", async () => {
    const prisma = makePrisma([]);
    await fanOutActivity(prisma as never, activity({ verb: "commented", field: null }), deps);
    expect(prisma.pmWebhook.findMany).toHaveBeenCalledWith({
      where: { enabled: true, events: { has: "work_item.commented" } },
      select: { id: true, workspaceId: true, projectId: true },
    });
  });

  describe("scope", () => {
    it("a workspace-wide webhook hears every project in its workspace; a project-scoped one hears only its own", async () => {
      const prisma = makePrisma([
        hook({ id: "wide" }),
        hook({ id: "mine", projectId: "p-1" }),
        hook({ id: "other-project", projectId: "p-2" }),
        hook({ id: "other-workspace", workspaceId: "ws-2" }),
      ]);
      await fanOutActivity(prisma as never, activity(), deps);
      expect(prisma.deliveries.map((d) => d.webhookId).sort()).toEqual(["mine", "wide"]);
    });

    it("queues nothing — and builds no payload — when nobody matched in scope", async () => {
      const prisma = makePrisma([hook({ projectId: "p-2" })]);
      expect(await fanOutActivity(prisma as never, activity(), deps)).toBe(0);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  it("does nothing for a work item deleted since — its activity went with it", async () => {
    const prisma = makePrisma([hook()], null);
    expect(await fanOutActivity(prisma as never, activity(), deps)).toBe(0);
    expect(prisma.pmWebhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it("reports a system actor for a change nobody made", async () => {
    const prisma = makePrisma([hook()]);
    await fanOutActivity(prisma as never, activity({ actorId: null }), deps);
    expect((prisma.deliveries[0]?.payload as { actor: unknown }).actor).toEqual({
      kind: "system", id: null, name: null,
    });
  });

  it("fans an unassignment out as work_item.updated, not work_item.assigned", async () => {
    const prisma = makePrisma([hook({ events: ["work_item.updated"] })]);
    await fanOutActivity(
      prisma as never,
      activity({ verb: "unassigned", field: "assignees", oldValue: "u-2", newValue: null }),
      deps,
    );
    expect(prisma.deliveries[0]?.event).toBe("work_item.updated");
    expect((prisma.deliveries[0]?.payload as { changes: unknown[] }).changes).toEqual([
      { field: "assignees", from: "u-2", to: null, fromLabel: "Ben Ortiz", toLabel: null },
    ]);
  });
});

describe("enqueueWebhookDeliveries (the path WS-14's SLA events take)", () => {
  const payload = buildTestPayload({
    eventId: "evt-sla-1",
    event: "sla.breached",
    occurredAt: T0,
    workspace: { id: "ws-1", slug: "home", name: "Home" },
    actor: { id: null, name: null },
  });

  it("queues for matching webhooks under the caller's own idempotence key", async () => {
    const prisma = makePrisma([
      hook({ id: "a", events: ["sla.breached"] }),
      hook({ id: "b", events: ["work_item.created"] }),
    ]);
    const first = await enqueueWebhookDeliveries(prisma as never, {
      workspaceId: "ws-1", projectId: "p-1", event: "sla.breached", payload, sourceKey: "sla:t-1:breached:1", now: T0,
    });
    const again = await enqueueWebhookDeliveries(prisma as never, {
      workspaceId: "ws-1", projectId: "p-1", event: "sla.breached", payload, sourceKey: "sla:t-1:breached:1", now: T0,
    });
    expect([first, again]).toEqual([1, 0]);
    expect(prisma.deliveries).toHaveLength(1);
    expect(prisma.deliveries[0]).toMatchObject({ webhookId: "a", event: "sla.breached", sourceKey: "sla:t-1:breached:1" });
  });

  it("honours scope", async () => {
    const prisma = makePrisma([hook({ events: ["sla.breached"], projectId: "p-2" })]);
    expect(
      await enqueueWebhookDeliveries(prisma as never, {
        workspaceId: "ws-1", projectId: "p-1", event: "sla.breached", payload, sourceKey: "k",
      }),
    ).toBe(0);
  });
});

describe("createWebhookFanOutConsumer", () => {
  it("is the `webhooks` consumer, with a backstop interval, handing each row to the fan-out", async () => {
    const prisma = makePrisma([hook()]);
    const consumer = createWebhookFanOutConsumer(prisma as never, deps);
    expect(consumer.name).toBe("webhooks");
    expect(consumer.intervalMs).toBe(5_000);
    await consumer.handle(activity());
    expect(prisma.deliveries).toHaveLength(1);
  });
});

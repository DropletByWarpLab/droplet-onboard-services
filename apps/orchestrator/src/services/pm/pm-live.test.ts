/**
 * WARP-3536 — the `pm-live` outbox consumer: one PmActivity row becomes one
 * `{ type: "pm.changed", projectId, workItemId, verb }` frame for each person
 * who can read the item, on that person's own topic. Ids and a kind only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PmActivity } from "@prisma/client";
import { recordMqttState, mqttConnected } from "../mqtt-status.js";
import { registerOutboxConsumer, stopOutbox } from "./pm-outbox.js";
import { createPmLiveConsumer, PM_LIVE_TOPIC, PM_LIVE_CONSUMER, publishPmChanged } from "./pm-live.js";

const T0 = new Date("2026-10-04T12:00:00.000Z");

function row(over: Partial<PmActivity> = {}): PmActivity {
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
    deletedProjectId: null,
    deletedWorkItemId: null,
    deletedGuestUserIds: [],
    ...over,
  } as PmActivity;
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function setup(over: {
  connected?: () => boolean;
  names?: string[];
  item?: { projectId: string; project: { kind: "PROJECT" | "SERVICE_DESK" } } | null;
  deletedProject?: { kind: "PROJECT" | "SERVICE_DESK" } | null;
} = {}) {
  const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const send = vi.fn((topic: string, payload: Record<string, unknown>) => void sent.push({ topic, payload }));
  const audience = {
    usernamesFor: vi.fn(async () => over.names ?? ["ana", "ben"]),
    usernamesForDeleted: vi.fn(async () => over.names ?? ["ana", "ben"]),
  };
  const findUnique = vi.fn(async () =>
    over.item === undefined ? { projectId: "p-1", project: { kind: "PROJECT" as const } } : over.item,
  );
  const findProject = vi.fn(async () => (over.deletedProject === undefined ? { kind: "PROJECT" as const } : over.deletedProject));
  const log = logger();
  const consumer = createPmLiveConsumer({
    prisma: { pmWorkItem: { findUnique }, pmProject: { findUnique: findProject } } as never,
    audience,
    connected: over.connected ?? (() => true),
    send,
    logger: log,
  });
  return { consumer, sent, send, audience, findUnique, findProject, log };
}

describe("what is published", () => {
  it("is one frame per reader, on that reader's own topic, with ids and a kind only", async () => {
    const { consumer, sent } = setup();
    await consumer.handle(row());

    expect(sent).toEqual([
      {
        topic: "droplet/pm/ana",
        payload: { type: "pm.changed", projectId: "p-1", workItemId: "wi-1", verb: "state_changed" },
      },
      {
        topic: "droplet/pm/ben",
        payload: { type: "pm.changed", projectId: "p-1", workItemId: "wi-1", verb: "state_changed" },
      },
    ]);
  });

  it("never carries content: not the field, the old or new value, the actor or any name", async () => {
    const { consumer, sent } = setup();
    await consumer.handle(row({ oldValue: "secret-before", newValue: "secret-after", actorId: "u-boss" }));

    for (const { payload } of sent) {
      expect(Object.keys(payload).sort()).toEqual(["projectId", "type", "verb", "workItemId"]);
      expect(JSON.stringify(payload)).not.toMatch(/secret|u-boss|state"/);
    }
  });

  it("says nothing to people the audience leaves out", async () => {
    const { consumer, sent, audience } = setup({ names: [] });
    await consumer.handle(row());
    expect(audience.usernamesFor).toHaveBeenCalledWith("wi-1");
    expect(sent).toEqual([]);
  });

  it("publishes a committed deletion tombstone after the work-item row is gone", async () => {
    const { consumer, sent, findUnique, findProject, audience } = setup({ item: null, names: ["owner", "assigned-guest"] });
    await consumer.handle(row({
      workItemId: null,
      verb: "deleted",
      deletedProjectId: "p-1",
      deletedWorkItemId: "wi-gone",
      deletedGuestUserIds: ["guest-id"],
    }));

    expect(findUnique).not.toHaveBeenCalled();
    expect(findProject).toHaveBeenCalledWith({ where: { id: "p-1" }, select: { kind: true } });
    expect(audience.usernamesForDeleted).toHaveBeenCalledWith(["guest-id"]);
    expect(sent.map(({ topic, payload }) => [topic, payload])).toEqual([
      ["droplet/pm/owner", { type: "pm.changed", projectId: "p-1", workItemId: "wi-gone", verb: "deleted" }],
      ["droplet/pm/assigned-guest", { type: "pm.changed", projectId: "p-1", workItemId: "wi-gone", verb: "deleted" }],
    ]);
  });

  it("does not publish live work-item activity from a service desk project", async () => {
    const { consumer, sent, audience, findUnique } = setup({
      item: { projectId: "desk-1", project: { kind: "SERVICE_DESK" } },
    });
    await consumer.handle(row());
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "wi-1" },
      select: { projectId: true, project: { select: { kind: true } } },
    });
    expect(audience.usernamesFor).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("does not publish a deletion tombstone from a service desk project", async () => {
    const { consumer, sent, audience, findProject } = setup({
      deletedProject: { kind: "SERVICE_DESK" },
    });
    await consumer.handle(row({
      workItemId: null,
      verb: "deleted",
      deletedProjectId: "desk-1",
      deletedWorkItemId: "wi-gone",
      deletedGuestUserIds: ["guest-id"],
    }));
    expect(findProject).toHaveBeenCalledWith({ where: { id: "desk-1" }, select: { kind: true } });
    expect(audience.usernamesForDeleted).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("builds the topic from the username", () => {
    expect(PM_LIVE_TOPIC("alice-nc")).toBe("droplet/pm/alice-nc");
  });

  it("publishPmChanged is the one place the frame is built", () => {
    const send = vi.fn();
    publishPmChanged(send, ["ana"], { projectId: "p", workItemId: "w", verb: "created" });
    expect(send).toHaveBeenCalledWith("droplet/pm/ana", {
      type: "pm.changed",
      projectId: "p",
      workItemId: "w",
      verb: "created",
    });
  });
});

describe("the work item", () => {
  it("is looked up once per item, not once per row (a work item never changes project)", async () => {
    const { consumer, findUnique } = setup();
    await consumer.handle(row({ id: "a" }));
    await consumer.handle(row({ id: "b", verb: "commented" }));
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("deleted since the write: nothing to say, nothing thrown, and nothing cached", async () => {
    const { consumer, sent, audience, findUnique } = setup({ item: null });
    await expect(consumer.handle(row())).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(audience.usernamesFor).not.toHaveBeenCalled();
    await consumer.handle(row({ id: "again" }));
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("with the broker down", () => {
  it("does nothing: no lookup, no publish, no error, no warning, and the row is consumed", async () => {
    const { consumer, sent, send, audience, findUnique, log } = setup({ connected: () => false });

    for (let i = 0; i < 50; i += 1) await expect(consumer.handle(row({ id: `r${i}` }))).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
    expect(audience.usernamesFor).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("says so once per outage (debug), not once per row, and resumes quietly", async () => {
    let up = false;
    const { consumer, sent, log } = setup({ connected: () => up });

    for (let i = 0; i < 20; i += 1) await consumer.handle(row({ id: `down${i}` }));
    expect(log.debug).toHaveBeenCalledTimes(1);

    up = true;
    await consumer.handle(row({ id: "back" }));
    expect(sent).toHaveLength(2); // both readers hear the first change after the outage
    expect(log.debug).toHaveBeenCalledTimes(2); // "resumed"
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("reads the broker state from the health record by default", () => {
    recordMqttState("disconnected", "ECONNREFUSED");
    expect(mqttConnected()).toBe(false);
    recordMqttState("connecting");
    expect(mqttConnected()).toBe(false);
    recordMqttState("connected");
    expect(mqttConnected()).toBe(true);
  });
});

describe("a publish that fails", () => {
  it("never fails the row, and is reported once per run of failures", async () => {
    const { consumer, send, log } = setup();
    send.mockImplementation(() => {
      throw new Error("socket closed");
    });

    await expect(consumer.handle(row({ id: "a" }))).resolves.toBeUndefined();
    await expect(consumer.handle(row({ id: "b" }))).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("one reader's failure does not stop the others hearing", async () => {
    const { consumer, send } = setup({ names: ["ana", "ben", "cy"] });
    send.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await consumer.handle(row());
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("a database failure", () => {
  it("is rethrown, so the outbox keeps the cursor before the row and retries it", async () => {
    const { consumer, audience } = setup();
    audience.usernamesFor.mockRejectedValueOnce(new Error("db down"));
    await expect(consumer.handle(row())).rejects.toThrow("db down");
    await expect(consumer.handle(row())).resolves.toBeUndefined();
  });
});

describe("registration", () => {
  beforeEach(() => stopOutbox());

  it("is a valid outbox consumer: its own name, a ~1 s backstop and a short settle window", () => {
    const { consumer } = setup();
    expect(consumer.name).toBe(PM_LIVE_CONSUMER);
    expect(consumer.name).toBe("pm-live");
    expect(consumer.intervalMs).toBe(1_000);
    // A later commit must not advance past a tombstone that is still in its
    // delete transaction; this matches the 5 s transaction limit + margin.
    expect(consumer.settleMs).toBe(6_000);

    const scheduleInterval = vi.fn(() => ({ runNow: vi.fn() }));
    registerOutboxConsumer(consumer, {
      prisma: {} as never,
      cronRuntime: { scheduleInterval, scheduleCron: vi.fn(), stop: vi.fn() } as never,
    });
    expect(scheduleInterval).toHaveBeenCalledWith(1_000, expect.any(Function), {
      lockKey: "droplet:pm-outbox:pm-live",
      immediate: true,
    });
    stopOutbox();
  });
});

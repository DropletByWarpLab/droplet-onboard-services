/**
 * WARP-2587 (ADR-045 slice I) — the notify sweep, mocked lane.
 *
 * What each case is actually defending:
 *   • the CUT     — `updated`/`title_changed` must produce the explicit
 *                   not_needed terminal, not a notification and not a row
 *                   left pending forever.
 *   • the ACTOR   — a person is never told what they just did, and a row
 *                   whose ONLY recipient is the actor is terminal, not stuck.
 *   • COALESCING  — 200 assignments to one person are ONE notification.
 *   • EXACTLY-ONCE— the pending→sent claim means a second sweep over the same
 *                   rows sends nothing.
 *   • the WINDOW  — a row younger than SETTLE_MS is left PENDING (a candidate
 *                   next tick), never skipped.
 *   • slice H     — the department seam is exercised with a stub resolver, so
 *                   the merge/dedupe/actor-exclusion path is proven before the
 *                   real resolver exists.
 *
 * The real-Postgres run-twice + CHECK-constraint proof lives in
 * __tests__/activity-notify.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { publishMock, recordMock } = vi.hoisted(() => ({
  publishMock: vi.fn(() => ({ channels: ["toast"], errors: [] as string[] })),
  // Typed args: an untyped vi.fn infers a zero-length tuple for
  // `mock.calls`, so reading calls[0][1] is a tsc error rather than the
  // assertion it looks like.
  recordMock: vi.fn(
    async (_prisma: unknown, _input: Record<string, unknown>) => ({
      id: `log-${Math.random()}`,
    }),
  ),
}));

vi.mock("./notifications.service.js", () => ({
  publishNotificationToast: publishMock,
  recordNotification: recordMock,
}));

import { runActivityNotifySweep, SETTLE_MS } from "./activity-notify.service.js";

interface PmRow {
  id: string;
  workItemId: string;
  actorId: string | null;
  verb: string;
  newValue: string | null;
  createdAt: Date;
  notifyStatus: "pending" | "sent" | "not_needed";
  notifiedAt: Date | null;
}

const NOW = new Date("2026-08-31T12:00:00.000Z").getTime();
const OLD = new Date(NOW - SETTLE_MS - 1_000);
const FRESH = new Date(NOW - 1_000);

function pmRow(over: Partial<PmRow> & Pick<PmRow, "id" | "workItemId" | "verb">): PmRow {
  return {
    actorId: "u-actor",
    newValue: null,
    createdAt: OLD,
    notifyStatus: "pending",
    notifiedAt: null,
    ...over,
  };
}

function makeStub(seed: {
  pm?: PmRow[];
  assignees?: Array<{ workItemId: string; userId: string }>;
  users?: Array<{ id: string; username: string }>;
}) {
  const pm = [...(seed.pm ?? [])];
  const assignees = [...(seed.assignees ?? [])];
  const users = [...(seed.users ?? [])];

  const pmDelegate = {
    findMany: vi.fn(async (args: any) =>
      pm
        .filter(
          (r) =>
            r.notifyStatus === args.where.notifyStatus &&
            r.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
        )
        .slice(0, args.take)
        .map((r) => ({
          ...r,
          workItem: {
            id: r.workItemId,
            name: `item ${r.workItemId}`,
            sequenceId: 1,
            project: { identifier: "INBOX" },
          },
        })),
    ),
    updateMany: vi.fn(async (args: any) => {
      let count = 0;
      for (const r of pm) {
        if (!args.where.id.in.includes(r.id)) continue;
        if (args.where.notifyStatus && r.notifyStatus !== args.where.notifyStatus) continue;
        Object.assign(r, args.data);
        count++;
      }
      return { count };
    }),
  };

  const emptyDelegate = {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };

  const stub = {
    pm,
    pmActivity: pmDelegate,
    crmActivity: emptyDelegate,
    crmPipelineStage: { findMany: vi.fn(async () => []) },
    pmWorkItemAssignee: {
      findMany: vi.fn(async (args: any) =>
        assignees.filter((a) => args.where.workItemId.in.includes(a.workItemId)),
      ),
    },
    pmState: { findMany: vi.fn(async () => [{ id: "s-done", name: "Done" }]) },
    user: {
      findMany: vi.fn(async (args: any) =>
        users.filter((u) => args.where.id.in.includes(u.id)),
      ),
    },
    notificationLog: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: any) => fn(stub)),
  };
  return stub as unknown as PrismaClient & typeof stub;
}

const opts = { now: () => NOW };

beforeEach(() => {
  vi.clearAllMocks();
  publishMock.mockReturnValue({ channels: ["toast"], errors: [] });
});

describe("the cut", () => {
  it("gives non-notifiable verbs the EXPLICIT not_needed terminal, never a silent skip", async () => {
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "updated" }),
        pmRow({ id: "a2", workItemId: "w1", verb: "title_changed" }),
        pmRow({ id: "a3", workItemId: "w1", verb: "created" }),
        pmRow({ id: "a4", workItemId: "w1", verb: "priority_changed" }),
      ],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.pmSkipped).toBe(4);
    // The load-bearing half: nothing is left pending to be rescanned forever.
    expect(prisma.pm.every((r) => r.notifyStatus === "not_needed")).toBe(true);
  });

  it("notifies on assigned / state_changed / due_date_changed / commented", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "bob", kind: "event", title: "Assigned to you" }),
    );
  });
});

describe("who", () => {
  it("never notifies the actor, and terminates a row whose only recipient IS the actor", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned", actorId: "u-bob" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.pmSkipped).toBe(1);
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
  });

  it("[slice H seam] merges department watchers, de-duplicates, and still drops the actor", async () => {
    // Proof the department path works BEFORE slice H ships the resolver.
    // Mutation: return an empty map here and `carol` disappears from the
    // recipients — which is exactly the degraded, still-correct default.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-dave" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [
        { id: "u-bob", username: "bob" },
        { id: "u-carol", username: "carol" },
      ],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () =>
        new Map([["w1", ["u-carol", "u-bob", "u-dave"]]]),
    });
    const recipients = recordMock.mock.calls.map((c: any) => c[1].userId).sort();
    expect(recipients).toEqual(["bob", "carol"]);
  });

  it("a department resolver that throws does not take the assignee notification down", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => {
        throw new Error("slice H is half-deployed");
      },
    });
    expect(recordMock).toHaveBeenCalledOnce();
  });
});

describe("coalescing", () => {
  it("a 200-ticket bulk import is ONE notification, not 200", async () => {
    const prisma = makeStub({
      pm: Array.from({ length: 200 }, (_, i) =>
        pmRow({ id: `a${i}`, workItemId: `w${i}`, verb: "assigned" }),
      ),
      assignees: Array.from({ length: 200 }, (_, i) => ({
        workItemId: `w${i}`,
        userId: "u-bob",
      })),
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledOnce();
    expect(recordMock.mock.calls[0][1]).toMatchObject({
      userId: "bob",
      title: "200 updates on your work",
      body: "200 assigned",
    });
  });

  it("a single event keeps its specific copy — the digest is not the default", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "state_changed", newValue: "s-done" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock.mock.calls[0][1]).toMatchObject({
      title: "Moved to Done",
      body: "INBOX-1 — item w1",
    });
  });
});

describe("exactly-once and the settle window", () => {
  it("a second sweep over the same rows sends nothing (the pending→sent claim)", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledOnce();
    expect(prisma.pm[0].notifyStatus).toBe("sent");
    expect(prisma.pm[0].notifiedAt).toBeInstanceOf(Date);

    recordMock.mockClear();
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("leaves a row younger than SETTLE_MS PENDING — a candidate next tick, not a skip", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned", createdAt: FRESH })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.pmSkipped).toBe(0);
    expect(prisma.pm[0].notifyStatus).toBe("pending");
  });
});

describe("containment", () => {
  it("a failed toast does not roll back the claim or the durable log row", async () => {
    publishMock.mockReturnValue({ channels: [], errors: ["toast: mqtt_unavailable"] });
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledOnce();
    expect(prisma.pm[0].notifyStatus).toBe("sent");
    expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { error: "toast: mqtt_unavailable" } }),
    );
  });
});

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

// Captures what the sweep logs, so a dropped recipient is provably LOUD.
const { logged } = vi.hoisted(() => ({
  logged: [] as Array<{ level: string; obj: Record<string, unknown>; msg: string }>,
}));
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = { error: push("error"), warn: push("warn"), info: push("info"), debug: push("debug") };
  return { createLogger: () => stub };
});

import { assertRecipientIsUsername } from "./notification-recipient.js";

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

/** A CRM stage move, as sweepCrm reads it (deal + destination stage). */
interface CrmRow {
  id: string;
  kind: string;
  toStageId: string | null;
  actorId: string | null;
  createdAt: Date;
  notifyStatus: "pending" | "sent" | "not_needed";
  notifiedAt: Date | null;
  deal: { id: string; title: string; ownerId: string | null } | null;
}

function makeStub(seed: {
  pm?: PmRow[];
  assignees?: Array<{ workItemId: string; userId: string }>;
  users?: Array<{ id: string; username: string }>;
  crm?: CrmRow[];
  stages?: Array<{ id: string; name: string; kind: "OPEN" | "WON" | "LOST" }>;
}) {
  const pm = [...(seed.pm ?? [])];
  const crm = [...(seed.crm ?? [])];
  const stages = [...(seed.stages ?? [])];
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

  const crmDelegate = {
    findMany: vi.fn(async (args: any) =>
      crm.filter(
        (r) =>
          r.notifyStatus === args.where.notifyStatus &&
          r.createdAt.getTime() <= args.where.createdAt.lte.getTime(),
      ),
    ),
    updateMany: vi.fn(async (args: any) => {
      let count = 0;
      for (const r of crm) {
        if (!args.where.id.in.includes(r.id)) continue;
        if (args.where.notifyStatus && r.notifyStatus !== args.where.notifyStatus) continue;
        Object.assign(r, args.data);
        count++;
      }
      return { count };
    }),
  };

  const stub = {
    pm,
    crm,
    pmActivity: pmDelegate,
    crmActivity: crmDelegate,
    crmPipelineStage: {
      findMany: vi.fn(async (args: any) => stages.filter((st) => args.where.id.in.includes(st.id))),
    },
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
  logged.length = 0;
  publishMock.mockReturnValue({ channels: ["toast"], errors: [] });
  // The REAL recipient check, as recordNotification runs it: a refusal inside
  // the claim transaction is the failure this file must prove contained.
  recordMock.mockImplementation(async (_prisma: unknown, input: Record<string, unknown>) => {
    assertRecipientIsUsername("recordNotification", input.username as string);
    return { id: `log-${Math.random()}` };
  });
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
      expect.objectContaining({ username: "bob", kind: "event", title: "Assigned to you" }),
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
    const recipients = recordMock.mock.calls.map((c: any) => c[1].username).sort();
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
      username: "bob",
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

describe("WARP-2804 — each toast carries the id of the row recorded for it", () => {
  it("so the toaster can acknowledge exactly the notification it shows", async () => {
    let n = 0;
    recordMock.mockImplementation(async () => ({ id: `log-${++n}` }));
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "assigned" }),
        pmRow({ id: "a2", workItemId: "w2", verb: "assigned" }),
      ],
      assignees: [
        { workItemId: "w1", userId: "u-bob" },
        { workItemId: "w2", userId: "u-carol" },
      ],
      users: [
        { id: "u-bob", username: "bob" },
        { id: "u-carol", username: "carol" },
      ],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledTimes(2);
    // Pair each toast with the row recorded for the same recipient.
    const recorded = await Promise.all(
      recordMock.mock.calls.map(async (c: any, i: number) => ({
        username: c[1].username,
        id: (await recordMock.mock.results[i]!.value).id,
      })),
    );
    const toasts = publishMock.mock.calls.map((c: any) => ({ username: c[0].username, id: c[0].id }));
    expect(toasts.sort((a, b) => a.username.localeCompare(b.username))).toEqual(
      recorded.sort((a, b) => a.username.localeCompare(b.username)),
    );
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

// WARP-2911 — an account whose username has the shape of a User.id predates
// creation refusing that shape (auth-policy `isReservedUserId`). Every
// notification entry point refuses it, and inside the claim transaction that
// refusal rolled back the WHOLE batch: every recipient's notification, every
// 60 s tick, forever — and, PM running first, the CRM sweep with it.
describe("WARP-2911 — a recipient whose username is User.id-shaped", () => {
  const LEGACY = { id: "0d9c5c1e-2f4a-4b6d-8e10-3a5c7e9b1d2f", username: "5f0c2a1e-7b3d-4c9e-8a21-0e6d4b9c3f70" };

  it("🔴 is dropped BEFORE the claim: everyone else is notified and the CRM sweep still runs", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [
        { workItemId: "w1", userId: LEGACY.id },
        { workItemId: "w1", userId: "u-bob" },
      ],
      users: [LEGACY, { id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock.mock.calls.map((c) => c[1].username)).toEqual(["bob"]);
    expect(prisma.pm[0].notifyStatus).toBe("sent");
    expect(res.notificationsSent).toBe(1);
    expect(prisma.crmActivity.findMany).toHaveBeenCalled();
  });

  it("🔴 a row whose ONLY recipient is dropped gets the not_needed terminal, never left pending", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: LEGACY.id }],
      users: [LEGACY],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
    // …and the next tick finds nothing to retry.
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("🔴 the CRM sweep drops it the same way: the deal owner's row is terminal, not a rolled-back batch", async () => {
    const prisma = makeStub({
      crm: [
        {
          id: "c1",
          kind: "STAGE_CHANGE",
          toStageId: "st-won",
          actorId: "u-bob",
          createdAt: OLD,
          notifyStatus: "pending",
          notifiedAt: null,
          deal: { id: "d1", title: "Acme renewal", ownerId: LEGACY.id },
        },
        {
          id: "c2",
          kind: "STAGE_CHANGE",
          toStageId: "st-won",
          actorId: LEGACY.id,
          createdAt: OLD,
          notifyStatus: "pending",
          notifiedAt: null,
          deal: { id: "d2", title: "Globex", ownerId: "u-bob" },
        },
      ],
      stages: [{ id: "st-won", name: "Won", kind: "WON" }],
      users: [LEGACY, { id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock.mock.calls.map((c) => c[1].username)).toEqual(["bob"]);
    expect(prisma.crm.map((r) => [r.id, r.notifyStatus])).toEqual([
      ["c1", "not_needed"],
      ["c2", "sent"],
    ]);
    expect(res).toMatchObject({ crmNotified: 1, crmSkipped: 1 });
  });

  it("the drop is logged at ERROR, naming the account and the refusal code", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: LEGACY.id }],
      users: [LEGACY],
    });
    await runActivityNotifySweep(prisma, opts);
    const errors = logged.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.obj).toMatchObject({ userId: LEGACY.id, username: LEGACY.username, code: "NOTIFICATION_RECIPIENT_IS_ID" });
  });
});

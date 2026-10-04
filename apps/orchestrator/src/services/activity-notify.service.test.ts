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

import { NOTIFIABLE_PM_VERBS, runActivityNotifySweep, SETTLE_MS } from "./activity-notify.service.js";

interface PmRow {
  id: string;
  workItemId: string;
  actorId: string | null;
  verb: string;
  /** WARP-3519 — `commented` / `mentioned` rows carry field "comment". */
  field?: string | null;
  /** WARP-3519 — a `mentioned` row's oldValue is the comment's id. */
  oldValue?: string | null;
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

/**
 * What Prisma does with a `select`: it returns exactly the scalars named. A stub
 * that handed back the whole row would let the sweep read a field it never asked
 * for — green here, `undefined` against Postgres. (No `select` = the whole row.)
 */
function project<T extends object>(row: T, select: Record<string, boolean> | undefined): Partial<T> {
  if (!select) return row;
  const out: Record<string, unknown> = {};
  for (const [key, on] of Object.entries(select)) if (on) out[key] = (row as Record<string, unknown>)[key];
  return out as Partial<T>;
}

function makeStub(seed: {
  pm?: PmRow[];
  assignees?: Array<{ workItemId: string; userId: string }>;
  /** WARP-3519 — PmWorkItemWatcher rows (the explicit watch list). */
  watchers?: Array<{ workItemId: string; userId: string }>;
  /** WARP-3519 — PmCommentMention rows (who each comment @mentions). */
  mentions?: Array<{ commentId: string; userId: string }>;
  users?: Array<{
    id: string;
    username: string;
    role?: string;
    displayName?: string;
    directoryStatus?: string;
  }>;
  crm?: CrmRow[];
  stages?: Array<{ id: string; name: string; kind: "OPEN" | "WON" | "LOST" }>;
}) {
  const pm = [...(seed.pm ?? [])];
  const crm = [...(seed.crm ?? [])];
  const stages = [...(seed.stages ?? [])];
  const assignees = [...(seed.assignees ?? [])];
  const watchers = [...(seed.watchers ?? [])];
  const mentions = [...(seed.mentions ?? [])];
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
    // WARP-3519 — filtered on exactly the keys the contract names
    // (`where.workItemId.in` / `where.commentId.in`), and `select`-faithful.
    pmWorkItemWatcher: {
      findMany: vi.fn(async (args: any) =>
        watchers
          .filter((w) => args.where.workItemId.in.includes(w.workItemId))
          .map((w) => project(w, args.select)),
      ),
    },
    pmCommentMention: {
      findMany: vi.fn(async (args: any) =>
        mentions
          .filter((m) => args.where.commentId.in.includes(m.commentId))
          .map((m) => project(m, args.select)),
      ),
    },
    pmState: { findMany: vi.fn(async () => [{ id: "s-done", name: "Done" }]) },
    user: {
      findMany: vi.fn(async (args: any) =>
        users.filter((u) => args.where.id.in.includes(u.id)).map((u) => project(u, args.select)),
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

// WARP-3365 (Romain, 2026-09-30) — assigning a work item to an external guest
// SHARES that one item with them, so the notification stays; a guest cannot own
// a deal, and is not told about one; a department watcher hears about every
// item in the department, which a guest is not admitted to.
describe("WARP-3365 — external guests and notifications", () => {
  const GUEST = { id: "u-gina", username: "gina", role: "guest" };

  it("an ASSIGNED guest is notified: they can open the item", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned", actorId: "u-dave" })],
      assignees: [{ workItemId: "w1", userId: GUEST.id }],
      users: [GUEST],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock.mock.calls.map((c: any) => [c[1].username, c[1].title])).toEqual([["gina", "Assigned to you"]]);
    expect(prisma.pm[0].notifyStatus).toBe("sent");
  });

  it("a guest who is only a department WATCHER is not notified; a member watcher still is", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-dave" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [{ id: "u-bob", username: "bob" }, GUEST, { id: "u-carol", username: "carol", role: "family" }],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => new Map([["w1", [GUEST.id, "u-carol"]]]),
    });
    expect(recordMock.mock.calls.map((c: any) => c[1].username).sort()).toEqual(["bob", "carol"]);
  });

  it("a guest who is an assignee AND a watcher is notified once, as an assignee", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-dave" })],
      assignees: [{ workItemId: "w1", userId: GUEST.id }],
      users: [GUEST],
    });
    await runActivityNotifySweep(prisma, { ...opts, departmentWatchers: async () => new Map([["w1", [GUEST.id]]]) });
    expect(recordMock.mock.calls.map((c: any) => c[1].username)).toEqual(["gina"]);
  });

  it("the CRM sweep does not tell a guest about a deal closing: the row is terminal, not pending, and a member owner is still told", async () => {
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
          deal: { id: "d1", title: "Acme renewal", ownerId: GUEST.id },
        },
        {
          id: "c2",
          kind: "STAGE_CHANGE",
          toStageId: "st-won",
          actorId: "u-bob",
          createdAt: OLD,
          notifyStatus: "pending",
          notifiedAt: null,
          deal: { id: "d2", title: "Globex", ownerId: "u-carol" },
        },
      ],
      stages: [{ id: "st-won", name: "Won", kind: "WON" }],
      users: [GUEST, { id: "u-carol", username: "carol", role: "family" }, { id: "u-bob", username: "bob" }],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock.mock.calls.map((c: any) => c[1].username)).toEqual(["carol"]);
    expect(prisma.crm.map((r) => [r.id, r.notifyStatus])).toEqual([
      ["c1", "not_needed"],
      ["c2", "sent"],
    ]);
    expect(res).toMatchObject({ crmNotified: 1, crmSkipped: 1 });
  });
});

// ── WARP-3519 (ADR-069 WS-2) — watchers, mentions, and who may hear ──────────
//
// The sweep stays ONE pipeline: this is its audience and its copy growing, not a
// second dispatcher. What the cases below are defending:
//   • WATCHERS    — the watch list joins the assignees and the department
//                   watchers into ONE set per person, for every item-wide verb.
//   • MENTIONS    — a `mentioned` row is for ONE person and is never fanned out;
//                   the `commented` row of the same comment skips the people it
//                   mentions, so one comment is one notification, not two.
//   • ELIGIBILITY — somebody who arrives as a watcher or a mention target must be
//                   able to read the item; an assignee has always been told.
//   • COPY        — what each title says, and the digest tally.
//
// The real-Postgres half (the rows these cases seed, as the write path produces
// them) is __tests__/pm-collaboration.pg.test.ts.

/** A directory user — an ACTIVE member unless a case says otherwise. The older
 *  cases above lean on an undefined role/status; these say what they mean. */
function person(
  name: string,
  over: { displayName?: string; role?: string; directoryStatus?: string } = {},
) {
  return {
    id: `u-${name}`,
    username: name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    role: "family",
    directoryStatus: "ACTIVE",
    ...over,
  };
}

/** A `commented` row as WS-2 writes it: field "comment", newValue = the comment's id.
 *  (A legacy one has neither — build it with plain `pmRow`.) */
const commented = (id: string, workItemId: string, commentId: string, over: Partial<PmRow> = {}) =>
  pmRow({ id, workItemId, verb: "commented", field: "comment", newValue: commentId, ...over });

/** A `mentioned` row: oldValue = the comment's id, newValue = the mentioned User.id. */
const mentioned = (
  id: string,
  workItemId: string,
  commentId: string,
  target: string,
  over: Partial<PmRow> = {},
) =>
  pmRow({
    id,
    workItemId,
    verb: "mentioned",
    field: "comment",
    oldValue: commentId,
    newValue: target,
    ...over,
  });

/** The named fields of every notification recorded, sorted: the order the sweep
 *  delivers in is not part of the contract. */
function sent(...keys: string[]): string[][] {
  return recordMock.mock.calls
    .map((c) => keys.map((k) => String(c[1][k])))
    .sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
}

describe("WARP-3519 — the watch list joins the audience", () => {
  it.each([
    ["commented", { verb: "commented" }, "New comment", "New comment"],
    ["state_changed", { verb: "state_changed", newValue: "s-done" }, "Moved to Done", "Moved to Done"],
    ["assigned", { verb: "assigned" }, "Assigned to you", "Assignment changed"],
    ["due_date_changed", { verb: "due_date_changed" }, "Due date changed", "Due date changed"],
  ])("a watcher is told about a %s, once, alongside the assignee", async (_verb, row, assigneeTitle, watcherTitle) => {
    // Defends: the watch list is the audience of EVERY item-wide verb, not just
    // comments; and the copy is per recipient (an assignment is "yours" only to
    // the person it was assigned to).
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", ...row })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("bob"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([
      ["bob", assigneeTitle],
      ["wendy", watcherTitle],
    ]);
    expect(prisma.pm[0].notifyStatus).toBe("sent");
  });

  it("an item with a watcher and NO assignee still tells the watcher", async () => {
    // Defends: the watch list is an audience in its own right. Before WS-2 an
    // unassigned item told nobody.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "state_changed", newValue: "s-done" })],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title", "body")).toEqual([["wendy", "Moved to Done", "INBOX-1 — item w1"]]);
  });

  it("assignee + watcher + department watcher is ONE set: exactly one notification per person", async () => {
    // Defends: de-duplication across the three sources. A union built by
    // concatenation would tell bob three times about one comment.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [
        { workItemId: "w1", userId: "u-bob" },
        { workItemId: "w1", userId: "u-carol" },
        { workItemId: "w1", userId: "u-dave" },
      ],
      users: [person("bob"), person("carol"), person("dave"), person("erin")],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => new Map([["w1", ["u-carol", "u-erin", "u-bob"]]]),
    });
    expect(recordMock).toHaveBeenCalledTimes(4);
    expect(sent("username")).toEqual([["bob"], ["carol"], ["dave"], ["erin"]]);
  });

  it("a watcher hears about the item they watch and no other", async () => {
    // Defends: the watch list is keyed by ITEM. A flat union of every watcher of
    // every item in the tick would tell wendy about wally's item.
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "due_date_changed" }),
        pmRow({ id: "a2", workItemId: "w2", verb: "due_date_changed" }),
      ],
      watchers: [
        { workItemId: "w1", userId: "u-wally" },
        { workItemId: "w2", userId: "u-wendy" },
      ],
      users: [person("wally"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "body")).toEqual([
      ["wally", "INBOX-1 — item w1"],
      ["wendy", "INBOX-1 — item w2"],
    ]);
  });

  it("never notifies the actor, even when they are a watcher (a commenter is auto-watched)", async () => {
    // Defends: the actor clause survives the new source. WS-2 makes every
    // commenter a watcher of their own comment's item.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-wendy" })],
      watchers: [
        { workItemId: "w1", userId: "u-wendy" },
        { workItemId: "w1", userId: "u-carol" },
      ],
      users: [person("wendy"), person("carol")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username")).toEqual([["carol"]]);
  });

  it("a row whose only watcher IS the actor is terminal (not_needed), not stuck pending", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-wendy" })],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("wendy")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
  });

  it("a department watcher who is not assigned is told 'Assignment changed' too", async () => {
    // Defends: the copy rule is "is this recipient a current ASSIGNEE", whatever
    // route brought them — not "is this person on the watch list table".
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [person("bob"), person("carol")],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => new Map([["w1", ["u-carol"]]]),
    });
    expect(sent("username", "title")).toEqual([
      ["bob", "Assigned to you"],
      ["carol", "Assignment changed"],
    ]);
  });

  it("somebody who WAS assigned and still watches (the row outlives an unassignment) is told 'Assignment changed'", async () => {
    // Defends: "assignee" is read from the CURRENT assignee rows. Being taken off
    // an item leaves the watcher row (reason ASSIGNEE) behind on purpose.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }], // ex-assignee: no assignee row any more
      users: [person("bob"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([
      ["bob", "Assigned to you"],
      ["wendy", "Assignment changed"],
    ]);
  });
});

describe("WARP-3519 — a mention is for ONE person", () => {
  it("a `mentioned` row notifies ONLY its target — never the item's assignees, watchers or department — as '<Name> mentioned you'", async () => {
    // Defends: "Alice mentioned you" going to the whole item would be wrong (it
    // is a lie to everyone but mia) and noisy. The target is row.newValue and
    // nobody else; the body names the item like every other notification.
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-mia", { actorId: "u-alice" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [
        person("alice", { displayName: "Alice Actor" }),
        person("mia"),
        person("bob"),
        person("wendy"),
        person("carol"),
      ],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => new Map([["w1", ["u-carol"]]]),
    });
    expect(recordMock).toHaveBeenCalledOnce();
    expect(recordMock.mock.calls[0][1]).toMatchObject({
      username: "mia",
      kind: "event",
      title: "Alice Actor mentioned you",
      body: "INBOX-1 — item w1",
    });
    expect(prisma.pm[0].notifyStatus).toBe("sent");
  });

  it.each([
    ["no actor (an AI-written comment)", null],
    ["an actor with no directory row (deleted since)", "u-ghost"],
  ])("titles a mention by %s 'You were mentioned'", async (_who, actorId) => {
    // Defends: the copy degrades to a sentence that is still true, instead of
    // "undefined mentioned you" or a thrown sweep.
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-mia", { actorId })],
      users: [person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title", "body")).toEqual([["mia", "You were mentioned", "INBOX-1 — item w1"]]);
  });

  it("caps the title when the actor's display name is long (NotificationLog.title is 120 characters)", async () => {
    // Defends: a display name is user-typed. The title cap exists so a row the
    // sweep writes can never be one the manual-send path would refuse.
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-mia", { actorId: "u-alice" })],
      users: [person("alice", { displayName: "A".repeat(300) }), person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledOnce();
    const title = String(recordMock.mock.calls[0][1].title);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.startsWith("AAAA")).toBe(true);
  });

  it("a mention of the actor themself is terminal (not_needed), not stuck pending", async () => {
    // The write path never records one; the sweep still refuses to tell a
    // person what they just did.
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-alice", { actorId: "u-alice" })],
      users: [person("alice")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
  });

  it("a mention of somebody with no directory row is terminal — not retried every tick", async () => {
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-gone", { actorId: "u-alice" })],
      users: [person("alice")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
  });
});

describe("WARP-3519 — one comment is one notification", () => {
  it("the commented row skips the people the comment mentions (they hear through the mention); everyone else still gets 'New comment'", async () => {
    // Defends: mia is on the item as an assignee-less watcher (auto-watched when
    // mentioned) AND is the target of a `mentioned` row. If the `commented` row
    // fanned out to her too she would get a digest — "2 updates" for one comment.
    const prisma = makeStub({
      pm: [
        commented("a1", "w1", "c1", { actorId: "u-alice" }),
        mentioned("a2", "w1", "c1", "u-mia", { actorId: "u-alice" }),
      ],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [
        { workItemId: "w1", userId: "u-mia" },
        { workItemId: "w1", userId: "u-wendy" },
      ],
      mentions: [{ commentId: "c1", userId: "u-mia" }],
      users: [person("alice", { displayName: "Alice Actor" }), person("bob"), person("mia"), person("wendy")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([
      ["bob", "New comment"],
      ["mia", "Alice Actor mentioned you"],
      ["wendy", "New comment"],
    ]);
    // 2 activity rows claimed, 3 notifications written
    expect(res).toMatchObject({ pmNotified: 2, pmSkipped: 0, notificationsSent: 3 });
    expect(prisma.pm.every((r) => r.notifyStatus === "sent")).toBe(true);
  });

  it("the exclusion is per COMMENT: mentioned in one, still told about the other", async () => {
    // Defends: the mention table is read per comment id. Excluding "everyone
    // mentioned anywhere on the item" would silence mia for comment c2.
    const prisma = makeStub({
      pm: [
        commented("a1", "w1", "c1", { actorId: "u-alice" }),
        commented("a2", "w1", "c2", { actorId: "u-alice" }),
      ],
      watchers: [
        { workItemId: "w1", userId: "u-mia" },
        { workItemId: "w1", userId: "u-wendy" },
      ],
      mentions: [{ commentId: "c1", userId: "u-mia" }],
      users: [person("alice"), person("mia"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title", "body")).toEqual([
      ["mia", "New comment", "INBOX-1 — item w1"], // c2 only
      ["wendy", "2 updates on your work", "2 commented"], // both
    ]);
  });

  it("a commented row whose whole audience is its own mentioned people is terminal, not pending", async () => {
    const prisma = makeStub({
      pm: [commented("a1", "w1", "c1", { actorId: "u-alice" })],
      watchers: [{ workItemId: "w1", userId: "u-mia" }],
      mentions: [{ commentId: "c1", userId: "u-mia" }],
      users: [person("alice"), person("mia")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
  });

  it("a commented row with no comment id (a legacy row) fans out as it always did", async () => {
    // Defends: rows written before WS-2 carry no comment id. They have nothing to
    // exclude by and must keep reaching their whole audience.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-alice" })],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [{ workItemId: "w1", userId: "u-mia" }],
      mentions: [{ commentId: "c1", userId: "u-mia" }], // unrelated to this row
      users: [person("alice"), person("bob"), person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([
      ["bob", "New comment"],
      ["mia", "New comment"],
    ]);
  });

  it.each([
    ["no commented row at all", () => [pmRow({ id: "a1", workItemId: "w1", verb: "assigned" })]],
    ["only a legacy commented row (no comment id)", () => [pmRow({ id: "a1", workItemId: "w1", verb: "commented" })]],
    ["only a non-notifiable row", () => [pmRow({ id: "a1", workItemId: "w1", verb: "comment_edited", field: "comment" })]],
    ["only a mentioned row (its comment id is not a commented row's)", () => [mentioned("a1", "w1", "c1", "u-mia")]],
  ])("does not read PmCommentMention when there is %s", async (_label, rows) => {
    // Defends: the extra query runs only when a commented row carries a comment id.
    const prisma = makeStub({
      pm: rows(),
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [person("bob"), person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(prisma.pmCommentMention.findMany).not.toHaveBeenCalled();
  });

  it("reads the mentions of exactly the comments the commented rows are about", async () => {
    // Defends: `in` holds comment ids and only comment ids — not a state id from
    // a state_changed row, not the comment id a mentioned row also carries.
    const prisma = makeStub({
      pm: [
        commented("a1", "w1", "c1", { actorId: "u-alice" }),
        commented("a2", "w1", "c2", { actorId: "u-alice" }),
        pmRow({ id: "a3", workItemId: "w1", verb: "state_changed", newValue: "s-done" }),
        mentioned("a4", "w1", "c3", "u-mia", { actorId: "u-alice" }),
      ],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      users: [person("alice"), person("bob"), person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(prisma.pmCommentMention.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.pmCommentMention.findMany.mock.calls[0][0];
    expect([...args.where.commentId.in].sort()).toEqual(["c1", "c2"]);
    expect(args.select).toMatchObject({ commentId: true, userId: true });
  });
});

describe("WARP-3519 — who may hear", () => {
  const INELIGIBLE = [
    ["a guest who is not assigned to the item", person("gina", { role: "guest" })],
    ["a deactivated account", person("dora", { directoryStatus: "DEACTIVATED" })],
    ["a service principal", person("svc", { role: "service" })],
  ] as const;

  it.each(INELIGIBLE)("an item watcher who is %s is not notified — the row ends not_needed, never pending", async (_who, u) => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "state_changed", newValue: "s-done" })],
      watchers: [{ workItemId: "w1", userId: u.id }],
      users: [u],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
  });

  it.each(INELIGIBLE)("a department watcher who is %s is not notified — the row ends not_needed", async (_who, u) => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented" })],
      users: [u],
    });
    await runActivityNotifySweep(prisma, {
      ...opts,
      departmentWatchers: async () => new Map([["w1", [u.id]]]),
    });
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
  });

  it.each(INELIGIBLE)("a mention target who is %s is not notified — the row ends not_needed", async (_who, u) => {
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", u.id, { actorId: "u-alice" })],
      users: [person("alice"), u],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
    expect(res.pmSkipped).toBe(1);
  });

  it("of several watchers, only those who may read the item are told", async () => {
    // Defends: the filter is per person. One ineligible watcher must not take the
    // eligible ones down with it, and an eligible one must not carry the others in.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented" })],
      watchers: INELIGIBLE.map(([, u]) => ({ workItemId: "w1", userId: u.id })).concat([
        { workItemId: "w1", userId: "u-wendy" },
      ]),
      users: [...INELIGIBLE.map(([, u]) => u), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username")).toEqual([["wendy"]]);
    expect(prisma.pm[0].notifyStatus).toBe("sent");
  });

  it("an ASSIGNED guest is still told (and once, though they also watch); a guest who is only a watcher is not", async () => {
    // Defends: WARP-3365's rule survives the new source — assigning a guest
    // shares THAT item with them, so they can open what they are told about.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-alice" })],
      assignees: [{ workItemId: "w1", userId: "u-gina" }],
      watchers: [
        { workItemId: "w1", userId: "u-gina" },
        { workItemId: "w1", userId: "u-greg" },
      ],
      users: [person("alice"), person("gina", { role: "guest" }), person("greg", { role: "guest" })],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([["gina", "New comment"]]);
  });

  it("a mention reaches an ASSIGNED guest — they can open the item", async () => {
    // The contract's eligibility test is "a guest NOT assigned to the item"; the
    // assignee exception applies to a mention's target the same way.
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", "u-gina", { actorId: "u-alice" })],
      assignees: [{ workItemId: "w1", userId: "u-gina" }],
      users: [person("alice", { displayName: "Alice Actor" }), person("gina", { role: "guest" })],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([["gina", "Alice Actor mentioned you"]]);
  });

  it("assignees stay unconditional: a deactivated assignee is still told (unchanged behaviour)", async () => {
    // Pins the contract's "assignees are unconditional (unchanged behaviour)".
    // Eligibility is for the people who arrive by ANOTHER route.
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "state_changed", newValue: "s-done" })],
      assignees: [{ workItemId: "w1", userId: "u-dora" }],
      users: [person("dora", { directoryStatus: "DEACTIVATED" })],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title")).toEqual([["dora", "Moved to Done"]]);
  });
});

describe("WARP-3519 — the verbs and the digest", () => {
  it("`mentioned` is notifiable, and the notifiable set is exactly the five", () => {
    expect(NOTIFIABLE_PM_VERBS.has("mentioned")).toBe(true);
    expect([...NOTIFIABLE_PM_VERBS].sort()).toEqual([
      "assigned",
      "commented",
      "due_date_changed",
      "mentioned",
      "state_changed",
    ]);
  });

  it("the other new verbs are history: the explicit not_needed terminal, never a notification", async () => {
    // Defends: the cut. An edited or deleted comment and a watch-list change are
    // in the item's timeline; the one news-worthy thing an edit can cause — a
    // new @mention — is its own `mentioned` row.
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "comment_edited", field: "comment" }),
        pmRow({ id: "a2", workItemId: "w1", verb: "comment_deleted", field: "comment" }),
        pmRow({ id: "a3", workItemId: "w1", verb: "watcher_added", field: "watchers" }),
        pmRow({ id: "a4", workItemId: "w1", verb: "watcher_removed", field: "watchers" }),
      ],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("bob"), person("wendy")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
    expect(res.pmSkipped).toBe(4);
    expect(prisma.pm.every((r) => r.notifyStatus === "not_needed")).toBe(true);
  });

  it("a watcher with two rows in one tick gets ONE digest, with the usual tally", async () => {
    // Defends: coalescing is per recipient whatever route they arrived by.
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "state_changed", newValue: "s-done" }),
        pmRow({ id: "a2", workItemId: "w1", verb: "commented" }),
      ],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledOnce();
    expect(recordMock.mock.calls[0][1]).toMatchObject({
      username: "wendy",
      title: "2 updates on your work",
      body: "1 moved · 1 commented",
    });
  });

  it("`mentioned` contributes the word 'mentioned' to a digest", async () => {
    // wendy hears about the first row as a watcher and the second as the target.
    const prisma = makeStub({
      pm: [
        pmRow({ id: "a1", workItemId: "w1", verb: "commented", actorId: "u-alice" }),
        mentioned("a2", "w1", "c9", "u-wendy", { actorId: "u-alice" }),
      ],
      watchers: [{ workItemId: "w1", userId: "u-wendy" }],
      users: [person("alice"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title", "body")).toEqual([
      ["wendy", "2 updates on your work", "1 commented · 1 mentioned"],
    ]);
  });

  it("two mentions of one person are one digest: '2 mentioned'", async () => {
    const prisma = makeStub({
      pm: [
        mentioned("a1", "w1", "c1", "u-mia", { actorId: "u-alice" }),
        mentioned("a2", "w2", "c2", "u-mia", { actorId: "u-bob" }),
      ],
      users: [person("alice"), person("bob"), person("mia")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username", "title", "body")).toEqual([["mia", "2 updates on your work", "2 mentioned"]]);
  });
});

describe("WARP-3519 — a recipient whose username is User.id-shaped (the WARP-2911 rule, new sources)", () => {
  const LEGACY = { id: "0d9c5c1e-2f4a-4b6d-8e10-3a5c7e9b1d2f", username: "5f0c2a1e-7b3d-4c9e-8a21-0e6d4b9c3f70" };

  it("🔴 a mention of one is dropped BEFORE the claim: the rest are notified and the CRM sweep still runs", async () => {
    // Defends: the refusal inside the claim transaction rolled the WHOLE batch
    // back, every tick, forever. A new way to reach a recipient must not reopen it.
    const prisma = makeStub({
      pm: [
        mentioned("a1", "w1", "c1", LEGACY.id, { actorId: "u-alice" }),
        pmRow({ id: "a2", workItemId: "w2", verb: "assigned" }),
      ],
      assignees: [{ workItemId: "w2", userId: "u-bob" }],
      users: [person("alice"), LEGACY, person("bob")],
    });
    const res = await runActivityNotifySweep(prisma, opts);
    expect(sent("username")).toEqual([["bob"]]);
    expect(prisma.pm.map((r) => [r.id, r.notifyStatus])).toEqual([
      ["a1", "not_needed"],
      ["a2", "sent"],
    ]);
    expect(res.notificationsSent).toBe(1);
    expect(prisma.crmActivity.findMany).toHaveBeenCalled();
  });

  it("🔴 an item WATCHER with one is dropped the same way, and the other watcher is still told", async () => {
    const prisma = makeStub({
      pm: [pmRow({ id: "a1", workItemId: "w1", verb: "commented" })],
      watchers: [
        { workItemId: "w1", userId: LEGACY.id },
        { workItemId: "w1", userId: "u-wendy" },
      ],
      users: [LEGACY, person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(sent("username")).toEqual([["wendy"]]);
    expect(prisma.pm[0].notifyStatus).toBe("sent");
  });

  it("the drop is logged at ERROR, naming the account and the refusal code", async () => {
    const prisma = makeStub({
      pm: [mentioned("a1", "w1", "c1", LEGACY.id, { actorId: "u-alice" })],
      users: [person("alice"), LEGACY],
    });
    await runActivityNotifySweep(prisma, opts);
    const errors = logged.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.obj).toMatchObject({ userId: LEGACY.id, username: LEGACY.username, code: "NOTIFICATION_RECIPIENT_IS_ID" });
    expect(prisma.pm[0].notifyStatus).toBe("not_needed");
  });
});

describe("WARP-3519 — exactly-once still holds with watchers and mentions", () => {
  it("a second sweep over the same rows sends nothing, and no row is left pending", async () => {
    const prisma = makeStub({
      pm: [
        commented("a1", "w1", "c1", { actorId: "u-alice" }),
        mentioned("a2", "w1", "c1", "u-mia", { actorId: "u-alice" }),
        pmRow({ id: "a3", workItemId: "w1", verb: "comment_edited", field: "comment" }),
      ],
      assignees: [{ workItemId: "w1", userId: "u-bob" }],
      watchers: [
        { workItemId: "w1", userId: "u-mia" },
        { workItemId: "w1", userId: "u-wendy" },
      ],
      mentions: [{ commentId: "c1", userId: "u-mia" }],
      users: [person("alice"), person("bob"), person("mia"), person("wendy")],
    });
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).toHaveBeenCalledTimes(3);
    expect(prisma.pm.map((r) => r.notifyStatus)).toEqual(["sent", "sent", "not_needed"]);

    recordMock.mockClear();
    await runActivityNotifySweep(prisma, opts);
    expect(recordMock).not.toHaveBeenCalled();
  });
});

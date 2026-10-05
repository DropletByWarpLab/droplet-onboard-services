// Time activity wakes must follow transaction commit, including timer switches.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./pm-outbox.js", () => ({ nudgeOutbox: vi.fn() }));
import { nudgeOutbox } from "./pm-outbox.js";
import { createWorklog, updateWorklog, deleteWorklog, startTimer, stopTimer } from "./pm-time.service.js";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";
import { READ_COMMITTED_TX } from "../../lib/prisma-tx.js";

const startedAt = new Date("2026-10-05T12:00:00Z");
const now = new Date("2026-10-05T12:10:00Z");
const actor = { id: "user-1", canManageAll: false };
const commitFailure = new Error("forced failure before transaction commit");

function fixture(rollback = false) {
  const items = new Map(["wi-1", "wi-2"].map((id) => [id, {
    id, name: id, sequenceId: id === "wi-1" ? 1 : 2, projectId: "p-1", isArchived: false,
    project: { identifier: "TEST", isArchived: false, kind: "PROJECT" },
  }]));
  const worklogs = new Map([["log-1", {
    id: "log-1", workItemId: "wi-1", userId: actor.id, startedAt, minutes: 10,
    note: "existing", createdAt: startedAt, updatedAt: startedAt,
  }]]);
  const timers = new Map([[actor.id, { userId: actor.id, workItemId: "wi-1", startedAt }]]);
  const activities: unknown[] = [];
  const wakeDuringTransaction: boolean[] = [];
  let inTransaction = false;
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: true }]),
    pmWorkItem: { findUnique: vi.fn(async ({ where }: any) => structuredClone(items.get(where.id) ?? null)) },
    pmWorklog: {
      findUnique: vi.fn(async ({ where }: any) => structuredClone(worklogs.get(where.id) ?? null)),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: "log-new", ...data, createdAt: now, updatedAt: now };
        worklogs.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...worklogs.get(where.id), ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)), updatedAt: now };
        worklogs.set(where.id, row as any);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => { const row = worklogs.get(where.id); worklogs.delete(where.id); return row; }),
    },
    pmTimer: {
      findUnique: vi.fn(async ({ where }: any) => structuredClone(timers.get(where.userId) ?? null)),
      delete: vi.fn(async ({ where }: any) => { const row = timers.get(where.userId); timers.delete(where.userId); return row; }),
      create: vi.fn(async ({ data }: any) => { timers.set(data.userId, data); return data; }),
    },
    pmActivity: { create: vi.fn(async ({ data }: any) => { activities.push(data); return data; }) },
  };
  const seam = createTransactionSeam({ client: () => tx, stores: { worklogs, timers, activities } });
  const transaction = vi.fn((callback: (client: any) => Promise<unknown>, options?: unknown) => seam.$transaction(async (client) => {
    inTransaction = true;
    try {
      const result = await callback(client);
      if (rollback) throw commitFailure;
      return result;
    } finally {
      inTransaction = false;
    }
  }, options));
  vi.mocked(nudgeOutbox).mockImplementation(() => { wakeDuringTransaction.push(inTransaction); });
  return { db: { $transaction: transaction } as never, worklogs, timers, activities, wakeDuringTransaction, seam };
}

beforeEach(() => vi.clearAllMocks());

describe("stage Time writes must wake the outbox only after commit", () => {
  const operations = [
    ["create worklog", (db: never) => createWorklog(db, actor, "wi-1", { minutes: 15 }, now)],
    ["edit worklog", (db: never) => updateWorklog(db, actor, "log-1", { minutes: 20 }, now)],
    ["delete worklog", (db: never) => deleteWorklog(db, actor, "log-1")],
    ["stop timer", (db: never) => stopTimer(db, actor.id, now)],
    ["switch timer", (db: never) => startTimer(db, actor.id, "wi-2", now)],
  ] as const;

  it.each(operations)("%s rollback restores persisted rows without any outbox wake", async (_name, run) => {
    const h = fixture(true);
    const previousWorklogs = structuredClone(h.worklogs);
    const previousTimers = structuredClone(h.timers);
    await expect(run(h.db)).rejects.toThrow(commitFailure.message);
    expect(h.worklogs).toEqual(previousWorklogs);
    expect(h.timers).toEqual(previousTimers);
    expect(h.activities).toEqual([]);
    expect(h.seam.calls()).toEqual([READ_COMMITTED_TX]);
    expect(nudgeOutbox).not.toHaveBeenCalled();
    expect(h.wakeDuringTransaction).toEqual([]);
  });

  it.each(operations)("%s wakes once after its activity commits", async (_name, run) => {
    const h = fixture();
    await run(h.db);
    expect(h.activities).toHaveLength(1);
    expect(h.seam.calls()).toEqual([READ_COMMITTED_TX]);
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
    expect(h.wakeDuringTransaction).toEqual([false]);
  });

  it("a committed timer switch wakes once after the old worklog and new timer commit", async () => {
    const h = fixture();
    const result = await startTimer(h.db, actor.id, "wi-2", now);
    expect(result.stopped?.workItemId).toBe("wi-1");
    expect(result.timer.workItemId).toBe("wi-2");
    expect(h.activities).toHaveLength(1);
    expect(h.timers.get(actor.id)?.workItemId).toBe("wi-2");
    expect(nudgeOutbox).toHaveBeenCalledTimes(1);
    expect(h.wakeDuringTransaction).toEqual([false]);
  });

  it("an unchanged worklog does not wake", async () => {
    const h = fixture();
    await updateWorklog(h.db, actor, "log-1", { minutes: 10 }, now);
    expect(h.activities).toEqual([]);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });

  it("starting the already-running item does not wake", async () => {
    const h = fixture();
    const result = await startTimer(h.db, actor.id, "wi-1", now);
    expect(result.stopped).toBeNull();
    expect(h.activities).toEqual([]);
    expect(nudgeOutbox).not.toHaveBeenCalled();
  });
});

/**
 * WARP-3532 / ADR-069 §7 — the PmActivity outbox consumer framework.
 *
 * `PmActivity` rows are written inside the transaction of the mutation they
 * describe, which makes the table a transactional outbox: a row exists if and
 * only if the change committed. This framework is the one reader. Each
 * consumer walks the rows in (createdAt, id) order from a cursor of its own,
 * stored in `SystemFlag` under `pm-outbox:<consumer>`.
 *
 * Unit level, against an in-memory Prisma that interprets exactly the query
 * shape the framework issues. What only a real database can prove — the
 * ordering of rows that share a millisecond, a rolled-back transaction's
 * invisibility, a late commit — is `__tests__/pm-outbox.pg.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PmActivity } from "@prisma/client";
import type { CronJobHandle, CronRuntime } from "../cron-runtime.service.js";
import {
  DEFAULT_OUTBOX_SETTLE_MS,
  OUTBOX_FLAG_PREFIX,
  advanceOutboxCursor,
  nudgeOutbox,
  outboxFlagKey,
  readOutboxBatch,
  registerOutboxConsumer,
  runOutboxSweep,
  stopOutbox,
  type OutboxConsumer,
} from "./pm-outbox.js";

// ── an in-memory Prisma for exactly the shapes pm-outbox issues ──────────────

type Where = {
  AND?: Where[];
  OR?: Where[];
  createdAt?: Date | { gt?: Date; lte?: Date };
  id?: { gt?: string };
};

function matches(row: PmActivity, where: Where): boolean {
  if (where.AND && !where.AND.every((w) => matches(row, w))) return false;
  if (where.OR && !where.OR.some((w) => matches(row, w))) return false;
  if (where.createdAt instanceof Date) {
    if (row.createdAt.getTime() !== where.createdAt.getTime()) return false;
  } else if (where.createdAt) {
    if (where.createdAt.gt && !(row.createdAt.getTime() > where.createdAt.gt.getTime())) return false;
    if (where.createdAt.lte && !(row.createdAt.getTime() <= where.createdAt.lte.getTime())) return false;
  }
  if (where.id?.gt !== undefined && !(row.id > where.id.gt)) return false;
  return true;
}

function activity(id: string, at: string, over: Partial<PmActivity> = {}): PmActivity {
  return {
    id,
    workItemId: "wi-1",
    actorId: "u-1",
    verb: "updated",
    field: null,
    oldValue: null,
    newValue: null,
    notifyStatus: "pending",
    notifiedAt: null,
    createdAt: new Date(at),
    ...over,
  } as PmActivity;
}

function makePrisma(rows: PmActivity[] = []) {
  const flags = new Map<string, unknown>();
  const findMany = vi.fn(async (args: { where: Where; orderBy: unknown; take: number }) =>
    rows
      .filter((r) => matches(r, args.where))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, args.take),
  );
  const prisma = {
    rows,
    flags,
    pmActivity: { findMany },
    systemFlag: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        flags.has(where.key) ? { key: where.key, valueJson: flags.get(where.key) } : null,
      ),
      createMany: vi.fn(async ({ data }: { data: Array<{ key: string; valueJson: unknown }> }) => {
        let count = 0;
        for (const d of data) {
          if (!flags.has(d.key)) {
            flags.set(d.key, d.valueJson);
            count += 1;
          }
        }
        return { count };
      }),
      upsert: vi.fn(
        async ({ where, create, update }: { where: { key: string }; create: { valueJson: unknown }; update: { valueJson: unknown } }) => {
          flags.set(where.key, flags.has(where.key) ? update.valueJson : create.valueJson);
          return { key: where.key };
        },
      ),
    },
  };
  return prisma;
}

const NOW = new Date("2026-10-04T12:00:00.000Z");
const clock = (at: Date = NOW) => () => at;

describe("outboxFlagKey", () => {
  it("keys a consumer's cursor under pm-outbox:<name> in SystemFlag", () => {
    expect(OUTBOX_FLAG_PREFIX).toBe("pm-outbox:");
    expect(outboxFlagKey("consumer-a")).toBe("pm-outbox:consumer-a");
  });
});

describe("readOutboxBatch", () => {
  it("starts a brand-new consumer at 'now' and never replays history", async () => {
    const old = activity("a-1", "2026-10-01T00:00:00.000Z");
    const prisma = makePrisma([old]);

    const batch = await readOutboxBatch(prisma as never, "consumer-a", 10, { now: clock(), settleMs: 0 });

    expect(batch).toEqual([]);
    expect(prisma.flags.get("pm-outbox:consumer-a")).toEqual({ createdAt: NOW.toISOString(), id: "" });
    // Insert-or-skip, so two replicas starting together cannot clobber each other.
    expect(prisma.systemFlag.createMany).toHaveBeenCalledWith({
      data: [{ key: "pm-outbox:consumer-a", valueJson: { createdAt: NOW.toISOString(), id: "" } }],
      skipDuplicates: true,
    });
  });

  it("returns rows strictly after the cursor in (createdAt, id) order", async () => {
    const prisma = makePrisma([
      activity("a-2", "2026-10-04T11:00:00.000Z"),
      activity("a-1", "2026-10-04T11:00:00.000Z"), // same millisecond as a-2: id breaks the tie
      activity("a-3", "2026-10-04T11:00:01.000Z"),
      activity("a-0", "2026-10-04T10:59:59.000Z"), // before the cursor
    ]);
    prisma.flags.set("pm-outbox:consumer-a", { createdAt: "2026-10-04T10:59:59.000Z", id: "a-0" });

    const batch = await readOutboxBatch(prisma as never, "consumer-a", 10, { now: clock(), settleMs: 0 });

    expect(batch.map((r) => r.id)).toEqual(["a-1", "a-2", "a-3"]);
  });

  it("resumes inside a millisecond: same createdAt, greater id", async () => {
    const prisma = makePrisma([
      activity("a-1", "2026-10-04T11:00:00.000Z"),
      activity("a-2", "2026-10-04T11:00:00.000Z"),
      activity("a-3", "2026-10-04T11:00:00.000Z"),
    ]);
    prisma.flags.set("pm-outbox:consumer-a", { createdAt: "2026-10-04T11:00:00.000Z", id: "a-1" });

    const batch = await readOutboxBatch(prisma as never, "consumer-a", 10, { now: clock(), settleMs: 0 });

    expect(batch.map((r) => r.id)).toEqual(["a-2", "a-3"]);
  });

  it("returns at most `limit` rows", async () => {
    const prisma = makePrisma(
      [1, 2, 3, 4, 5].map((n) => activity(`a-${n}`, `2026-10-04T11:00:0${n}.000Z`)),
    );
    prisma.flags.set("pm-outbox:consumer-a", { createdAt: "2026-10-04T10:00:00.000Z", id: "" });

    const batch = await readOutboxBatch(prisma as never, "consumer-a", 2, { now: clock(), settleMs: 0 });

    expect(batch.map((r) => r.id)).toEqual(["a-1", "a-2"]);
  });

  it("holds back rows younger than the settle window", async () => {
    // A row's createdAt is stamped when its INSERT is issued; its transaction
    // may commit up to Prisma's 5 s interactive timeout later. A reader that
    // advanced past a younger row could skip that late commit for good.
    const prisma = makePrisma([
      activity("a-old", "2026-10-04T11:59:50.000Z"),
      activity("a-young", "2026-10-04T11:59:59.000Z"),
    ]);
    prisma.flags.set("pm-outbox:consumer-a", { createdAt: "2026-10-04T10:00:00.000Z", id: "" });

    const batch = await readOutboxBatch(prisma as never, "consumer-a", 10, { now: clock(), settleMs: 6_000 });

    expect(batch.map((r) => r.id)).toEqual(["a-old"]);
  });

  it("settles after 6 s by default — Prisma's interactive-transaction timeout plus a margin", () => {
    expect(DEFAULT_OUTBOX_SETTLE_MS).toBe(6_000);
  });

  it("refuses to guess when the stored cursor is unreadable", async () => {
    const prisma = makePrisma();
    prisma.flags.set("pm-outbox:consumer-a", { nope: true });
    await expect(readOutboxBatch(prisma as never, "consumer-a", 10, { now: clock() })).rejects.toThrow(
      /pm-outbox:consumer-a/,
    );
  });
});

describe("advanceOutboxCursor", () => {
  it("stores the row's (createdAt, id) under the consumer's key", async () => {
    const prisma = makePrisma();
    await advanceOutboxCursor(prisma as never, "consumer-a", {
      id: "a-7",
      createdAt: new Date("2026-10-04T11:00:00.123Z"),
    });
    expect(prisma.flags.get("pm-outbox:consumer-a")).toEqual({
      createdAt: "2026-10-04T11:00:00.123Z",
      id: "a-7",
    });
  });

  it("keeps consumers' cursors apart", async () => {
    const prisma = makePrisma();
    await advanceOutboxCursor(prisma as never, "consumer-a", { id: "a-1", createdAt: NOW });
    await advanceOutboxCursor(prisma as never, "automation", { id: "a-9", createdAt: NOW });
    expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "a-1" });
    expect(prisma.flags.get("pm-outbox:automation")).toMatchObject({ id: "a-9" });
  });
});

// ── the sweep ────────────────────────────────────────────────────────────────

function consumer(over: Partial<OutboxConsumer> = {}): OutboxConsumer & { handle: ReturnType<typeof vi.fn> } {
  return {
    name: "consumer-a",
    intervalMs: 5_000,
    settleMs: 0,
    handle: vi.fn(async () => undefined),
    ...over,
  } as OutboxConsumer & { handle: ReturnType<typeof vi.fn> };
}

function logger() {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Rows a-1..a-n, one second apart, with the cursor parked before the first. */
function seeded(n: number) {
  const rows = Array.from({ length: n }, (_, i) =>
    activity(`a-${i + 1}`, new Date(Date.parse("2026-10-04T11:00:00.000Z") + i * 1000).toISOString()),
  );
  const prisma = makePrisma(rows);
  prisma.flags.set("pm-outbox:consumer-a", { createdAt: "2026-10-04T10:00:00.000Z", id: "" });
  return prisma;
}

describe("runOutboxSweep", () => {
  it("hands rows to the handler oldest first and advances the cursor after each", async () => {
    const prisma = seeded(3);
    const c = consumer();
    const seen: string[] = [];
    c.handle.mockImplementation(async (row: PmActivity) => {
      // The cursor still points BEFORE the row being handled.
      expect((prisma.flags.get("pm-outbox:consumer-a") as { id: string }).id).not.toBe(row.id);
      seen.push(row.id);
    });

    const result = await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });

    expect(seen).toEqual(["a-1", "a-2", "a-3"]);
    expect(result).toEqual({ handled: 3, deadLettered: 0 });
    expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "a-3" });
  });

  it("drains more than one batch in a single sweep", async () => {
    const prisma = seeded(5);
    const c = consumer({ batchSize: 2 });

    const result = await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });

    expect(c.handle).toHaveBeenCalledTimes(5);
    expect(result.handled).toBe(5);
    expect(prisma.pmActivity.findMany.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("is a no-op when there is nothing new", async () => {
    const prisma = seeded(2);
    const c = consumer();
    await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });
    c.handle.mockClear();

    const again = await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });

    expect(again).toEqual({ handled: 0, deadLettered: 0 });
    expect(c.handle).not.toHaveBeenCalled();
  });

  it("stops at a failing row, leaves the cursor before it, and rethrows so the scheduler counts it", async () => {
    const prisma = seeded(3);
    const c = consumer();
    c.handle.mockImplementation(async (row: PmActivity) => {
      if (row.id === "a-2") throw new Error("db unreachable");
    });

    await expect(
      runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() }),
    ).rejects.toThrow("db unreachable");

    expect(c.handle.mock.calls.map((call) => (call[0] as PmActivity).id)).toEqual(["a-1", "a-2"]);
    expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "a-1" });

    // The next sweep retries the SAME row — and then carries on.
    c.handle.mockReset();
    c.handle.mockResolvedValue(undefined);
    await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });
    expect(c.handle.mock.calls.map((call) => (call[0] as PmActivity).id)).toEqual(["a-2", "a-3"]);
  });

  it("is at-least-once: a crash between the handler and the cursor replays the row", async () => {
    // Why every handler must be idempotent. Simulated by making the cursor
    // write fail once, after the handler succeeded.
    const prisma = seeded(1);
    const c = consumer();
    prisma.systemFlag.upsert.mockRejectedValueOnce(new Error("connection reset"));

    await expect(runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() })).rejects.toThrow(
      "connection reset",
    );
    expect(c.handle).toHaveBeenCalledTimes(1);

    await runOutboxSweep(prisma as never, c, { now: clock(), logger: logger() });
    expect(c.handle).toHaveBeenCalledTimes(2);
    expect(c.handle.mock.calls[1]![0]).toMatchObject({ id: "a-1" });
  });

  describe("a row that never succeeds", () => {
    it("is dead-lettered after repeated failures over the poison window, so it cannot block the rest", async () => {
      const prisma = seeded(3);
      const log = logger();
      const c = consumer({ poisonAfterMs: 60_000 });
      c.handle.mockImplementation(async (row: PmActivity) => {
        if (row.id === "a-2") throw new Error("malformed");
      });

      let now = NOW.getTime();
      const deps = { now: () => new Date(now), logger: log };
      // Three failing sweeps inside the window: still retried, still rethrown.
      for (let i = 0; i < 3; i += 1) {
        await expect(runOutboxSweep(prisma as never, c, deps)).rejects.toThrow("malformed");
        now += 10_000;
      }
      expect(log.error).not.toHaveBeenCalled();
      expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "a-1" });

      // Past the window it is skipped LOUDLY and the sweep carries on to a-3.
      now += 60_000;
      const result = await runOutboxSweep(prisma as never, c, deps);
      expect(result).toEqual({ handled: 1, deadLettered: 1 });
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ consumer: "consumer-a", rowId: "a-2", verb: "updated", workItemId: "wi-1" }),
        expect.stringContaining("dead-lettered"),
      );
      expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "a-3" });
    });

    it("is not dead-lettered by a burst of failures inside the window (a DB blip is not poison)", async () => {
      const prisma = seeded(1);
      const log = logger();
      const c = consumer({ poisonAfterMs: 60_000 });
      c.handle.mockRejectedValue(new Error("db restarting"));
      const deps = { now: clock(), logger: log };

      for (let i = 0; i < 20; i += 1) {
        await expect(runOutboxSweep(prisma as never, c, deps)).rejects.toThrow("db restarting");
      }
      expect(log.error).not.toHaveBeenCalled();
      expect(prisma.flags.get("pm-outbox:consumer-a")).toMatchObject({ id: "" });
    });

    it("forgets a row's failures once it succeeds", async () => {
      const prisma = seeded(1);
      const log = logger();
      const c = consumer({ poisonAfterMs: 60_000 });
      c.handle.mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
      let now = NOW.getTime();
      const deps = { now: () => new Date(now), logger: log };

      await expect(runOutboxSweep(prisma as never, c, deps)).rejects.toThrow("blip");
      await runOutboxSweep(prisma as never, c, deps);
      expect(log.error).not.toHaveBeenCalled();
      expect(c.handle).toHaveBeenCalledTimes(2);
    });
  });
});

// ── registration and the nudge ───────────────────────────────────────────────

function fakeCronRuntime() {
  const handle: CronJobHandle = { runNow: vi.fn() };
  const scheduleInterval = vi.fn((_ms: number, _fn: () => void | Promise<void>, _opts?: unknown) => handle);
  const runtime = { scheduleInterval, scheduleCron: vi.fn(), stop: vi.fn() } as unknown as CronRuntime;
  return { runtime, scheduleInterval, handle };
}

describe("registerOutboxConsumer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopOutbox();
    vi.useRealTimers();
  });

  it("schedules an interval under its own advisory-lock key and runs once at registration", () => {
    const { runtime, scheduleInterval } = fakeCronRuntime();
    registerOutboxConsumer(consumer({ intervalMs: 2_000 }), { prisma: makePrisma() as never, cronRuntime: runtime });

    expect(scheduleInterval).toHaveBeenCalledTimes(1);
    const [ms, , opts] = scheduleInterval.mock.calls[0]!;
    expect(ms).toBe(2_000);
    expect(opts).toEqual({ lockKey: "droplet:pm-outbox:consumer-a", immediate: true });
  });

  it("the scheduled handler is the sweep", async () => {
    const prisma = seeded(2);
    const { runtime, scheduleInterval } = fakeCronRuntime();
    const c = consumer();
    registerOutboxConsumer(c, { prisma: prisma as never, cronRuntime: runtime, now: clock() });

    await scheduleInterval.mock.calls[0]![1]();

    expect(c.handle).toHaveBeenCalledTimes(2);
  });

  it("rejects a duplicate name and a name that is not a safe flag key", () => {
    const { runtime } = fakeCronRuntime();
    const deps = { prisma: makePrisma() as never, cronRuntime: runtime };
    registerOutboxConsumer(consumer(), deps);
    expect(() => registerOutboxConsumer(consumer(), deps)).toThrow(/already registered/);
    for (const bad of ["", "Uppercase", "a b", "a:b", "x".repeat(65)]) {
      expect(() => registerOutboxConsumer(consumer({ name: bad }), deps), bad).toThrow(/consumer name/);
    }
  });

  it("rejects an interval that is not a positive integer", () => {
    const { runtime } = fakeCronRuntime();
    const deps = { prisma: makePrisma() as never, cronRuntime: runtime };
    [0, -1, 1.5, Number.NaN].forEach((bad, i) => {
      expect(() => registerOutboxConsumer(consumer({ name: `interval-${i}`, intervalMs: bad }), deps), String(bad)).toThrow(
        /intervalMs/,
      );
    });
  });
});

describe("nudgeOutbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopOutbox();
    vi.useRealTimers();
  });

  it("importing the framework starts no timers", async () => {
    await vi.resetModules();
    await import("./pm-outbox.js");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a no-op — and starts no timer — when no consumer is registered", () => {
    nudgeOutbox();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes a consumer once its newest row has settled, not before", () => {
    const { runtime, handle } = fakeCronRuntime();
    registerOutboxConsumer(consumer({ settleMs: 6_000 }), { prisma: makePrisma() as never, cronRuntime: runtime });

    nudgeOutbox();
    vi.advanceTimersByTime(5_000);
    expect(handle.runNow).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(handle.runNow).toHaveBeenCalledTimes(1);
  });

  it("a consumer with no settle window is woken almost immediately", () => {
    const { runtime, handle } = fakeCronRuntime();
    registerOutboxConsumer(consumer({ settleMs: 0 }), { prisma: makePrisma() as never, cronRuntime: runtime });
    nudgeOutbox();
    vi.advanceTimersByTime(200);
    expect(handle.runNow).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of writes into one wake-up", () => {
    const { runtime, handle } = fakeCronRuntime();
    registerOutboxConsumer(consumer({ settleMs: 1_000 }), { prisma: makePrisma() as never, cronRuntime: runtime });

    for (let i = 0; i < 25; i += 1) {
      nudgeOutbox();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(5_000);

    expect(handle.runNow).toHaveBeenCalledTimes(1);
  });

  it("never keeps the process alive", () => {
    const { runtime } = fakeCronRuntime();
    registerOutboxConsumer(consumer(), { prisma: makePrisma() as never, cronRuntime: runtime });
    const unref = vi.spyOn(globalThis, "setTimeout");
    nudgeOutbox();
    const timer = unref.mock.results[0]!.value as { hasRef?: () => boolean };
    expect(timer.hasRef?.() ?? false).toBe(false);
    unref.mockRestore();
  });

  it("stopOutbox cancels a pending wake-up and forgets every consumer", () => {
    const { runtime, handle } = fakeCronRuntime();
    registerOutboxConsumer(consumer({ settleMs: 1_000 }), { prisma: makePrisma() as never, cronRuntime: runtime });
    nudgeOutbox();
    stopOutbox();
    vi.advanceTimersByTime(10_000);
    expect(handle.runNow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // …and the name is free again.
    expect(() =>
      registerOutboxConsumer(consumer(), { prisma: makePrisma() as never, cronRuntime: runtime }),
    ).not.toThrow();
  });
});

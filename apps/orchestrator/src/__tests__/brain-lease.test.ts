/**
 * WARP-2837 (ADR-051) — the brain pass lease, DB-less half.
 *
 * These cases pin the SHAPE of the claim: what predicate it sends, that it
 * fences its beat and release on the claiming worker, and that `runWithLease`
 * does not await the pass. Whether two racers can both win is a property of
 * Postgres, not of this code, and is proved in `brain-lease.pg.test.ts` — a
 * mocked `updateMany` returns whatever count it was told and cannot answer it.
 *
 * WHY THE FENCE MATTERS. `beatPass` and `releasePass` both condition on
 * `claimedBy = workerId`. A process whose lease was reclaimed after a long
 * stall must learn that at its next beat rather than by releasing the
 * SUCCESSOR's claim on its way out — which is precisely what an unconditional
 * update would do, and it would hand the pass to a third process while the
 * second was still running it.
 *
 * THREE MORE THINGS THIS FILE PROVES, each of them a review finding:
 *
 *   the boot sequence — seed, then tick, against a real in-memory store.
 *     `seedBrainPasses` seeded only the detector row, and once the tick
 *     claims before it runs, a row nobody created can never be claimed.
 *   shutdown           — a claim still mid-round-trip when SIGTERM lands is
 *     waited for, and one that wins afterwards is handed back rather than
 *     started on a process that is already tearing down.
 *   a pass that throws — `done` resolves and the failure is REPORTED with
 *     its pass, its worker and its streak. Nothing awaits `done`, so a
 *     rejection there is an untagged `unhandledRejection` and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

interface LoggedLine {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
/** A pass that throws is REPORTED rather than re-thrown, so the log line is the
 *  assertion surface. */
const logged = vi.hoisted(() => [] as LoggedLine[]);
vi.mock("../lib/logger.js", () => {
  const push = (level: string) => (obj: Record<string, unknown>, msg: string) => {
    logged.push({ level, obj, msg });
  };
  const stub = {
    warn: push("warn"),
    debug: push("debug"),
    info: push("info"),
    error: push("error"),
    trace: push("trace"),
    fatal: push("fatal"),
    silent: () => {},
    child: () => stub,
  };
  return { createLogger: () => stub };
});

import {
  claimPass,
  beatPass,
  releasePass,
  runWithLease,
  BRAIN_LEASE_MS,
  BRAIN_HEARTBEAT_MS,
} from "../services/brain/brain-lease.service";
import { seedBrainPasses, DETECTOR_PASS_KEY } from "../services/brain/brain-pass.service";
import { CORPUS_PASS_KEY } from "../services/brain/brain-corpus.service";

const NOW = new Date("2033-06-10T12:00:00.000Z");
const KEY = "corpus.documents";
const W = "worker-a";

/** The one argument shape these assertions read back. Typed EXPLICITLY: an
 *  untyped `vi.fn` infers a zero-length tuple, so `mock.calls[0][0]` is a tsc
 *  error under `typecheck:tests` while vitest itself runs it happily —
 *  vitest strips types without checking them (WARP-2606). */
type UpdateArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function prismaWith(count: number, row: { enabled: boolean } | null = { enabled: true }) {
  const updateMany = vi.fn(async (_args: UpdateArgs) => ({ count }));
  const findUnique = vi.fn(async () => row);
  return {
    client: { brainPass: { updateMany, findUnique } } as unknown as PrismaClient,
    updateMany,
    findUnique,
  };
}

/**
 * A `BrainPass` table in memory: the one thing `prismaWith` cannot express.
 *
 * `prismaWith` returns whatever count it was told, so it pins the claim's SHAPE
 * and nothing else. The boot deadlock is about whether the row EXISTS —
 * `updateMany` matches nothing, `findUnique` returns null — and only a store
 * can answer that. Enough of Prisma's `where` grammar for the claim predicate
 * to be evaluated honestly: scalar equality, `null`, `{ lt }`, and `OR`.
 */
type PassRow = {
  passKey: string;
  enabled: boolean;
  runState: "idle" | "running";
  claimedBy: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  lastRunAt: Date | null;
};

function passRowMatches(row: PassRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === "OR") {
      const arms = expected as Array<Record<string, unknown>>;
      return arms.some((arm) => passRowMatches(row, arm));
    }
    const actual = (row as unknown as Record<string, unknown>)[field];
    if (expected !== null && typeof expected === "object" && "lt" in expected) {
      const { lt } = expected as { lt: Date };
      return actual instanceof Date && actual.getTime() < lt.getTime();
    }
    return actual === expected;
  });
}

function makeBrainPassStore() {
  const rows = new Map<string, PassRow>();
  const blank = (passKey: string): PassRow => ({
    passKey,
    enabled: true,
    runState: "idle",
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    lastRunAt: null,
  });
  const client = {
    brainPass: {
      async upsert(args: { where: { passKey: string }; create: { passKey: string } }) {
        // `update: {}` — seeding a row that already exists revises nothing,
        // which is how an operator's `enabled: false` survives a reboot.
        const existing = rows.get(args.where.passKey);
        if (existing) return existing;
        const row = blank(args.create.passKey);
        rows.set(row.passKey, row);
        return row;
      },
      async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        let count = 0;
        for (const row of rows.values()) {
          if (!passRowMatches(row, args.where)) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
      async findUnique(args: { where: { passKey: string } }) {
        return rows.get(args.where.passKey) ?? null;
      },
    },
  } as unknown as PrismaClient;
  return { client, row: (passKey: string) => rows.get(passKey), keys: () => [...rows.keys()] };
}

beforeEach(() => {
  vi.useRealTimers();
  logged.length = 0;
});

describe("claimPass (WARP-2837)", () => {
  it("wins when the conditional update touches exactly one row", async () => {
    const { client } = prismaWith(1);
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({ won: true, workerId: W });
  });

  it("claims an IDLE pass or one whose lease has gone stale, and nothing else", async () => {
    const { client, updateMany } = prismaWith(1);
    await claimPass(client, KEY, NOW, W);
    const where = updateMany.mock.calls[0]![0].where as {
      enabled: boolean;
      OR: Array<Record<string, unknown>>;
    };
    // The per-pass switch is IN the predicate, so a disabled pass cannot be
    // started by a tick or by any future manual trigger without either of them
    // remembering to check.
    expect(where.enabled).toBe(true);
    expect(where.OR).toContainEqual({ runState: "idle" });
    expect(where.OR).toContainEqual({
      runState: "running",
      heartbeatAt: { lt: new Date(NOW.getTime() - BRAIN_LEASE_MS) },
    });
    // A `running` row with no heartbeat at all must read as reclaimable, not
    // as held forever by a process that no longer exists.
    expect(where.OR).toContainEqual({ runState: "running", heartbeatAt: null });
  });

  it("stamps the worker, the clock and lastRunAt in the same statement", async () => {
    const { client, updateMany } = prismaWith(1);
    await claimPass(client, KEY, NOW, W);
    expect(updateMany.mock.calls[0]![0].data).toEqual({
      runState: "running",
      claimedBy: W,
      claimedAt: NOW,
      heartbeatAt: NOW,
      lastRunAt: NOW,
    });
  });

  it("reports BUSY when it lost and the pass is enabled", async () => {
    const { client } = prismaWith(0, { enabled: true });
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "busy",
    });
  });

  it("distinguishes DISABLED from busy", async () => {
    // Different answers. A caller that conflates them reports a pass an
    // operator deliberately switched off as a concurrency problem.
    const { client } = prismaWith(0, { enabled: false });
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "disabled",
    });
  });

  it("reports MISSING when there is no such pass row", async () => {
    const { client } = prismaWith(0, null);
    await expect(claimPass(client, KEY, NOW, W)).resolves.toEqual({
      won: false,
      reason: "missing",
    });
  });
});

describe("beatPass / releasePass — the fence (WARP-2837)", () => {
  it("beats only while THIS worker still holds the claim", async () => {
    const { client, updateMany } = prismaWith(1);
    await expect(beatPass(client, KEY, NOW, W)).resolves.toBe(true);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      passKey: KEY,
      runState: "running",
      claimedBy: W,
    });
  });

  it("reports a LOST lease rather than re-taking it", async () => {
    const { client } = prismaWith(0);
    await expect(beatPass(client, KEY, NOW, W)).resolves.toBe(false);
  });

  it("releases only its own claim, never a successor's", async () => {
    // The case an unconditional update would get wrong: a stalled process
    // waking up and releasing the run that replaced it.
    const { client, updateMany } = prismaWith(0);
    await expect(releasePass(client, KEY, W)).resolves.toBe(false);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      passKey: KEY,
      runState: "running",
      claimedBy: W,
    });
  });

  it("clears the whole claim on a successful release", async () => {
    const { client, updateMany } = prismaWith(1);
    await releasePass(client, KEY, W);
    expect(updateMany.mock.calls[0]![0].data).toEqual({
      runState: "idle",
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
    });
  });
});

describe("runWithLease (WARP-2837)", () => {
  it("does NOT run the pass when the claim is lost", async () => {
    const { client } = prismaWith(0, { enabled: true });
    const run = vi.fn(async () => {});
    const out = await runWithLease(client, KEY, run, { now: NOW, workerId: W });
    expect(out.started).toBe(false);
    expect(out.reason).toBe("busy");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns BEFORE the pass finishes — the tick must not await ten inferences", async () => {
    // The property the whole fix rests on. If this ever awaits, a corpus run
    // is back on the cron tick's shoulders and the transaction problem
    // returns in a new shape.
    const { client } = prismaWith(1);
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));

    const out = await runWithLease(client, KEY, run, { now: NOW, workerId: W });
    expect(out.started).toBe(true);
    expect(run).toHaveBeenCalledOnce();

    let settled = false;
    void out.done!.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // still running, and we already returned

    release();
    await out.done;
    expect(settled).toBe(true);
  });

  it("releases the claim even when the pass THROWS", async () => {
    const { client, updateMany } = prismaWith(1);
    const out = await runWithLease(
      client,
      KEY,
      async () => {
        throw new Error("inference_failed");
      },
      { now: NOW, workerId: W },
    );
    // `done` RESOLVES. It used to reject, and nothing subscribed: not the tick
    // (deliberately), not a boot run, not a manual trigger. The rejection
    // became an untagged `unhandledRejection`, and the failure lost its pass,
    // its worker and its failure count on the way out.
    await expect(out.done).resolves.toBeUndefined();
    const released = updateMany.mock.calls.some(
      (c) => (c[0] as { data?: Record<string, unknown> }).data?.runState === "idle",
    );
    expect(released).toBe(true);
  });

  it("REPORTS the failure with the pass, the worker and the streak", async () => {
    // Its own pass key: the streak is module state, and this case must not
    // read a count some earlier case in this file left behind.
    const STREAK_KEY = "warp2837-streak";
    const { client } = prismaWith(1);
    const boom = async () => {
      throw new Error("inference_failed");
    };

    await (await runWithLease(client, STREAK_KEY, boom, { now: NOW, workerId: W })).done;
    const first = logged.filter((l) => l.msg === "brain.pass.failed").at(-1);
    expect(first?.level).toBe("error");
    expect(first?.obj.passKey).toBe(STREAK_KEY);
    expect(first?.obj.workerId).toBe(W);
    expect((first?.obj.err as Error).message).toBe("inference_failed");
    // The counter cron-runtime's `safeRun` keeps for every other tick, and that
    // this pass lost the moment the tick stopped awaiting it.
    expect(first?.obj.consecutiveFailures).toBe(1);

    await (await runWithLease(client, STREAK_KEY, boom, { now: NOW, workerId: W })).done;
    expect(
      logged.filter((l) => l.msg === "brain.pass.failed").at(-1)?.obj.consecutiveFailures,
    ).toBe(2);

    // A clean run ends the streak: eleven-in-a-row and one-then-recovered are
    // different operator problems and the message is otherwise identical.
    await (await runWithLease(client, STREAK_KEY, async () => {}, { now: NOW, workerId: W })).done;
    await (await runWithLease(client, STREAK_KEY, boom, { now: NOW, workerId: W })).done;
    expect(
      logged.filter((l) => l.msg === "brain.pass.failed").at(-1)?.obj.consecutiveFailures,
    ).toBe(1);
  });

  it("beats on a timer, not per unit — a slow model call keeps its lease", async () => {
    // Iteration-driven beating would drop the claim on exactly the box this
    // fix exists for: one unit is one CPU inference.
    vi.useFakeTimers();
    const { client, updateMany } = prismaWith(1);
    let release!: () => void;
    const out = await runWithLease(client, KEY, () => new Promise<void>((r) => (release = r)), {
      now: NOW,
      workerId: W,
      heartbeatMs: 1000,
    });
    updateMany.mockClear();
    await vi.advanceTimersByTimeAsync(3500);
    expect(updateMany.mock.calls.length).toBeGreaterThanOrEqual(3);
    release();
    await out.done;
    vi.useRealTimers();
  });

  it("keeps the heartbeat well inside the lease", () => {
    // The ratio is what absorbs a slow unit or a paused container without
    // losing the claim.
    expect(BRAIN_HEARTBEAT_MS * 5).toBeLessThanOrEqual(BRAIN_LEASE_MS);
  });
});

/**
 * 🔴 THE FRESH-INSTALL BOOT SEQUENCE, end to end.
 *
 * `seedBrainPasses` seeded ONLY the detector row. That was survivable while the
 * tick called `runCorpusPass` directly, because the pass's own upsert created
 * its row on tick 1. The lease inverted the order: the tick claims FIRST, and
 * `claimPass` is a conditional `updateMany` — zero rows matched, `findUnique`
 * null, `reason: "missing"`, and the run that would have created the row never
 * happened. On a genuinely fresh box that repeats every tick, at `debug`,
 * forever, with nothing in the system able to un-wedge it.
 *
 * These cases run the real boot order against a real store: seed, then tick.
 */
describe("a fresh box boots (WARP-2837)", () => {
  it("seeds EVERY pass, not just the detector one", async () => {
    const db = makeBrainPassStore();
    await seedBrainPasses(db.client);
    expect(db.keys()).toEqual([DETECTOR_PASS_KEY, CORPUS_PASS_KEY]);
  });

  it("boot then first tick: the corpus pass actually RUNS", async () => {
    const db = makeBrainPassStore(); // a genuinely empty DB
    await seedBrainPasses(db.client); // index.ts, inside `if (config.brain.enabled)`
    const run = vi.fn(async () => {});

    const lease = await runWithLease(db.client, CORPUS_PASS_KEY, run, { now: NOW, workerId: W });
    expect(lease.started).toBe(true);
    await lease.done;

    expect(run).toHaveBeenCalledOnce();
    // ...and it handed the row back, so the SECOND tick can have it too.
    expect(db.row(CORPUS_PASS_KEY)?.runState).toBe("idle");
    expect(db.row(CORPUS_PASS_KEY)?.claimedBy).toBeNull();
    expect(db.row(CORPUS_PASS_KEY)?.lastRunAt).toEqual(NOW);
  });

  it("REGRESSION: an unseeded pass deadlocks, and no number of ticks fixes it", async () => {
    // The claim cannot create the row, and the only thing that could —
    // `runCorpusPass`'s own upsert — sits downstream of the claim.
    const db = makeBrainPassStore();
    const run = vi.fn(async () => {});
    for (let tick = 0; tick < 3; tick += 1) {
      const lease = await runWithLease(db.client, CORPUS_PASS_KEY, run, { now: NOW, workerId: W });
      expect(lease).toEqual({ started: false, reason: "missing" });
    }
    expect(run).not.toHaveBeenCalled();
    expect(db.row(CORPUS_PASS_KEY)).toBeUndefined();
  });

  it("reboots idempotently, and never re-enables a pass an operator switched off", async () => {
    const db = makeBrainPassStore();
    await seedBrainPasses(db.client);
    const off = db.row(CORPUS_PASS_KEY);
    expect(off).toBeDefined();
    off!.enabled = false;

    await seedBrainPasses(db.client); // reboot
    expect(db.keys()).toHaveLength(2);
    expect(db.row(CORPUS_PASS_KEY)?.enabled).toBe(false);

    const lease = await runWithLease(db.client, CORPUS_PASS_KEY, async () => {}, {
      now: NOW,
      workerId: W,
    });
    expect(lease).toEqual({ started: false, reason: "disabled" });
  });
});

/**
 * 🔴 SHUTDOWN, including the window `inFlight` alone did not cover.
 *
 * `cronRuntime.stop()` clears intervals and knows nothing about a tick already
 * dispatched as `void safeRun(...)`. The pass was registered in `inFlight` only
 * AFTER `claimPass` resolved, so a SIGTERM inside that round trip found an
 * empty map, `releaseAllPasses()` returned having waited for nothing, and the
 * claim then won and started ten model calls on a dying process.
 *
 * Fresh module registry per case: the shutdown latch is process-lifetime state,
 * and a process shuts down once.
 */
describe("releaseAllPasses (WARP-2837)", () => {
  async function freshLease() {
    vi.resetModules();
    return await import("../services/brain/brain-lease.service.js");
  }

  function alwaysWins() {
    const updateMany = vi.fn(async (_args: UpdateArgs) => ({ count: 1 }));
    const findUnique = vi.fn(async () => ({ enabled: true }));
    return {
      client: { brainPass: { updateMany, findUnique } } as unknown as PrismaClient,
      updateMany,
    };
  }

  it("waits for a claim that was still MID-ROUND-TRIP when shutdown began", async () => {
    const lease = await freshLease();
    let answerClaim!: (v: { count: number }) => void;
    let firstCall = true;
    const updateMany = vi.fn(async (_args: UpdateArgs) => {
      if (!firstCall) return { count: 1 }; // the release on the way out
      firstCall = false;
      return new Promise<{ count: number }>((resolve) => (answerClaim = resolve));
    });
    const findUnique = vi.fn(async () => ({ enabled: true }));
    const client = { brainPass: { updateMany, findUnique } } as unknown as PrismaClient;

    const run = vi.fn(async () => {});
    // The tick has fired and its claim is in flight. NOT awaited: that is
    // exactly the window a SIGTERM lands in.
    const attempt = lease.runWithLease(client, KEY, run, { now: NOW, workerId: W });

    let shutdownDone = false;
    const shutdown = lease.releaseAllPasses().then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Before this fix `inFlight` was empty here and shutdown returned at once.
    expect(shutdownDone).toBe(false);

    answerClaim({ count: 1 });
    await shutdown;

    // The claim won on a process that is already going away, so it is handed
    // straight back rather than allowed to start ten inferences.
    await expect(attempt).resolves.toEqual({ started: false, reason: "shutting_down" });
    expect(run).not.toHaveBeenCalled();
    const released = updateMany.mock.calls.some(
      (c) => (c[0] as { data?: Record<string, unknown> }).data?.runState === "idle",
    );
    expect(released).toBe(true);
  });

  it("waits for a pass that was already RUNNING when shutdown began", async () => {
    const lease = await freshLease();
    const { client } = alwaysWins();
    let finish!: () => void;
    const out = await lease.runWithLease(client, KEY, () => new Promise<void>((r) => (finish = r)), {
      now: NOW,
      workerId: W,
    });
    expect(out.started).toBe(true);

    let shutdownDone = false;
    const shutdown = lease.releaseAllPasses().then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownDone).toBe(false);

    finish();
    await shutdown;
    expect(shutdownDone).toBe(true);
    expect(lease.inFlightPasses().size).toBe(0);
  });

  it("refuses a NEW pass once shutdown has begun, without touching the DB", async () => {
    const lease = await freshLease();
    const { client, updateMany } = alwaysWins();
    await lease.releaseAllPasses();

    const run = vi.fn(async () => {});
    await expect(lease.runWithLease(client, KEY, run, { now: NOW, workerId: W })).resolves.toEqual({
      started: false,
      reason: "shutting_down",
    });
    expect(run).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

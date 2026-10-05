import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCronRuntime,
  type CronRuntimeLogger,
  type CronRuntimePrisma,
} from "./cron-runtime.service.js";
import { RouterError } from "../types/router-error.js";

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies CronRuntimeLogger;
}

/**
 * Minimal Prisma stub modelling the transaction-scoped advisory lock
 * (`pg_try_advisory_xact_lock`). The runtime acquires the lock inside a
 * `$transaction`; the lock is released implicitly when that transaction
 * settles, so there is NO explicit unlock statement. The stub records
 * transaction begin/end so a test can assert connection-safe release.
 *
 * Pass `{ lockAcquired: true }` (default) for the "we got the lock" path,
 * or `false` for the "another instance has it" path. `onTxSettle` fires
 * once per `$transaction` callback completion (commit OR rollback) — the
 * point at which Postgres would auto-release the xact lock.
 */
function makePrismaStub(
  opts: { lockAcquired?: boolean; onTxSettle?: (committed: boolean) => void } = {},
): CronRuntimePrisma & { $queryRawUnsafe: ReturnType<typeof vi.fn> } {
  const acquired = opts.lockAcquired ?? true;
  const $queryRawUnsafe = vi.fn(async (sql: string, ..._args: unknown[]) => {
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return [{ locked: acquired }];
    }
    return [];
  });
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    // All lock statements + the handler run on the SAME tx handle — this
    // is what guarantees acquire and (implicit) release share a backend.
    try {
      const out = await fn({ $queryRawUnsafe });
      opts.onTxSettle?.(true);
      return out;
    } catch (err) {
      // Rollback path — Postgres still releases the xact lock here.
      opts.onTxSettle?.(false);
      throw err;
    }
  });
  return { $queryRawUnsafe, $transaction } as any;
}

describe("cron-runtime.service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scheduleInterval fires handler after each interval", async () => {
    const rt = createCronRuntime();
    const handler = vi.fn();
    rt.scheduleInterval(1000, handler);
    await vi.advanceTimersByTimeAsync(3500);
    expect(handler).toHaveBeenCalledTimes(3);
    rt.stop();
  });

  it("scheduleInterval does NOT run at registration by default (the first tick waits a full interval)", async () => {
    const rt = createCronRuntime();
    const handler = vi.fn();
    rt.scheduleInterval(1000, handler);
    await vi.advanceTimersByTimeAsync(999);
    expect(handler).not.toHaveBeenCalled();
    rt.stop();
  });

  // WARP-2977 P2b-2 (review F9): a job whose health reads "down" until its first run opts in.
  it("immediate: one run at registration, then every interval — through the same advisory lock", async () => {
    const prisma = makePrismaStub({ lockAcquired: true });
    const rt = createCronRuntime(prisma, makeLogger());
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-now", immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    const lockCalls = () =>
      prisma.$queryRawUnsafe.mock.calls.filter((c) => String(c[0]).includes("pg_try_advisory_xact_lock"));
    expect(lockCalls()).toHaveLength(1);
    expect(lockCalls()[0]![1]).toBe("test:lock-now");
    await vi.advanceTimersByTimeAsync(2500);
    expect(handler).toHaveBeenCalledTimes(3);
    rt.stop();
  });

  it("immediate with the lock held elsewhere: the registration run is skipped like any tick", async () => {
    const prisma = makePrismaStub({ lockAcquired: false });
    const rt = createCronRuntime(prisma, makeLogger());
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-held", immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
    rt.stop();
  });

  it("immediate: a throwing first run is contained and counted like any tick", async () => {
    const logger = makeLogger();
    const rt = createCronRuntime(undefined, logger);
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    rt.scheduleInterval(1000, handler, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ consecutiveFailures: 1 }), expect.any(String));
    rt.stop();
  });

  it("stop() prevents further handler calls", async () => {
    const rt = createCronRuntime();
    const handler = vi.fn();
    rt.scheduleInterval(1000, handler);
    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    rt.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handler exceptions don't crash the runtime", async () => {
    const rt = createCronRuntime();
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    rt.scheduleInterval(1000, handler);
    await vi.advanceTimersByTimeAsync(3000);
    // No throw; handler was still called 3 times
    expect(handler).toHaveBeenCalledTimes(3);
    rt.stop();
  });

  it("tracks consecutive failures and logs at error for unexpected errors", async () => {
    const logger = makeLogger();
    const rt = createCronRuntime(undefined, logger);
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    rt.scheduleInterval(1000, handler);

    await vi.advanceTimersByTimeAsync(3500);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.warn).not.toHaveBeenCalled();

    // Third call's context should carry consecutiveFailures: 3.
    const thirdCallCtx = logger.error.mock.calls[2][0];
    expect(thirdCallCtx).toMatchObject({ consecutiveFailures: 3 });

    rt.stop();
  });

  it("logs RouterError at warn (not error)", async () => {
    const logger = makeLogger();
    const rt = createCronRuntime(undefined, logger);
    const handler = vi
      .fn()
      .mockRejectedValue(RouterError.unreachable("router down"));
    rt.scheduleInterval(1000, handler);

    await vi.advanceTimersByTimeAsync(1500);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    rt.stop();
  });

  it("success resets consecutive-failure counter", async () => {
    const logger = makeLogger();
    const rt = createCronRuntime(undefined, logger);

    // Fail twice, then succeed, then fail again → final failure ctx should be 1.
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("c"));
    rt.scheduleInterval(1000, handler);

    await vi.advanceTimersByTimeAsync(4500);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledTimes(3);
    // Streak was 1, 2, (reset on success), then 1 again.
    expect(logger.error.mock.calls[0][0]).toMatchObject({ consecutiveFailures: 1 });
    expect(logger.error.mock.calls[1][0]).toMatchObject({ consecutiveFailures: 2 });
    expect(logger.error.mock.calls[2][0]).toMatchObject({ consecutiveFailures: 1 });

    rt.stop();
  });

  // ── Critical fix #1: advisory-lock path ──

  it("runs handler when advisory lock is acquired, inside a single transaction", async () => {
    const prisma = makePrismaStub({ lockAcquired: true });
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-a" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);

    // The transaction-scoped try-lock should have been issued; the lock is
    // released implicitly at txn end, so there is NO explicit unlock.
    const sqls = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("pg_try_advisory_xact_lock"))).toBe(true);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);
    // Acquire + handler ran inside exactly one $transaction.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);

    rt.stop();
  });

  it("skips handler when advisory lock is NOT acquired (another instance has it)", async () => {
    const prisma = makePrismaStub({ lockAcquired: false });
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-b" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).not.toHaveBeenCalled();

    // Debug log should have fired for the skip.
    expect(logger.debug).toHaveBeenCalled();
    // The transaction still opened to attempt the lock.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);

    rt.stop();
  });

  it("releases advisory lock (commits the txn) after handler completes successfully", async () => {
    let committed: boolean | undefined;
    const prisma = makePrismaStub({
      lockAcquired: true,
      onTxSettle: (ok) => {
        committed = ok;
      },
    });
    const rt = createCronRuntime(prisma);
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-c" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    // Transaction committed → Postgres auto-releases the xact lock.
    expect(committed).toBe(true);

    rt.stop();
  });

  it("releases advisory lock even when handler throws (txn rolls back)", async () => {
    let committed: boolean | undefined;
    const prisma = makePrismaStub({
      lockAcquired: true,
      onTxSettle: (ok) => {
        committed = ok;
      },
    });
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);
    const handler = vi.fn().mockRejectedValue(new Error("handler blew up"));
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-d" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    // Handler threw → transaction rolled back, which still releases the
    // xact lock (no leak path), and safeRun logged the error.
    expect(committed).toBe(false);
    expect(logger.error).toHaveBeenCalled();

    rt.stop();
  });

  // ── WARP-3193 PERF-1: no overlap, and no lock lost mid-run ──

  it("never overlaps a handler with itself: a tick during a run is skipped", async () => {
    const logger = makeLogger();
    const rt = createCronRuntime(undefined, logger);
    let running = 0;
    let maxRunning = 0;
    const handler = vi.fn(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 3500));
      running -= 1;
    });
    rt.scheduleInterval(1000, handler);

    // Ticks at 1s, 2s, 3s, 4s: the run started at 1s ends at 4.5s, so the
    // 2s/3s/4s ticks must all be skipped rather than stacked.
    await vi.advanceTimersByTimeAsync(4200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(maxRunning).toBe(1);

    // Once the run finishes the next tick runs normally.
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(maxRunning).toBe(1);
    rt.stop();
  });

  it("overlap guard is per registration, and also covers scheduleCron", async () => {
    const rt = createCronRuntime();
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((r) => (release = r)));
    const other = vi.fn(async () => {});
    rt.scheduleCron("* * * * * *", slow);
    rt.scheduleInterval(1000, other);

    await vi.advanceTimersByTimeAsync(3500);
    // The cron job is stuck in its first run: later cron ticks are skipped.
    expect(slow).toHaveBeenCalledTimes(1);
    // A different registration is not held back by it.
    expect(other).toHaveBeenCalledTimes(3);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    rt.stop();
  });

  it("scheduleInterval { immediate: true } runs once at registration, under the same overlap guard", async () => {
    const rt = createCronRuntime();
    let release!: () => void;
    const handler = vi.fn(() => new Promise<void>((r) => (release = r)));
    rt.scheduleInterval(1000, handler, { immediate: true });

    // Ran at once, without waiting a full interval...
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    // ...and the interval ticks while that first run is still going are skipped.
    await vi.advanceTimersByTimeAsync(2500);
    expect(handler).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(2);
    rt.stop();
  });

  // WARP-3532 — `scheduleInterval` hands back a handle so a registration can be
  // run EARLY (the PmActivity outbox wakes its consumers after a write) without
  // growing a second lock/overlap path beside this one.
  describe("scheduleInterval handle: runNow()", () => {
    it("runs the handler now, without waiting for the interval", async () => {
      const rt = createCronRuntime();
      const handler = vi.fn(async () => {});
      const job = rt.scheduleInterval(60_000, handler);
      expect(handler).not.toHaveBeenCalled();
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(1);
      rt.stop();
    });

    it("goes through the same advisory lock as a tick", async () => {
      const prisma = makePrismaStub({ lockAcquired: true });
      const rt = createCronRuntime(prisma, makeLogger());
      const handler = vi.fn(async () => {});
      const job = rt.scheduleInterval(60_000, handler, { lockKey: "test:run-now" });
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      const lockCalls = prisma.$queryRawUnsafe.mock.calls.filter((c) =>
        String(c[0]).includes("pg_try_advisory_xact_lock"),
      );
      expect(lockCalls).toHaveLength(1);
      expect(lockCalls[0]![1]).toBe("test:run-now");
      expect(handler).toHaveBeenCalledTimes(1);
      rt.stop();
    });

    it("is skipped when the lock is held elsewhere, like any tick", async () => {
      const prisma = makePrismaStub({ lockAcquired: false });
      const rt = createCronRuntime(prisma, makeLogger());
      const handler = vi.fn(async () => {});
      const job = rt.scheduleInterval(60_000, handler, { lockKey: "test:run-now-held" });
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).not.toHaveBeenCalled();
      rt.stop();
    });

    it("never overlaps the run already in flight — an early run is skipped, not queued", async () => {
      const rt = createCronRuntime();
      let release!: () => void;
      let running = 0;
      let maxRunning = 0;
      const handler = vi.fn(
        () =>
          new Promise<void>((r) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            release = () => {
              running -= 1;
              r();
            };
          }),
      );
      const job = rt.scheduleInterval(1000, handler);
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      job.runNow();
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      // The skipped early runs were NOT queued behind the first one.
      expect(handler).toHaveBeenCalledTimes(1);
      expect(maxRunning).toBe(1);
      // A later one runs normally.
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledTimes(2);
      rt.stop();
    });

    it("contains and counts a failure like any tick", async () => {
      const logger = makeLogger();
      const rt = createCronRuntime(undefined, logger);
      const handler = vi.fn(async () => {
        throw new Error("boom");
      });
      const job = rt.scheduleInterval(60_000, handler);
      job.runNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveFailures: 1 }),
        expect.any(String),
      );
      rt.stop();
    });
  });

  it("a locked handler that outlives 60 s keeps the advisory lock for its whole run", async () => {
    // Model Prisma's interactive-transaction timeout: when it expires the
    // transaction is rolled back and Postgres releases the xact lock, while
    // the handler (which is not cancelled) keeps running. That is the bug.
    const events: string[] = [];
    const $queryRawUnsafe = vi.fn(async () => [{ locked: true }]);
    const $transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>, opts?: { timeout?: number }) => {
        const timeout = opts?.timeout ?? 5_000; // Prisma's default
        const expiry = setTimeout(() => events.push("lock-released-by-timeout"), timeout);
        try {
          return await fn({ $queryRawUnsafe });
        } finally {
          clearTimeout(expiry);
          events.push("lock-released-at-tx-end");
        }
      },
    );
    const prisma = { $queryRawUnsafe, $transaction } as unknown as CronRuntimePrisma;
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);

    // e.g. the OTA apply window: pull + recreate takes many minutes.
    const handler = vi.fn(async () => {
      events.push("handler-start");
      await new Promise((r) => setTimeout(r, 45 * 60_000));
      events.push("handler-end");
    });
    rt.scheduleInterval(60_000, handler, { lockKey: "test:long" });

    await vi.advanceTimersByTimeAsync(60_000 + 45 * 60_000 + 1_000);
    expect(events).toEqual(["handler-start", "handler-end", "lock-released-at-tx-end"]);
    // And the ticks that fired during the run did not start a second copy.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    rt.stop();
  });
});

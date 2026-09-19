/**
 * WARP-2218 — the connector sync job must single-fire across replicas.
 *
 * `cron-runtime.service.ts:154` `withAdvisoryLock` takes
 * `pg_try_advisory_xact_lock(hashtext($1))` inside a `$transaction` and SKIPS
 * the tick when another instance holds it. Without a `lockKey` a
 * multi-instance box double-polls every vendor and burns a shared rate budget
 * twice — and Xero's budget is pooled fleet-wide, so "twice" is not a local
 * cost.
 *
 * Two `CronRuntime` instances share ONE Prisma stub here, which is the
 * multi-replica shape: one lock table, two processes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createCronRuntime, type CronRuntimePrisma } from "../cron-runtime.service.js";

/**
 * A Prisma stub whose advisory lock behaves like Postgres': the first holder
 * inside a transaction wins, everyone else is told no.
 *
 * The lock is released when the transaction ends, exactly as
 * `pg_try_advisory_xact_lock` releases at commit/rollback.
 */
function lockingPrisma(): CronRuntimePrisma & { held: Set<string> } {
  const held = new Set<string>();
  const prisma = {
    held,
    async $queryRawUnsafe() {
      return [] as never;
    },
    async $transaction<T>(fn: (tx: { $queryRawUnsafe: (q: string, ...v: unknown[]) => Promise<unknown> }) => Promise<T>): Promise<T> {
      const taken: string[] = [];
      try {
        return await fn({
          async $queryRawUnsafe(_q: string, ...values: unknown[]) {
            const key = String(values[0]);
            if (held.has(key)) return [{ locked: false }];
            held.add(key);
            taken.push(key);
            return [{ locked: true }];
          },
        });
      } finally {
        for (const k of taken) held.delete(k);
      }
    },
  };
  return prisma as never;
}

const silent = { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("connector sync cron registration", () => {
  it("runs the handler ONCE when two replicas tick together", async () => {
    // MUTATION: drop `{ lockKey: "droplet:erp-connector-sync" }` from the
    // scheduleInterval opts → `safeRun` calls the handler directly with no
    // advisory lock → both replicas run and this expectation sees 2 → red.
    //
    // The handler holds a gate open so BOTH transactions are genuinely
    // in flight at once. That is the shape the lock defends against, and it is
    // load-bearing for the test: a handler that returns immediately lets
    // replica A commit before replica B even starts, at which point B acquires
    // the lock legitimately and runs — which is correct Postgres behaviour,
    // not a bug, and would make this test pass for the wrong reason.
    const prisma = lockingPrisma();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await gate;
    });

    const replicaA = createCronRuntime(prisma, silent);
    const replicaB = createCronRuntime(prisma, silent);
    const opts = { lockKey: "droplet:erp-connector-sync" };

    replicaA.scheduleInterval(1000, handler, opts);
    replicaB.scheduleInterval(1000, handler, opts);

    // Both intervals fire in this flush. A takes the lock and parks inside its
    // transaction; B finds the lock held and skips.
    await vi.advanceTimersByTimeAsync(1000);
    expect(handler).toHaveBeenCalledTimes(1);

    // Let A finish, and confirm B did not queue up behind it.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.held.size).toBe(0);

    replicaA.stop();
    replicaB.stop();
  });

  it("uses a DISTINCT lock key for the sweep so it cannot starve the tick", async () => {
    // Sharing one key would mean the hourly sweep leg and the frequent tick
    // block each other — the sweep is the long one, so the tick would be the
    // half that silently stops running.
    const prisma = lockingPrisma();
    const tick = vi.fn(async () => {});
    const sweep = vi.fn(async () => {});

    const runtime = createCronRuntime(prisma, silent);
    runtime.scheduleInterval(1000, tick, { lockKey: "droplet:erp-connector-sync" });
    runtime.scheduleInterval(1000, sweep, { lockKey: "droplet:erp-connector-reconciliation" });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenCalledTimes(1);
    });

    runtime.stop();
  });

  it("releases the lock so the NEXT tick is not permanently skipped", async () => {
    const prisma = lockingPrisma();
    const handler = vi.fn(async () => {});
    const runtime = createCronRuntime(prisma, silent);
    runtime.scheduleInterval(1000, handler, { lockKey: "droplet:erp-connector-sync" });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    expect(prisma.held.size).toBe(0);
    runtime.stop();
  });

  it("does not let a throwing handler leave the lock held", async () => {
    // A throw rolls the transaction back, which still releases the xact lock.
    const prisma = lockingPrisma();
    const handler = vi.fn(async () => {
      throw new Error("vendor exploded");
    });
    const runtime = createCronRuntime(prisma, silent);
    runtime.scheduleInterval(1000, handler, { lockKey: "droplet:erp-connector-sync" });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(prisma.held.size).toBe(0);
    // And the failure reached safeRun rather than being swallowed.
    await vi.waitFor(() => expect(silent.error).toHaveBeenCalled());
    runtime.stop();
  });
});

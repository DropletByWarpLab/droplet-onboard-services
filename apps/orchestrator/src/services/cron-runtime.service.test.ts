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
 * Minimal Prisma stub that mimics `$queryRawUnsafe` behavior for the two
 * advisory-lock statements the runtime issues. Pass `{ lockAcquired: true }`
 * (default) for the "we got the lock" path, or `false` for the "another
 * instance has it" path.
 */
function makePrismaStub(
  opts: { lockAcquired?: boolean; onUnlock?: () => void } = {},
): CronRuntimePrisma & { $queryRawUnsafe: ReturnType<typeof vi.fn> } {
  const acquired = opts.lockAcquired ?? true;
  const $queryRawUnsafe = vi.fn(async (sql: string, ..._args: unknown[]) => {
    if (sql.includes("pg_try_advisory_lock")) {
      return [{ locked: acquired }];
    }
    if (sql.includes("pg_advisory_unlock")) {
      opts.onUnlock?.();
      return [{ pg_advisory_unlock: true }];
    }
    return [];
  });
  return { $queryRawUnsafe } as any;
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

  it("runs handler when advisory lock is acquired", async () => {
    const prisma = makePrismaStub({ lockAcquired: true });
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-a" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);

    // Both the try-lock and the unlock queries should have been issued.
    const sqls = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("pg_try_advisory_lock"))).toBe(true);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);

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

    // Unlock should NOT be called if we never acquired.
    const sqls = prisma.$queryRawUnsafe.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("pg_advisory_unlock"))).toBe(false);

    rt.stop();
  });

  it("releases advisory lock after handler completes successfully", async () => {
    let unlocked = false;
    const prisma = makePrismaStub({
      lockAcquired: true,
      onUnlock: () => {
        unlocked = true;
      },
    });
    const rt = createCronRuntime(prisma);
    const handler = vi.fn(async () => {});
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-c" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unlocked).toBe(true);

    rt.stop();
  });

  it("releases advisory lock even when handler throws", async () => {
    let unlocked = false;
    const prisma = makePrismaStub({
      lockAcquired: true,
      onUnlock: () => {
        unlocked = true;
      },
    });
    const logger = makeLogger();
    const rt = createCronRuntime(prisma, logger);
    const handler = vi.fn().mockRejectedValue(new Error("handler blew up"));
    rt.scheduleInterval(1000, handler, { lockKey: "test:lock-d" });

    await vi.advanceTimersByTimeAsync(1500);
    expect(handler).toHaveBeenCalledTimes(1);
    // Even though handler threw, finally-block ran and released the lock.
    expect(unlocked).toBe(true);
    // And the error was logged.
    expect(logger.error).toHaveBeenCalled();

    rt.stop();
  });
});

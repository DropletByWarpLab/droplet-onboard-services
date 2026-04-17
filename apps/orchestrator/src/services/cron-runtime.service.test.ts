import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCronRuntime,
  type CronRuntimeLogger,
} from "./cron-runtime.service.js";
import { RouterError } from "../types/router-error.js";

function makeLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies CronRuntimeLogger;
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
    const rt = createCronRuntime(logger);
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
    const rt = createCronRuntime(logger);
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
    const rt = createCronRuntime(logger);

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
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCronRuntime } from "./cron-runtime.service.js";

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
});

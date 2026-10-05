/**
 * WARP-3193 QUAL-7 — importing a scheduler module starts nothing.
 *
 * These modules used to own their timers: two with a bare `setInterval` at
 * module scope (a timer started by an `import`, with no handle to stop it),
 * the rest from start functions that app.ts ran for every test that built an
 * app. They now register on cron-runtime from index.ts main(). This pins the
 * import half: loading any of them leaves no timer behind.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const MODULES = [
  "../services/reminders-poller.js",
  "../services/device-registration.service.js",
  "../services/health-monitor.service.js",
  "../services/screen-qr.service.js",
  "../services/network-safety.service.js",
  "../services/storage-safety.service.js",
  "../services/safety-tier.service.js",
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler modules start no timer on import (WARP-3193 QUAL-7)", () => {
  it.each(MODULES)("%s", async (mod) => {
    vi.resetModules();
    vi.useFakeTimers();
    await import(mod);
    expect(vi.getTimerCount()).toBe(0);
  });
});

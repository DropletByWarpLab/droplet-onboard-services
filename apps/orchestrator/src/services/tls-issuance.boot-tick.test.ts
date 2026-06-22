import { describe, it, expect, vi } from "vitest";

import { scheduleTlsBootTick } from "./tls-issuance.boot-tick.js";

// ---------------------------------------------------------------------------
// ADR-023 PR-1 (Gap 3) — boot/post-setup issuance tick.
//
// On boot (or right after setup) the box should attempt issuance ONCE,
// immediately, instead of waiting up to 24h for the 04:00 cron. The tick is:
//   - gated on HQ being configured (no-op on a dev/CI box),
//   - delayed (default ~30s) so the rest of boot settles first,
//   - unref()'d so it never holds the event loop open, and
//   - fail-soft: a rejected runOnce is caught + warned, NEVER unhandled (it must
//     not crash the process or churn the cron canary — it is NOT scheduled
//     through cron-runtime.safeRun).
// ---------------------------------------------------------------------------

function makeTimer() {
  const timer = { unref: vi.fn(() => timer) } as unknown as NodeJS.Timeout;
  return timer;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("scheduleTlsBootTick", () => {
  it("does nothing when HQ issuance is not configured", () => {
    const setTimeoutFn = vi.fn(() => makeTimer());
    const runOnce = vi.fn(async () => {});
    const handle = scheduleTlsBootTick({
      hqConfigured: false,
      runOnce,
      delayMs: 30_000,
      logger: makeLogger(),
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    });

    expect(handle).toBeNull();
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("schedules an unref'd delayed tick when HQ is configured", () => {
    const timer = makeTimer();
    let scheduled: (() => void) | null = null;
    const setTimeoutFn = vi.fn((cb: () => void, ms: number) => {
      scheduled = cb;
      expect(ms).toBe(30_000);
      return timer;
    });
    const runOnce = vi.fn(async () => {});

    const handle = scheduleTlsBootTick({
      hqConfigured: true,
      runOnce,
      delayMs: 30_000,
      logger: makeLogger(),
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    });

    expect(handle).toBe(timer);
    // unref() so the tick never keeps the process alive (matches the AC).
    expect(timer.unref).toHaveBeenCalledTimes(1);
    // The callback hasn't fired yet — it's deferred.
    expect(runOnce).not.toHaveBeenCalled();

    // Fire the deferred callback.
    scheduled!();
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("catches a rejected runOnce (no unhandled rejection, just a warn)", async () => {
    let scheduled: (() => void) | null = null;
    const setTimeoutFn = vi.fn((cb: () => void) => {
      scheduled = cb;
      return makeTimer();
    });
    const logger = makeLogger();
    const runOnce = vi.fn(async () => {
      throw new Error("HQ unreachable at boot");
    });

    scheduleTlsBootTick({
      hqConfigured: true,
      runOnce,
      delayMs: 30_000,
      logger,
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    });

    // Invoke the scheduled callback and let its (caught) rejection settle. If
    // the rejection were NOT caught this would surface as an unhandled
    // rejection; instead it resolves and the logger warns.
    scheduled!();
    await new Promise((r) => setTimeout(r, 0));

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import { registerProcessSafetyNet } from "../index.js";

// WARP-572: the orchestrator is an always-on control plane that fires many
// background promises outside the request lifecycle. On modern Node an
// unhandled rejection / uncaught exception terminates the process by default.
// `registerProcessSafetyNet` installs the two process-level handlers:
//   - unhandledRejection  -> log at error, DO NOT exit (degrade, don't kill)
//   - uncaughtException   -> log at fatal, then run the fatal/shutdown path
//
// We test the exported helper directly so no real process boot or real
// process.exit is needed. Listeners attached by each call are captured and
// removed in afterEach so the vitest runner itself is unaffected.

type Captured = {
  unhandledRejection: NodeJS.UnhandledRejectionListener[];
  uncaughtException: NodeJS.UncaughtExceptionListener[];
};

describe("registerProcessSafetyNet (WARP-572)", () => {
  let before: Captured;

  function makeLogger() {
    return {
      error: vi.fn(),
      fatal: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  }

  function newListeners<E extends keyof Captured>(event: E): Captured[E] {
    const current = process.listeners(
      event as "unhandledRejection",
    ) as Captured[E];
    const baseline = before[event] as unknown[];
    return current.filter((l) => !baseline.includes(l)) as Captured[E];
  }

  beforeEach(() => {
    before = {
      unhandledRejection: process.listeners(
        "unhandledRejection",
      ) as NodeJS.UnhandledRejectionListener[],
      uncaughtException: process.listeners(
        "uncaughtException",
      ) as NodeJS.UncaughtExceptionListener[],
    };
  });

  afterEach(() => {
    // Remove only the listeners our call added, leaving the runner's own.
    for (const l of newListeners("unhandledRejection")) {
      process.off("unhandledRejection", l);
    }
    for (const l of newListeners("uncaughtException")) {
      process.off("uncaughtException", l);
    }
  });

  it("logs an unhandledRejection at error with code and does NOT call onFatal", () => {
    const logger = makeLogger();
    const onFatal = vi.fn();

    registerProcessSafetyNet(logger, onFatal);

    const listeners = newListeners("unhandledRejection");
    expect(listeners).toHaveLength(1);

    const reason = new Error("stray background rejection");
    listeners[0](reason, Promise.resolve());

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [obj] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(obj).toMatchObject({ code: "unhandledRejection" });
    expect(obj.err).toBe(reason);

    // surviving, not fatal
    expect(onFatal).not.toHaveBeenCalled();
    expect(logger.fatal).not.toHaveBeenCalled();
  });

  it("logs an uncaughtException at fatal with code and calls onFatal exactly once", () => {
    const logger = makeLogger();
    const onFatal = vi.fn();

    registerProcessSafetyNet(logger, onFatal);

    const listeners = newListeners("uncaughtException");
    expect(listeners).toHaveLength(1);

    const err = new Error("boom in a background timer");
    listeners[0](err, "uncaughtException");

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    const [obj] = (logger.fatal as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(obj).toMatchObject({ code: "uncaughtException" });
    expect(obj.err).toBe(err);

    expect(onFatal).toHaveBeenCalledTimes(1);
    // fatal path must not also log the survivable error line
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("attaches exactly one listener per event", () => {
    const logger = makeLogger();
    const onFatal = vi.fn();

    registerProcessSafetyNet(logger, onFatal);

    expect(newListeners("unhandledRejection")).toHaveLength(1);
    expect(newListeners("uncaughtException")).toHaveLength(1);
  });
});

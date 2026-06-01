import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Logger } from "pino";
import {
  registerProcessSafetyNet,
  createShutdownRunner,
  __resetProcessSafetyNetForTests,
  __resetShutdownGuardForTests,
} from "../index.js";

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
    // WARP-572: clear the module-scope idempotency/re-entrancy latches so each
    // test exercises a clean wiring.
    __resetProcessSafetyNetForTests();
    __resetShutdownGuardForTests();
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

  it("is idempotent: a second registration adds no extra listeners", () => {
    const logger = makeLogger();
    const onFatal = vi.fn();

    registerProcessSafetyNet(logger, onFatal);
    registerProcessSafetyNet(logger, onFatal);

    // still exactly one listener per event despite two calls
    expect(newListeners("unhandledRejection")).toHaveLength(1);
    expect(newListeners("uncaughtException")).toHaveLength(1);
    // the duplicate call warns rather than silently re-wiring
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "safetyNetAlreadyRegistered" }),
      expect.any(String),
    );
  });
});

describe("createShutdownRunner (WARP-572)", () => {
  let exitSpy: ReturnType<typeof vi.fn>;

  function makeLogger() {
    return {
      error: vi.fn(),
      fatal: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  }

  beforeEach(() => {
    __resetShutdownGuardForTests();
    vi.useFakeTimers();
    // Stub process.exit so the runner doesn't tear down the vitest worker.
    exitSpy = vi.fn();
    vi.spyOn(process, "exit").mockImplementation(
      exitSpy as unknown as typeof process.exit,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs teardown then exits with the requested code (fatal path → 1)", async () => {
    const logger = makeLogger();
    const teardown = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownRunner(logger, teardown);

    await shutdown(1);

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults to exit code 0 (SIGTERM/SIGINT semantics preserved)", async () => {
    const logger = makeLogger();
    const shutdown = createShutdownRunner(logger, vi.fn().mockResolvedValue(undefined));

    await shutdown();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("is re-entrancy guarded: a second call short-circuits before teardown", async () => {
    const logger = makeLogger();
    const teardown = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownRunner(logger, teardown);

    await shutdown(1);
    await shutdown(1); // simulates a second uncaughtException mid/post teardown

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown already in progress"),
    );
  });

  it("force-exits if teardown hangs past the failsafe timeout", async () => {
    const logger = makeLogger();
    // teardown never resolves → the armed force-exit timer must fire.
    const hang = new Promise<void>(() => {});
    const shutdown = createShutdownRunner(logger, () => hang);

    // Kick off shutdown but don't await (teardown never settles).
    void shutdown(1);
    // Let the synchronous setup (timer arm, log, teardown start) run.
    await Promise.resolve();

    expect(exitSpy).not.toHaveBeenCalled();

    // Advance past the 10s default failsafe window.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ code: "shutdownForceExit" }),
      expect.any(String),
    );
  });
});

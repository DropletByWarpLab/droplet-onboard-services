/**
 * WARP-615 — analytics façade: Noop selection + fail-open contract (D5).
 *
 * Two AC pins live here:
 *   1. `NoopAnalytics` is selected when ANALYTICS_ENABLED=false OR the agent
 *      is unconfigured (no URL, or neither ingest token nor provisioning
 *      code), with EXACTLY ONE info log — the box must behave exactly as if
 *      the analytics module didn't exist.
 *   2. Fail-open: a throwing or timing-out underlying agent/client can NEVER
 *      throw (or leak an unhandled rejection) into the business path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAnalytics,
  getAnalytics,
  initAnalytics,
  NoopAnalytics,
  wrapFailOpen,
  _resetAnalyticsForTests,
  analytics,
} from "./index.js";
import type { Analytics } from "./types.js";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

const CONFIGURED = {
  enabled: true,
  url: "http://portal.test/api/v1",
  ingestToken: "dpl_mach-1_s3cret",
  provisioningCode: "",
  fallbackDropletId: "droplet",
  firmwareVersion: "0.1.0",
};

function callAllFacadeMethods(a: Analytics): void {
  a.event({ type: "user.login" });
  a.metric("service.health", 0.5, { service: "routing" });
  a.error({ fingerprint: "f", service: "s", title: "t", message: "m" });
  a.recordLlm({ model: "m", provider: "ollama", latencyMs: 5, ok: false });
  a.recordService({ service: "routing", status: "degraded" });
}

describe("createAnalytics — Noop selection (WARP-615 AC 1)", () => {
  it("returns NoopAnalytics with exactly one info log when ANALYTICS_ENABLED=false", () => {
    const log = fakeLog();
    const a = createAnalytics({ ...CONFIGURED, enabled: false }, log);
    expect(a).toBeInstanceOf(NoopAnalytics);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("returns NoopAnalytics with exactly one info log when the URL is missing", () => {
    const log = fakeLog();
    const a = createAnalytics({ ...CONFIGURED, url: "  " }, log);
    expect(a).toBeInstanceOf(NoopAnalytics);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("returns NoopAnalytics with exactly one info log when neither ingest token nor provisioning code is set", () => {
    const log = fakeLog();
    const a = createAnalytics(
      { ...CONFIGURED, ingestToken: "", provisioningCode: "" },
      log,
    );
    expect(a).toBeInstanceOf(NoopAnalytics);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("builds an active (non-Noop) agent when enabled with an ingest token", () => {
    const a = createAnalytics(CONFIGURED, fakeLog());
    expect(a).not.toBeInstanceOf(NoopAnalytics);
  });

  it("builds an active agent when enabled with only a provisioning code (WARP-616 registers it)", () => {
    const a = createAnalytics(
      { ...CONFIGURED, ingestToken: "", provisioningCode: "prov-123" },
      fakeLog(),
    );
    expect(a).not.toBeInstanceOf(NoopAnalytics);
  });

  it("NoopAnalytics façade calls are safe no-ops", () => {
    expect(() => callAllFacadeMethods(new NoopAnalytics())).not.toThrow();
  });

  it("falls back to NoopAnalytics with a warn when construction itself throws (structural fail-open)", () => {
    // PR #802 review: the "never throws into business logic" contract must
    // hold STRUCTURALLY against future editors of the construction path
    // (WARP-616 edits exactly this), not by inspection of today's
    // non-throwing code. Sabotage the init so construction throws mid-build.
    const log = fakeLog();
    const sabotaged = {
      ...CONFIGURED,
      get url(): string {
        throw new Error("sabotaged init");
      },
    } as unknown as Parameters<typeof createAnalytics>[0];

    let a: Analytics | undefined;
    expect(() => {
      a = createAnalytics(sabotaged, log);
    }).not.toThrow();
    expect(a).toBeInstanceOf(NoopAnalytics);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("wrapFailOpen — analytics can NEVER throw into business logic (WARP-615 AC 2)", () => {
  function throwingAnalytics(): Analytics {
    const boom = () => {
      throw new Error("analytics exploded");
    };
    return {
      event: boom,
      metric: boom,
      error: boom,
      recordLlm: boom,
      recordService: boom,
    };
  }

  it("swallows synchronous throws from every façade method", () => {
    const wrapped = wrapFailOpen(throwingAnalytics(), fakeLog());
    expect(() => callAllFacadeMethods(wrapped)).not.toThrow();
  });

  it("logs the first failure at warn and subsequent ones at debug (no log spam from a flapping portal)", () => {
    const log = fakeLog();
    const wrapped = wrapFailOpen(throwingAnalytics(), log);
    callAllFacadeMethods(wrapped);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(4);
  });

  it("catches async rejections from a promise-returning underlying implementation (no unhandled rejection)", async () => {
    const log = fakeLog();
    const rejecting = {
      event: () => Promise.reject(new Error("async boom")),
      metric: () => Promise.reject(new Error("async boom")),
      error: () => Promise.reject(new Error("async boom")),
      recordLlm: () => Promise.reject(new Error("async boom")),
      recordService: () => Promise.reject(new Error("async boom")),
    } as unknown as Analytics;
    const wrapped = wrapFailOpen(rejecting, log);

    expect(() => callAllFacadeMethods(wrapped)).not.toThrow();
    // Let the rejection handlers run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn.mock.calls.length + log.debug.mock.calls.length).toBe(5);
  });

  it("catches rejections from a cross-realm-style thenable (not a real Promise instance)", async () => {
    // PR #802 review: `instanceof Promise` misses thenables from another
    // realm (or promise libraries). The guard must duck-type `.then`.
    const log = fakeLog();
    const rejectingThenable = {
      then(_onFulfilled: unknown, onRejected: (err: unknown) => void) {
        onRejected(new Error("thenable boom"));
      },
    };
    const thenableReturning = {
      event: () => rejectingThenable,
      metric: () => rejectingThenable,
      error: () => rejectingThenable,
      recordLlm: () => rejectingThenable,
      recordService: () => rejectingThenable,
    } as unknown as Analytics;
    const wrapped = wrapFailOpen(thenableReturning, log);

    expect(() => callAllFacadeMethods(wrapped)).not.toThrow();
    // Let the assimilated thenable's rejection handlers run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(log.warn.mock.calls.length + log.debug.mock.calls.length).toBe(5);
  });

  it("a timing-out client behind the real agent leaves the business path untouched", () => {
    // The full stack as createAnalytics builds it, with fetch timing out.
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation timed out", "TimeoutError"),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const a = createAnalytics(CONFIGURED, fakeLog());
      expect(() => callAllFacadeMethods(a)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("singleton boot wiring", () => {
  beforeEach(() => _resetAnalyticsForTests());
  afterEach(() => _resetAnalyticsForTests());

  it("getAnalytics memoizes a single instance and initAnalytics is idempotent", () => {
    initAnalytics();
    const first = getAnalytics();
    initAnalytics();
    expect(getAnalytics()).toBe(first);
  });

  it("defaults to Noop under the test env (ANALYTICS_ENABLED unset) and the exported façade never throws", () => {
    // The exported `analytics` proxy is what call sites import; under the
    // default (disabled) config it must be a safe no-op.
    expect(getAnalytics()).toBeInstanceOf(NoopAnalytics);
    expect(() => {
      analytics.event({ type: "system.test" });
      analytics.metric("service.health", 1);
      analytics.error({
        fingerprint: "f",
        service: "s",
        title: "t",
        message: "m",
      });
      analytics.recordLlm({
        model: "m",
        provider: "ollama",
        latencyMs: 1,
        ok: true,
      });
      analytics.recordService({ service: "redis", status: "ok" });
    }).not.toThrow();
  });
});

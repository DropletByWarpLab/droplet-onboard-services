/**
 * WARP-2370 — the concurrency ceiling and the two rate-limit headers.
 *
 * NOTHING HERE SLEEPS AND NOTHING DIALS. The clock and `sleep` are injected;
 * every "call" is a resolvable promise the test controls.
 *
 * The headline test is the 40-concurrent-call one: upstream #171 reports 429s
 * at ~20 parallel calls, so the assertion that matters is on the DEPTH the
 * injected executor ever observes, not on how long the batch took.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_CALLS,
  MAX_HONOURED_PAUSE_MS,
  RemoteCallScheduler,
} from "../src/call-scheduler.js";

/** An executor that records how deep concurrency ever got. */
function depthProbe() {
  let inFlight = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  return {
    peak: () => peak,
    /** A call that stays in flight until `releaseAll()`. */
    call: async () => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return "ok";
    },
    releaseAll: () => {
      while (releases.length > 0) releases.shift()!();
    },
    pending: () => releases.length,
  };
}

describe("the concurrency ceiling", () => {
  it("ships at 4 — a quarter of upstream #171's observed ~20-call cliff", () => {
    expect(DEFAULT_MAX_CONCURRENT_CALLS).toBe(4);
    expect(new RemoteCallScheduler().maxConcurrent).toBe(4);
  });

  it("holds 40 concurrent calls to the ceiling, and completes every one", async () => {
    const scheduler = new RemoteCallScheduler({ maxConcurrent: 4 });
    const probe = depthProbe();

    let settled = false;
    const all = Promise.all(
      Array.from({ length: 40 }, () => scheduler.run(probe.call)),
    ).then((r) => {
      settled = true;
      return r;
    });

    // Drain in waves: each release lets the next waiter in, and the probe
    // records the depth it sees. If the gate were removed all 40 would be in
    // flight at once and `peak` would be 40 on the very first wave.
    for (let wave = 0; wave < 200 && !settled; wave++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      probe.releaseAll();
    }

    const results = await all;
    expect(results).toHaveLength(40);
    expect(results.every((r) => r === "ok")).toBe(true);
    expect(probe.peak()).toBeLessThanOrEqual(4);
    expect(scheduler.stats().peakInFlight).toBeLessThanOrEqual(4);
    // …and the gate was actually exercised, rather than the batch happening to
    // serialise: a ceiling test that never reached the ceiling proves nothing.
    expect(probe.peak()).toBe(4);
  });

  it("releases the slot when a call THROWS, so capacity cannot leak", async () => {
    const scheduler = new RemoteCallScheduler({ maxConcurrent: 1 });
    await expect(
      scheduler.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A leaked slot would deadlock this second call forever.
    await expect(scheduler.run(async () => "after")).resolves.toBe("after");
    expect(scheduler.stats().inFlight).toBe(0);
  });

  it("refuses a ceiling below 1 rather than silently deadlocking", () => {
    expect(() => new RemoteCallScheduler({ maxConcurrent: 0 })).toThrow(/at least 1/);
  });
});

describe("Retry-After", () => {
  it("pauses for delta-seconds before the next call runs", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 1_000 });
    scheduler.noteRateLimitHeaders({ "Retry-After": "3" });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(3_000);
    expect(scheduler.stats().pauses).toBe(1);
  });

  it("accepts the HTTP-date form too", async () => {
    const sleep = vi.fn(async () => {});
    const now = Date.parse("2026-09-02T00:00:00Z");
    const scheduler = new RemoteCallScheduler({ sleep, now: () => now });
    scheduler.noteRateLimitHeaders({ "retry-after": "Wed, 02 Sep 2026 00:00:10 GMT" });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it("caps an absurd pause rather than obeying it", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    scheduler.noteRateLimitHeaders({ "Retry-After": "86400" });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(MAX_HONOURED_PAUSE_MS);
  });

  it("does not sleep when no header asked it to", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    await scheduler.run(async () => "x");
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("X-RateLimit-*", () => {
  it("pauses until the reset when remaining is exactly 0", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    scheduler.noteRateLimitHeaders({
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "12",
    });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(12_000);
  });

  it("reads an epoch-seconds reset as an absolute time, not a delta", async () => {
    const sleep = vi.fn(async () => {});
    const nowMs = 1_800_000_000_000;
    const scheduler = new RemoteCallScheduler({ sleep, now: () => nowMs });
    scheduler.noteRateLimitHeaders({
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(nowMs / 1000 + 5),
    });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(5_000);
  });

  it("ignores a POSITIVE remaining — a healthy connection is not halted", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    scheduler.noteRateLimitHeaders({
      "X-RateLimit-Remaining": "199",
      "X-RateLimit-Reset": "60",
    });
    await scheduler.run(async () => "x");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("lets Retry-After win over the X-RateLimit pair", async () => {
    const sleep = vi.fn(async () => {});
    const scheduler = new RemoteCallScheduler({ sleep, now: () => 0 });
    scheduler.noteRateLimitHeaders({
      "Retry-After": "2",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "30",
    });
    await scheduler.run(async () => "x");
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
  });

  it("retains no header value — only counters leave through stats()", () => {
    const scheduler = new RemoteCallScheduler({ now: () => 0 });
    scheduler.noteRateLimitHeaders({
      // Rule 19: an Authorization echo in the same map must not be stored.
      Authorization: "Basic ATATT-FAKE-000000000000",
      "Retry-After": "1",
    });
    const stats = scheduler.stats();
    expect(JSON.stringify(stats)).not.toContain("ATATT");
    expect(Object.keys(stats).sort()).toEqual([
      "inFlight",
      "pauses",
      "peakInFlight",
      "queued",
    ]);
  });
});

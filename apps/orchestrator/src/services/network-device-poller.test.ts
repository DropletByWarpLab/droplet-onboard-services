/**
 * WARP-3193 PERF-15 — one shared device poller for the SSE stream.
 *
 * GET /network/devices/events used to start its own 10 s setInterval per
 * connected client, each calling the routing service, with no in-flight
 * guard — N dashboards meant N polls per tick, and a slow router let them
 * pile up. The poller is now shared per process: one fetch per tick fanned
 * out to every subscriber, skipped while the previous one is still in
 * flight, and stopped when nobody is listening.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDevicePoller } from "./network-device-poller.js";

const TICK = 10_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDevicePoller", () => {
  it("makes one fetch per tick however many subscribers there are", async () => {
    const fetch = vi.fn().mockResolvedValue([{ mac: "aa" }]);
    const poller = createDevicePoller(fetch, TICK);
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    poller.subscribe(a);
    poller.subscribe(b);
    poller.subscribe(c);

    await vi.advanceTimersByTimeAsync(TICK);

    expect(fetch).toHaveBeenCalledTimes(1);
    for (const s of [a, b, c]) expect(s).toHaveBeenCalledWith([{ mac: "aa" }]);
  });

  it("only tells a subscriber when ITS view changed", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce([{ mac: "aa" }])
      .mockResolvedValueOnce([{ mac: "aa" }])
      .mockResolvedValueOnce([{ mac: "bb" }]);
    const poller = createDevicePoller(fetch, TICK);
    const early = vi.fn();
    poller.subscribe(early);

    await vi.advanceTimersByTimeAsync(TICK);
    const late = vi.fn();
    poller.subscribe(late);
    await vi.advanceTimersByTimeAsync(TICK);

    // Unchanged for `early`; first sight for `late`, as with a per-client poll.
    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(early).toHaveBeenLastCalledWith([{ mac: "bb" }]);
    expect(late).toHaveBeenLastCalledWith([{ mac: "bb" }]);
  });

  it("skips a tick while the previous fetch is still in flight", async () => {
    let release!: (v: unknown) => void;
    const fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const poller = createDevicePoller(fetch, TICK);
    poller.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(fetch).toHaveBeenCalledTimes(1);

    release([]);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops polling when the last subscriber leaves, and restarts on the next", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const poller = createDevicePoller(fetch, TICK);
    const unsubA = poller.subscribe(vi.fn());
    const unsubB = poller.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(TICK);
    expect(fetch).toHaveBeenCalledTimes(1);

    unsubA();
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fetch).toHaveBeenCalledTimes(2);

    unsubB();
    await vi.advanceTimersByTimeAsync(TICK * 5);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    poller.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(TICK);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("a failed fetch is non-fatal and clears the in-flight guard", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("router down"))
      .mockResolvedValueOnce([{ mac: "aa" }]);
    const poller = createDevicePoller(fetch, TICK);
    const s = vi.fn();
    poller.subscribe(s);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(s).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TICK);
    expect(s).toHaveBeenCalledWith([{ mac: "aa" }]);
  });

  it("a throwing subscriber does not starve the others", async () => {
    const fetch = vi.fn().mockResolvedValue([{ mac: "aa" }]);
    const poller = createDevicePoller(fetch, TICK);
    poller.subscribe(() => {
      throw new Error("socket gone");
    });
    const ok = vi.fn();
    poller.subscribe(ok);

    await vi.advanceTimersByTimeAsync(TICK);
    expect(ok).toHaveBeenCalledOnce();
  });
});

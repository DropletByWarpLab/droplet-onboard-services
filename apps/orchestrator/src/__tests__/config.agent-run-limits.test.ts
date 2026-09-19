/**
 * WARP-2177 — `resolveAgentRunLimits`: the reclaim threshold is never below
 * two heartbeats. Below that a single missed beat (a GC pause) reclaims a
 * healthy run and re-executes its current iteration.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveAgentRunLimits } from "../config.js";

const base = {
  concurrency: 1,
  tickMs: 5_000,
  heartbeatMs: 15_000,
  reclaimAfterMs: 60_000,
  maxAttempts: 3,
  maxWallMs: 2_400_000,
};

describe("resolveAgentRunLimits (WARP-2177)", () => {
  it("passes a sane configuration through untouched", () => {
    const warn = vi.fn();
    expect(resolveAgentRunLimits(base, warn)).toEqual(base);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clamps a reclaim threshold below 2× heartbeat up to the floor, loudly", () => {
    const warn = vi.fn();
    const out = resolveAgentRunLimits({ ...base, reclaimAfterMs: 20_000 }, warn);
    expect(out.reclaimAfterMs).toBe(30_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/AGENT_RUN_RECLAIM_AFTER_MS \(20000\)/);
  });
});

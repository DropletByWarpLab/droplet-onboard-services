/**
 * WARP-618 — health-monitor → fleet-analytics bridge.
 *
 * The bridge must be a pure fan-out: exactly one recordService observation
 * per component in the snapshot, with NO hardcoded component list — services
 * added to the health monitor later (WARP-598 file-indexer, WARP-1146
 * storage, whatever comes next) must flow through untouched. All derivation
 * (metric values, transition events) is AnalyticsAgent territory and is
 * pinned in agent.test.ts, not here.
 */
import { describe, it, expect, vi } from "vitest";
import { forwardHealthSnapshot } from "./service-health.js";
import type { Analytics } from "./types.js";
import type { ComponentHealth } from "../health-monitor.service.js";

function fakeSink(): Analytics {
  return {
    event: vi.fn(),
    metric: vi.fn(),
    error: vi.fn(),
    recordLlm: vi.fn(),
    recordService: vi.fn(),
  };
}

function mkComponent(
  name: string,
  status: "ok" | "down",
  extra?: Partial<ComponentHealth>,
): ComponentHealth {
  return {
    name: name as ComponentHealth["name"],
    status,
    latencyMs: 5,
    lastCheckedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("forwardHealthSnapshot (WARP-618)", () => {
  it("forwards exactly one recordService observation per component, mapping name/status/latency/error", () => {
    const sink = fakeSink();
    forwardHealthSnapshot(
      [
        mkComponent("postgres", "ok", { latencyMs: 3 }),
        mkComponent("redis", "down", {
          latencyMs: 5001,
          error: "probe timed out",
        }),
      ],
      sink,
    );

    expect(sink.recordService).toHaveBeenCalledTimes(2);
    expect(sink.recordService).toHaveBeenNthCalledWith(1, {
      service: "postgres",
      status: "ok",
      latencyMs: 3,
      error: undefined,
    });
    expect(sink.recordService).toHaveBeenNthCalledWith(2, {
      service: "redis",
      status: "down",
      latencyMs: 5001,
      error: "probe timed out",
    });
  });

  it("carries components it has never heard of — no hardcoded component list (WARP-598 adds more)", () => {
    const sink = fakeSink();
    forwardHealthSnapshot(
      [mkComponent("some-future-component", "ok")],
      sink,
    );

    expect(sink.recordService).toHaveBeenCalledTimes(1);
    expect(sink.recordService).toHaveBeenCalledWith(
      expect.objectContaining({ service: "some-future-component" }),
    );
  });

  it("does nothing for an empty snapshot", () => {
    const sink = fakeSink();
    forwardHealthSnapshot([], sink);
    expect(sink.recordService).not.toHaveBeenCalled();
    expect(sink.event).not.toHaveBeenCalled();
    expect(sink.metric).not.toHaveBeenCalled();
  });
});

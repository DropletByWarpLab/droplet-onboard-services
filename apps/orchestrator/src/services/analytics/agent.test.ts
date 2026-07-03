/**
 * WARP-615 — analytics agent orchestration shell.
 *
 * This story lands the shell only: the agent implements the Analytics façade
 * but delivers NOTHING yet — buffering/flush is WARP-617, registration is
 * WARP-616, and both attach inside start(). Pin the inertness so those
 * stories inherit a shell that provably performs no I/O and schedules no
 * timers on its own (no `while true`, nothing outside cron-runtime — which
 * this skeleton doesn't use at all).
 */
import { describe, it, expect, vi } from "vitest";
import { AnalyticsAgent } from "./agent.js";
import type { AnalyticsClient } from "./client.js";

function stubClient(): AnalyticsClient {
  return {
    postHeartbeat: vi.fn(),
    postMetrics: vi.fn(),
    postEvents: vi.fn(),
    postError: vi.fn(),
  } as unknown as AnalyticsClient;
}

function callAllFacadeMethods(agent: AnalyticsAgent): void {
  agent.event({ type: "service.down", severity: "error" });
  agent.metric("service.health", 1, { service: "redis" });
  agent.error({
    fingerprint: "f",
    service: "s",
    title: "t",
    message: "m",
  });
  agent.recordLlm({ model: "m", provider: "ollama", latencyMs: 10, ok: true });
  agent.recordService({ service: "redis", status: "ok" });
}

describe("AnalyticsAgent — skeleton shell (WARP-615)", () => {
  it("performs no client I/O when constructed or when façade methods are called (delivery lands in WARP-617)", () => {
    const client = stubClient();
    const agent = new AnalyticsAgent({ client });

    callAllFacadeMethods(agent);

    expect(client.postHeartbeat).not.toHaveBeenCalled();
    expect(client.postMetrics).not.toHaveBeenCalled();
    expect(client.postEvents).not.toHaveBeenCalled();
    expect(client.postError).not.toHaveBeenCalled();
  });

  it("start()/stop() are idempotent and schedule no timers", () => {
    vi.useFakeTimers();
    try {
      const client = stubClient();
      const agent = new AnalyticsAgent({ client });

      agent.start();
      agent.start();
      vi.advanceTimersByTime(10 * 60_000);
      agent.stop();
      agent.stop();

      expect(vi.getTimerCount()).toBe(0);
      expect(client.postHeartbeat).not.toHaveBeenCalled();
      expect(client.postMetrics).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

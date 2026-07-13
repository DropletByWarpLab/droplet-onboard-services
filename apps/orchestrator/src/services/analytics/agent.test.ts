/**
 * WARP-615 — analytics agent orchestration shell.
 * WARP-618 — service-health derivation inside recordService.
 *
 * WARP-615 landed the shell only: the agent implements the Analytics façade
 * but delivers NOTHING yet — buffering/flush is WARP-617, registration is
 * WARP-616, and both attach inside start(). Pin the inertness so those
 * stories inherit a shell that provably performs no I/O and schedules no
 * timers on its own (no `while true`, nothing outside cron-runtime — which
 * this skeleton doesn't use at all).
 *
 * WARP-618 adds the one piece of in-agent logic: recordService derives the
 * per-poll `service.health` metric and transition-only `service.*` events
 * onto the agent's own metric()/event() seams — still zero I/O until
 * WARP-617 gives those seams a buffer.
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

describe("AnalyticsAgent.recordService — service-health derivation (WARP-618)", () => {
  /** Fresh agent with its metric/event seams spied (spies call through to
   * the inert originals, so derivation is observed without any delivery). */
  function harness() {
    const client = stubClient();
    const agent = new AnalyticsAgent({ client });
    const metric = vi.spyOn(agent, "metric");
    const event = vi.spyOn(agent, "event");
    return { agent, client, metric, event };
  }

  it("emits exactly one service.health metric per observation — 1 ok / 0.5 degraded / 0 down, labelled { service }", () => {
    const { agent, metric } = harness();

    agent.recordService({ service: "redis", status: "ok", latencyMs: 4 });
    agent.recordService({ service: "routing", status: "degraded", latencyMs: 9 });
    agent.recordService({
      service: "postgres",
      status: "down",
      latencyMs: 5001,
      error: "probe timed out",
    });

    expect(metric).toHaveBeenCalledTimes(3);
    expect(metric).toHaveBeenNthCalledWith(1, "service.health", 1, {
      service: "redis",
    });
    expect(metric).toHaveBeenNthCalledWith(2, "service.health", 0.5, {
      service: "routing",
    });
    expect(metric).toHaveBeenNthCalledWith(3, "service.health", 0, {
      service: "postgres",
    });
  });

  it("first-ever observation is a BASELINE — no event, even when the service is already down at boot", () => {
    // "Transition only" read literally: with no prior state nothing has
    // changed, so the event stream stays silent. The metric stream (value 0
    // on every poll) is what reports a service that boots down.
    const { agent, event, metric } = harness();

    agent.recordService({
      service: "redis",
      status: "down",
      latencyMs: 3,
      error: "probe returned false",
    });

    expect(event).not.toHaveBeenCalled();
    expect(metric).toHaveBeenCalledWith("service.health", 0, {
      service: "redis",
    });
  });

  it("steady state across many polls emits zero events", () => {
    const { agent, event, metric } = harness();

    for (let poll = 0; poll < 5; poll++) {
      agent.recordService({ service: "redis", status: "ok", latencyMs: 2 });
      agent.recordService({ service: "postgres", status: "ok", latencyMs: 3 });
    }

    expect(event).not.toHaveBeenCalled();
    expect(metric).toHaveBeenCalledTimes(10); // metric still fires every poll
  });

  it("a status flip emits exactly one event (type/severity/target/payload), and the flip back exactly one more", () => {
    const { agent, event } = harness();

    agent.recordService({ service: "redis", status: "ok", latencyMs: 2 }); // baseline
    agent.recordService({
      service: "redis",
      status: "down",
      latencyMs: 5000,
      error: "probe timed out",
    }); // flip → 1 event
    agent.recordService({
      service: "redis",
      status: "down",
      latencyMs: 5000,
      error: "probe timed out",
    }); // still down → silent
    agent.recordService({ service: "redis", status: "ok", latencyMs: 2 }); // recovery → 1 event

    expect(event).toHaveBeenCalledTimes(2);
    expect(event).toHaveBeenNthCalledWith(1, {
      type: "service.down",
      severity: "error",
      target: "redis",
      payload: { latencyMs: 5000, error: "probe timed out" },
    });
    // Recovery payload has no error — the key must be ABSENT, not undefined.
    expect(event).toHaveBeenNthCalledWith(2, {
      type: "service.up",
      severity: "info",
      target: "redis",
      payload: { latencyMs: 2 },
    });
  });

  it("a transition into degraded maps to service.degraded at warn severity", () => {
    const { agent, event } = harness();

    agent.recordService({ service: "storage", status: "ok", latencyMs: 1 });
    agent.recordService({
      service: "storage",
      status: "degraded",
      latencyMs: 2,
      error: "pool md127 is degraded",
    });

    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith({
      type: "service.degraded",
      severity: "warn",
      target: "storage",
      payload: { latencyMs: 2, error: "pool md127 is degraded" },
    });
  });

  it("tracks transitions per service — one service flipping never emits for its neighbours", () => {
    const { agent, event } = harness();

    agent.recordService({ service: "redis", status: "ok" });
    agent.recordService({ service: "nextcloud", status: "ok" });
    agent.recordService({ service: "redis", status: "down" });
    agent.recordService({ service: "nextcloud", status: "ok" });

    expect(event).toHaveBeenCalledTimes(1);
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "service.down", target: "redis" }),
    );
  });

  it("derivation still performs no client I/O — it lands on the inert metric()/event() seams (delivery is WARP-617)", () => {
    const { agent, client } = harness();

    agent.recordService({ service: "redis", status: "ok" });
    agent.recordService({ service: "redis", status: "down" });

    expect(client.postMetrics).not.toHaveBeenCalled();
    expect(client.postEvents).not.toHaveBeenCalled();
    expect(client.postError).not.toHaveBeenCalled();
  });

  it("stop() drops transition baselines — a restarted agent re-baselines instead of fabricating a transition", () => {
    const { agent, event } = harness();

    agent.recordService({ service: "redis", status: "ok" });
    agent.stop();
    agent.start();
    agent.recordService({ service: "redis", status: "down" });

    expect(event).not.toHaveBeenCalled();
  });
});

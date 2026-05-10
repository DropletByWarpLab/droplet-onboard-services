/**
 * WARP-225 — context-stats cache invalidation listener test.
 *
 * The listener subscribes to `droplet/context-stats/invalidate` and
 * SCAN+UNLINK's `context-stats:<userId>:*` on every well-formed
 * message. Tests assert:
 *   - Valid `{ userId }` payloads trigger one invalidatePrefix call
 *     with the per-user prefix.
 *   - Malformed payloads (missing userId, wrong type, empty string)
 *     are dropped silently — no invalidation, no throw.
 *   - The invalidator returns an unsubscribe handle for graceful
 *     shutdown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const subscribeSpy = vi.fn();
const handlers: Array<(topic: string, payload: unknown) => void> = [];

vi.mock("./mqtt.service.js", () => ({
  subscribeToTopic: (
    topic: string,
    handler: (topic: string, payload: unknown) => void,
  ) => {
    subscribeSpy(topic);
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
}));

const invalidatePrefixMock = vi.fn().mockResolvedValue(0);
vi.mock("./cache.service.js", () => ({
  invalidatePrefix: (...args: unknown[]) => invalidatePrefixMock(...args),
}));

import {
  startContextStatsInvalidator,
  TOPIC,
} from "./context-stats-invalidation.service.js";

beforeEach(() => {
  subscribeSpy.mockReset();
  invalidatePrefixMock.mockReset();
  invalidatePrefixMock.mockResolvedValue(0);
  handlers.length = 0;
});

describe("startContextStatsInvalidator", () => {
  it("subscribes to the spec'd topic", () => {
    startContextStatsInvalidator();
    expect(subscribeSpy).toHaveBeenCalledWith(
      "droplet/context-stats/invalidate",
    );
    expect(TOPIC).toBe("droplet/context-stats/invalidate");
  });

  it("DELs context-stats:<userId>:* on a valid payload", async () => {
    startContextStatsInvalidator();
    invalidatePrefixMock.mockResolvedValue(4);
    await handlers[0]?.(TOPIC, { userId: "alice" });
    expect(invalidatePrefixMock).toHaveBeenCalledTimes(1);
    expect(invalidatePrefixMock).toHaveBeenCalledWith("context-stats:alice:");
  });

  it("isolates per-user prefixes on consecutive payloads", async () => {
    startContextStatsInvalidator();
    await handlers[0]?.(TOPIC, { userId: "alice" });
    await handlers[0]?.(TOPIC, { userId: "bob" });
    expect(invalidatePrefixMock).toHaveBeenNthCalledWith(
      1,
      "context-stats:alice:",
    );
    expect(invalidatePrefixMock).toHaveBeenNthCalledWith(
      2,
      "context-stats:bob:",
    );
  });

  it("ignores payloads without a userId", async () => {
    startContextStatsInvalidator();
    await handlers[0]?.(TOPIC, {});
    await handlers[0]?.(TOPIC, { userId: 42 });
    await handlers[0]?.(TOPIC, { userId: "" });
    await handlers[0]?.(TOPIC, null);
    expect(invalidatePrefixMock).not.toHaveBeenCalled();
  });

  it("swallows invalidatePrefix errors (best-effort)", async () => {
    startContextStatsInvalidator();
    invalidatePrefixMock.mockRejectedValueOnce(new Error("redis down"));
    // Should not throw.
    await expect(
      handlers[0]?.(TOPIC, { userId: "alice" }),
    ).resolves.toBeUndefined();
  });

  it("returns an unsubscribe handle that removes the handler", () => {
    const stop = startContextStatsInvalidator();
    expect(handlers).toHaveLength(1);
    stop();
    expect(handlers).toHaveLength(0);
  });
});

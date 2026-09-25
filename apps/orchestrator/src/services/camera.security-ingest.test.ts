/**
 * WARP-2977 (ADR-059 §3.3) — camera.service feeds the Security event store.
 *
 * Three wiring facts, each a way this could ship built-but-dark:
 *
 *   1. It subscribes to the topics Frigate 0.17 actually publishes. Until
 *      now it subscribed to `frigate/+/status`; Frigate's health topic is
 *      `frigate/<camera>/status/<role>`, and `+` is exactly one level, so
 *      online/offline never arrived.
 *   2. Every Frigate `end` is persisted — INCLUDING the ones
 *      camera-event-gate drops for the toast/push surface. The gate drops a
 *      second person while the first is tracked (`drop_active`), and that
 *      person's `end` then reads as `drop_stale`. Persisting behind the gate
 *      would lose exactly the busy moments.
 *   3. A refused subscription is recorded as the ingest being DOWN, which
 *      /security shows, rather than a quiet feed.
 *   4. WARP-2978 PR-D — the in-flight map (who is still in view) is fed from
 *      the same RAW messages, before the gate, and forgets people when their
 *      camera or Frigate goes away — not when the broker blips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageHandler = (topic: string, payload: Buffer) => void;
type SubscribeCallback = (err: Error | null, granted?: Array<{ topic: string; qos: number }>) => void;

const handlers: Record<string, unknown> = {};
const fakeClient = {
  on: (event: string, cb: unknown) => {
    handlers[event] = cb;
  },
  subscribe: vi.fn(),
  end: vi.fn(),
};

vi.mock("mqtt", () => ({
  default: { connect: () => fakeClient },
}));

vi.mock("../config.js", () => ({
  config: { MQTT_BROKER: "mqtt://broker.test:1883", FRIGATE_URL: "http://frigate.test:5000" },
}));

vi.mock("../lib/internal-tls.js", () => ({
  mqttConnectOptions: () => ({}),
}));

vi.mock("./frigate.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  fetchCameras: vi.fn(),
  fetchConfig: vi.fn(),
  fetchEvents: vi.fn(),
  fetchEventsFiltered: vi.fn(),
  fetchRecordings: vi.fn(),
  fetchRecordingsSummary: vi.fn(),
  fetchReviews: vi.fn(),
  fetchStats: vi.fn(),
  fetchTimeline: vi.fn(),
  markReviewViewed: vi.fn(),
  searchEventsSemantic: vi.fn(),
  setEventRetain: vi.fn(),
  syncCamerasFromDb: vi.fn().mockResolvedValue([]),
}));

vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("./push-dispatch.service.js", () => ({
  dispatchDetectionEvent: vi.fn().mockResolvedValue(undefined),
}));

import { initCameraService, securityOngoingSource, shutdownCameraService, subscribeCameraEvents } from "./camera.service.js";
import type { CameraSSEEvent } from "../types/camera.js";
import { resetCameraEventGateForTests } from "./camera-event-gate.js";
import { _resetSecurityIngestHealthForTests, securityIngestHealthState } from "./security-events.service.js";
import { INFLIGHT_MAX_AGE_MS } from "./security-inflight.js";

const createMany = vi.fn();
const findFirst = vi.fn();
const prisma = { securityEvent: { createMany, findFirst } } as never;

function message(topic: string, payload: unknown) {
  (handlers.message as MessageHandler)(topic, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
}

function frigate(type: "new" | "update" | "end", id: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    before: {},
    after: {
      id,
      camera: "front_door",
      label: "person",
      start_time: 1_790_000_000,
      end_time: type === "end" ? 1_790_000_010 : null,
      top_score: 0.9,
      entered_zones: [],
      ...extra,
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Subscribe as an unrestricted viewer. WARP-2982 (#2297) adds a REQUIRED
 * per-subscriber scope argument; before it lands the extra argument is
 * ignored. Called through a widened signature so this file compiles and
 * behaves the same whichever of the two PRs reaches stage first.
 */
const subscribeAll = (cb: (e: CameraSSEEvent) => void): (() => void) =>
  (subscribeCameraEvents as unknown as (cb: (e: CameraSSEEvent) => void, scope: () => "all") => () => void)(
    cb,
    () => "all",
  );

beforeEach(async () => {
  resetCameraEventGateForTests();
  _resetSecurityIngestHealthForTests();
  createMany.mockReset().mockResolvedValue({ count: 1 });
  findFirst.mockReset().mockResolvedValue(null);
  fakeClient.subscribe.mockReset();
  await initCameraService(prisma);
  (handlers.connect as () => void)();
});

afterEach(async () => {
  await shutdownCameraService();
});

describe("subscriptions — the topics Frigate 0.17 publishes", () => {
  function securitySubscribe() {
    const call = fakeClient.subscribe.mock.calls.find(
      ([topics]) => typeof topics === "object" && topics !== null && "frigate/events" in topics,
    );
    expect(call).toBeDefined();
    return call as [Record<string, { qos: number }>, SubscribeCallback];
  }

  it("subscribes to events, per-camera detect health and Frigate's LWT — and not the old one-level status topic", () => {
    const [topics] = securitySubscribe();
    expect(Object.keys(topics).sort()).toEqual(["frigate/+/status/detect", "frigate/available", "frigate/events"]);
    const flat = fakeClient.subscribe.mock.calls.flatMap(([t]) => (typeof t === "string" ? [t] : Object.keys(t)));
    expect(flat).not.toContain("frigate/+/status");
  });

  it("a granted SUBACK marks the ingest subscribed", () => {
    const [topics, cb] = securitySubscribe();
    cb(null, Object.keys(topics).map((topic) => ({ topic, qos: 1 })));
    expect(securityIngestHealthState().frigateSubscribed).toBe(true);
  });

  it("a topic the broker refused (QoS 128) marks the ingest DOWN, naming the topic", () => {
    const [, cb] = securitySubscribe();
    cb(null, [
      { topic: "frigate/events", qos: 128 },
      { topic: "frigate/+/status/detect", qos: 1 },
      { topic: "frigate/available", qos: 1 },
    ]);
    const h = securityIngestHealthState();
    expect(h.frigateSubscribed).toBe(false);
    expect(h.frigateSubscribeError).toContain("frigate/events");
  });

  it("a dropped broker marks the ingest DOWN until the next SUBACK brings it back", () => {
    const [topics, cb] = securitySubscribe();
    cb(null, Object.keys(topics).map((topic) => ({ topic, qos: 1 })));
    expect(securityIngestHealthState().frigateSubscribed).toBe(true);

    (handlers.close as () => void)();
    expect(securityIngestHealthState().frigateSubscribed).toBe(false);
    expect(securityIngestHealthState().frigateSubscribeError).toMatch(/lost the connection/i);

    // mqtt.js reconnects → `connect` → resubscribe → SUBACK.
    fakeClient.subscribe.mockClear();
    (handlers.connect as () => void)();
    const [again, cb2] = securitySubscribe();
    cb2(null, Object.keys(again).map((topic) => ({ topic, qos: 1 })));
    expect(securityIngestHealthState().frigateSubscribed).toBe(true);
  });

  it("`offline` counts as a dropped broker too", () => {
    const [topics, cb] = securitySubscribe();
    cb(null, Object.keys(topics).map((topic) => ({ topic, qos: 1 })));
    (handlers.offline as () => void)();
    expect(securityIngestHealthState().frigateSubscribed).toBe(false);
  });

  it("a subscribe error marks the ingest DOWN", () => {
    const [, cb] = securitySubscribe();
    cb(new Error("connection lost"));
    expect(securityIngestHealthState().frigateSubscribed).toBe(false);
    expect(securityIngestHealthState().frigateSubscribeError).toBe("connection lost");
  });
});

describe("detections — one row per object, on end, never behind the gate", () => {
  it("an end is stored once; new and update are not", async () => {
    message("frigate/events", frigate("new", "e1"));
    message("frigate/events", frigate("update", "e1"));
    expect(createMany).not.toHaveBeenCalled();
    message("frigate/events", frigate("end", "e1"));
    await flush();
    expect(createMany).toHaveBeenCalledTimes(1);
    const [{ data, skipDuplicates }] = createMany.mock.calls[0];
    expect(skipDuplicates).toBe(true);
    expect(data[0]).toMatchObject({ source: "frigate", kind: "detection", dedupeKey: "frigate:e1", camera: "front_door" });
  });

  it("a second person the gate DROPS (drop_active → drop_stale on end) is still stored", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeAll((e) => events.push(`${e.type}:${"eventId" in e ? e.eventId : ""}`));
    try {
      message("frigate/events", frigate("new", "first"));
      message("frigate/events", frigate("new", "second")); // gate: drop_active
      message("frigate/events", frigate("end", "second")); // gate: drop_stale
      await flush();
      // The live surface never heard of `second`…
      expect(events).toEqual(["detection:first"]);
      // …but the store did.
      const stored = createMany.mock.calls.map(([{ data }]) => data[0].dedupeKey);
      expect(stored).toEqual(["frigate:second"]);
    } finally {
      unsubscribe();
    }
  });

  it("an end inside the gate's cooldown is still stored", async () => {
    message("frigate/events", frigate("new", "a"));
    message("frigate/events", frigate("end", "a"));
    message("frigate/events", frigate("new", "b")); // gate: drop_cooldown
    message("frigate/events", frigate("end", "b"));
    await flush();
    expect(createMany.mock.calls.map(([{ data }]) => data[0].dedupeKey)).toEqual(["frigate:a", "frigate:b"]);
  });

  it("a store failure does not break the live surface", async () => {
    createMany.mockRejectedValue(new Error("db down"));
    const events: string[] = [];
    const unsubscribe = subscribeAll((e) => events.push(e.type));
    try {
      message("frigate/events", frigate("new", "x"));
      message("frigate/events", frigate("end", "x"));
      await flush();
      expect(events).toEqual(["detection", "detection_end"]);
      // WARP-2977 P2b-2: write health is per source; a detection is `frigate`.
      expect(securityIngestHealthState().lastWriteError.get("frigate")?.message).toBe("db down");
    } finally {
      unsubscribe();
    }
  });
});

describe("camera health — transitions only, and the dashboard hears them again", () => {
  it("a camera going dark is broadcast even when its row cannot be saved", async () => {
    findFirst.mockResolvedValue({ kind: "camera_online" });
    createMany.mockRejectedValue(new Error("db down"));
    const events: Array<{ type: string; camera?: string }> = [];
    const unsubscribe = subscribeAll((e) => events.push({ type: e.type, camera: e.camera }));
    try {
      message("frigate/front_door/status/detect", "offline");
      await flush();
      await flush();
      expect(events).toEqual([{ type: "camera_offline", camera: "front_door" }]);
    } finally {
      unsubscribe();
    }
  });

  it("online → offline stores a camera_offline and broadcasts it", async () => {
    findFirst.mockResolvedValue({ kind: "camera_online" });
    const events: Array<{ type: string; camera?: string }> = [];
    const unsubscribe = subscribeAll((e) => events.push({ type: e.type, camera: e.camera }));
    try {
      message("frigate/front_door/status/detect", "offline");
      await flush();
      await flush();
      expect(createMany).toHaveBeenCalledTimes(1);
      expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ kind: "camera_offline", camera: "front_door" });
      expect(events).toEqual([{ type: "camera_offline", camera: "front_door" }]);
    } finally {
      unsubscribe();
    }
  });

  it("a retained `online` replayed on reconnect is not news", async () => {
    findFirst.mockResolvedValue({ kind: "camera_online" });
    message("frigate/front_door/status/detect", "online");
    await flush();
    await flush();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("the record and audio roles are ignored", async () => {
    message("frigate/front_door/status/record", "offline");
    message("frigate/front_door/status/audio", "offline");
    await flush();
    expect(findFirst).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("Frigate's own LWT going offline is a source_offline row", async () => {
    findFirst.mockResolvedValue({ kind: "source_online" });
    message("frigate/available", "offline");
    await flush();
    await flush();
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ kind: "source_offline", camera: null });
  });

  it("every Frigate message counts as the ingest hearing from Frigate", () => {
    expect(securityIngestHealthState().lastFrigateMessageAt).toBeNull();
    message("frigate/front_door/status/record", "online");
    expect(securityIngestHealthState().lastFrigateMessageAt).toBeNull(); // not a topic we read
    message("frigate/available", "online");
    expect(securityIngestHealthState().lastFrigateMessageAt).toBeInstanceOf(Date);
  });
});

describe("WARP-2978 PR-D — the in-flight map is fed from the raw messages, before the gate", () => {
  /** Tracking that started 40 s ago (the map drops anything older than 6 h, so this is relative to the real clock). */
  const startedSec = () => Math.floor(Date.now() / 1000) - 40;
  const dueIds = () => securityOngoingSource().due(new Date()).map((o) => o.id).sort();

  it("a person the gate DROPS (a second one while the first is tracked) is still in the map", () => {
    const start_time = startedSec();
    message("frigate/events", frigate("new", "first", { start_time }));
    message("frigate/events", frigate("new", "second", { start_time })); // gate: drop_active
    message("frigate/events", frigate("update", "second", { start_time }));
    expect(dueIds()).toEqual(["first", "second"]);
    // camera.service itself writes nothing for a track — the incident engine does.
    expect(createMany).not.toHaveBeenCalled();
  });

  it("end forgets the person", () => {
    const start_time = startedSec();
    message("frigate/events", frigate("new", "p", { start_time }));
    message("frigate/events", frigate("end", "p", { start_time }));
    expect(dueIds()).toEqual([]);
  });

  it("their camera going offline or disabled forgets its people; Frigate's LWT going offline forgets everyone", () => {
    const start_time = startedSec();
    message("frigate/events", frigate("new", "a", { start_time }));
    message("frigate/events", frigate("new", "b", { start_time, camera: "yard" }));
    message("frigate/events", frigate("new", "c", { start_time, camera: "till" }));
    message("frigate/front_door/status/detect", "offline");
    expect(dueIds()).toEqual(["b", "c"]);
    message("frigate/yard/status/detect", "disabled");
    expect(dueIds()).toEqual(["c"]);
    message("frigate/till/status/detect", "online");
    expect(dueIds()).toEqual(["c"]);
    message("frigate/available", "offline");
    expect(dueIds()).toEqual([]);
  });

  it("a dropped broker forgets nobody: a person standing still (no `update` after the reconnect) still holds, and their `end` still gets the grace", () => {
    const start_time = startedSec();
    const inView = () => securityOngoingSource().inView("a", new Date());
    message("frigate/events", frigate("new", "a", { start_time }));
    securityOngoingSource().markWritten("a"); // the engine wrote their ongoing row
    // mqtt.js emits `close` (and `offline`) on every reconnect cycle.
    (handlers.close as () => void)();
    expect(inView()).toBe(true);
    (handlers.offline as () => void)();
    expect(inView()).toBe(true);
    (handlers.connect as () => void)();
    message("frigate/events", frigate("end", "a", { start_time }));
    expect(inView()).toBe(true);
  });

  it("an `end` lost while the broker was away is bounded: the entry goes at the 6 h age limit (its hold already stopped at the span cap)", () => {
    const start_time = startedSec();
    message("frigate/events", frigate("new", "b", { start_time }));
    (handlers.close as () => void)();
    (handlers.connect as () => void)(); // clean session: Frigate's `end` for b is never redelivered
    expect(dueIds()).toEqual(["b"]);
    const past = new Date(start_time * 1000 + INFLIGHT_MAX_AGE_MS + 1);
    expect(securityOngoingSource().inView("b", past)).toBe(false);
    expect(securityOngoingSource().due(past)).toEqual([]);
  });
});

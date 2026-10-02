/**
 * camera.service — the Frigate MQTT ingest. Frigate is the camera system's
 * only live source, so three wiring facts are each a way this could ship
 * built-but-dark:
 *
 *   1. It subscribes to the topics Frigate 0.17 actually publishes. Frigate's
 *      health topic is `frigate/<camera>/status/<role>`; MQTT's `+` is exactly
 *      one level, so a subscription to `frigate/+/status` never delivers a
 *      camera going online or offline.
 *   2. A camera going dark (or coming back) reaches the dashboard as an SSE
 *      `camera_offline` / `camera_online` — on a TRANSITION only, because the
 *      topic is retained and every reconnect replays the current state.
 *   3. Detections still reach the live stream: `detection` for a new event,
 *      `detection_update` and `detection_end` for the active one, and push
 *      fan-out for a labelled new one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageHandler = (topic: string, payload: Buffer) => void;
type SubscribeCallback = (err: Error | null, granted?: Array<{ topic: string; qos: number }>) => void;

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  dispatch: vi.fn(),
}));

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

vi.mock("../lib/logger.js", () => ({
  createLogger: () => h.logger,
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
  dispatchDetectionEvent: h.dispatch,
}));

import { initCameraService, shutdownCameraService, subscribeCameraEvents } from "./camera.service.js";
import type { CameraSSEEvent } from "../types/camera.js";
import { resetCameraEventGateForTests } from "./camera-event-gate.js";

const prisma = {} as never;

function message(topic: string, payload: unknown) {
  (handlers.message as MessageHandler)(topic, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)));
}

function frigate(type: "new" | "update" | "end", id: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    before: {},
    after: { id, camera: "front_door", label: "person", top_score: 0.9, ...extra },
  };
}

/** Every event the live stream carries, as an unrestricted subscriber would see it. */
function listen(): { events: Array<{ type: string; camera?: string }>; stop: () => void } {
  const events: Array<{ type: string; camera?: string }> = [];
  const stop = subscribeCameraEvents(
    (e: CameraSSEEvent) => events.push({ type: e.type, camera: e.camera }),
    () => "all",
  );
  return { events, stop };
}

beforeEach(async () => {
  resetCameraEventGateForTests();
  h.dispatch.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(h.logger)) fn.mockReset();
  fakeClient.subscribe.mockReset();
  await initCameraService(prisma);
  (handlers.connect as () => void)();
});

afterEach(async () => {
  await shutdownCameraService();
});

describe("subscriptions — the topics Frigate 0.17 publishes", () => {
  function frigateSubscribe() {
    const call = fakeClient.subscribe.mock.calls.find(
      ([topics]) => typeof topics === "object" && topics !== null && "frigate/events" in topics,
    );
    expect(call).toBeDefined();
    return call as [Record<string, { qos: number }>, SubscribeCallback];
  }

  it("subscribes to events and per-camera detect health — and not the old one-level status topic", () => {
    const [topics] = frigateSubscribe();
    expect(Object.keys(topics).sort()).toEqual(["frigate/+/status/detect", "frigate/events"]);
    const flat = fakeClient.subscribe.mock.calls.flatMap(([t]) => (typeof t === "string" ? [t] : Object.keys(t)));
    expect(flat).not.toContain("frigate/+/status");
  });

  it("still subscribes to camera discovery", () => {
    expect(fakeClient.subscribe.mock.calls.some(([t]) => t === "droplet/cameras/discovered")).toBe(true);
  });

  it("a granted SUBACK is quiet", () => {
    const [topics, cb] = frigateSubscribe();
    cb(null, Object.keys(topics).map((topic) => ({ topic, qos: 1 })));
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("a topic the broker refused (QoS 128) is logged at error, naming the topic", () => {
    const [, cb] = frigateSubscribe();
    cb(null, [
      { topic: "frigate/events", qos: 128 },
      { topic: "frigate/+/status/detect", qos: 1 },
    ]);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    expect(h.logger.error.mock.calls[0][0]).toEqual({ refused: ["frigate/events"] });
  });

  it("a subscribe error is logged at error", () => {
    const [, cb] = frigateSubscribe();
    cb(new Error("connection lost"));
    expect(h.logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("camera health — transitions only, and the dashboard hears them", () => {
  it("online → offline → online is broadcast as camera_offline then camera_online", () => {
    const { events, stop } = listen();
    try {
      message("frigate/front_door/status/detect", "online"); // first sight of a healthy camera: not news
      message("frigate/front_door/status/detect", "offline");
      message("frigate/front_door/status/detect", "online");
      expect(events).toEqual([
        { type: "camera_offline", camera: "front_door" },
        { type: "camera_online", camera: "front_door" },
      ]);
    } finally {
      stop();
    }
  });

  it("a repeat, or a retained replay on reconnect, is not news", () => {
    const { events, stop } = listen();
    try {
      message("frigate/front_door/status/detect", "online");
      message("frigate/front_door/status/detect", "online");
      message("frigate/front_door/status/detect", "offline");
      message("frigate/front_door/status/detect", "offline"); // retained replay after a reconnect
      expect(events).toEqual([{ type: "camera_offline", camera: "front_door" }]);
    } finally {
      stop();
    }
  });

  it("first sight of a camera that is already offline is news", () => {
    const { events, stop } = listen();
    try {
      message("frigate/yard/status/detect", "offline");
      expect(events).toEqual([{ type: "camera_offline", camera: "yard" }]);
    } finally {
      stop();
    }
  });

  it("a camera the owner switched off is remembered but never broadcast, and its next online is not a recovery", () => {
    const { events, stop } = listen();
    try {
      message("frigate/yard/status/detect", "online");
      message("frigate/yard/status/detect", "disabled");
      message("frigate/yard/status/detect", "online");
      expect(events).toEqual([]);
      message("frigate/yard/status/detect", "offline");
      expect(events).toEqual([{ type: "camera_offline", camera: "yard" }]);
    } finally {
      stop();
    }
  });

  it("each camera is tracked on its own", () => {
    const { events, stop } = listen();
    try {
      message("frigate/front_door/status/detect", "online");
      message("frigate/yard/status/detect", "online");
      message("frigate/yard/status/detect", "offline");
      expect(events).toEqual([{ type: "camera_offline", camera: "yard" }]);
    } finally {
      stop();
    }
  });

  it("the record and audio roles, an unreadable payload and an unsafe camera name are ignored", () => {
    const { events, stop } = listen();
    try {
      message("frigate/front_door/status/record", "offline");
      message("frigate/front_door/status/audio", "offline");
      message("frigate/front_door/status/detect", "garbled");
      message(`frigate/${"x".repeat(65)}/status/detect`, "offline");
      message("frigate/available", "offline"); // Frigate's own LWT is not a camera
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("detections reach the live stream", () => {
  it("new → detection (and push for a labelled one), update → detection_update, end → detection_end", () => {
    const { events, stop } = listen();
    try {
      message("frigate/events", frigate("new", "e1"));
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(h.dispatch.mock.calls[0][1]).toMatchObject({ eventId: "e1", cameraName: "front_door", label: "person" });
      message("frigate/events", frigate("update", "e1"));
      message("frigate/events", frigate("end", "e1"));
      expect(events).toEqual([
        { type: "detection", camera: "front_door" },
        { type: "detection_update", camera: "front_door" },
        { type: "detection_end", camera: "front_door" },
      ]);
    } finally {
      stop();
    }
  });

  it("an unlabelled detection is broadcast but not pushed", () => {
    const { events, stop } = listen();
    try {
      message("frigate/events", frigate("new", "e2", { label: "" }));
      expect(events).toEqual([{ type: "detection", camera: "front_door" }]);
      expect(h.dispatch).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("the per-camera gate still drops a second object while one is tracked", () => {
    const { events, stop } = listen();
    try {
      message("frigate/events", frigate("new", "first"));
      message("frigate/events", frigate("new", "second")); // gate: drop_active
      message("frigate/events", frigate("end", "second")); // gate: drop_stale
      expect(events).toEqual([{ type: "detection", camera: "front_door" }]);
    } finally {
      stop();
    }
  });

  it("a non-JSON message on an event topic is ignored", () => {
    const { events, stop } = listen();
    try {
      message("frigate/events", "not json");
      expect(events).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe("camera discovery", () => {
  it("a discovered camera is broadcast to the live stream", () => {
    const { events, stop } = listen();
    try {
      message("droplet/cameras/discovered", { camera: { name: "porch" } });
      expect(events).toEqual([{ type: "camera_discovered", camera: "porch" }]);
    } finally {
      stop();
    }
  });
});

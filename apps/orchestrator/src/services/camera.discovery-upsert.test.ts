/**
 * WARP-1847 — a discovery event must not create an un-streamable camera as an
 * enabled one.
 *
 * camera-discovery publishes `droplet/cameras/discovered` for every candidate it
 * touches, carrying the record's `status`: `active` once the stream verified and
 * the camera went into Frigate, `needs_setup` / `pending` while it is still
 * being re-probed. upsertCameraRecord ignored that field and let `enabled` fall
 * to its schema default of `true`, which had two consequences:
 *
 *   1. a camera with no working stream appeared in the operator's grid, and
 *   2. `GET /api/cameras/discovered`, which selects `enabled: false,
 *      autoDiscovered: true`, could never match it — the discovery list was
 *      structurally empty.
 *
 * `enabled` is create-only on purpose: POST /cameras/:name/disable writes
 * `enabled: false` for a working camera and discovery keeps re-publishing that
 * camera as active every sweep, so echoing status into `enabled` on update
 * would silently undo an operator's disable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageHandler = (topic: string, payload: Buffer) => void;

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
}));

vi.mock("./cache.service.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("./push-dispatch.service.js", () => ({
  dispatchDetectionEvent: vi.fn(),
}));

import { initCameraService, shutdownCameraService } from "./camera.service.js";

const upsert = vi.fn().mockResolvedValue({});
const prisma = { camera: { upsert } } as never;

/** Publish one discovery message through the real MQTT handler. */
async function publishDiscovery(camera: Record<string, unknown>): Promise<void> {
  (handlers.message as MessageHandler)(
    "droplet/cameras/discovered",
    Buffer.from(JSON.stringify({ event: "camera_discovered", camera })),
  );
  // upsertCameraRecord is fire-and-forget inside the handler.
  await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
}

beforeEach(async () => {
  upsert.mockClear();
  await initCameraService(prisma);
});

afterEach(async () => {
  await shutdownCameraService();
});

describe("discovery upsert", () => {
  it("creates a candidate that still needs credentials as disabled", async () => {
    await publishDiscovery({
      name: "XNV_C8083R",
      ip: "192.168.9.219",
      mac: "E4:30:22:50:2A:FD",
      manufacturer: "Hanwha",
      status: "needs_setup",
      detection_method: "rtsp_default_credentials",
    });

    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ name: "XNV_C8083R" });
    expect(arg.create).toMatchObject({
      name: "XNV_C8083R",
      ipAddress: "192.168.9.219",
      macAddress: "E4:30:22:50:2A:FD",
      enabled: false,
      autoDiscovered: true,
    });
  });

  it("creates a port-open guess as disabled too", async () => {
    await publishDiscovery({
      name: "camera_192_168_9_176",
      ip: "192.168.9.176",
      status: "pending",
      detection_method: "rtsp_port_open",
    });

    expect(upsert.mock.calls[0][0].create.enabled).toBe(false);
  });

  it("creates a camera that verified and reached Frigate as enabled", async () => {
    await publishDiscovery({
      name: "front_door",
      ip: "192.168.9.60",
      mac: "AA:BB:CC:DD:EE:FF",
      status: "active",
    });

    expect(upsert.mock.calls[0][0].create.enabled).toBe(true);
  });

  it("never writes enabled on update, so an operator's disable survives rediscovery", async () => {
    await publishDiscovery({
      name: "front_door",
      ip: "192.168.9.60",
      status: "active",
    });

    expect(upsert.mock.calls[0][0].update).not.toHaveProperty("enabled");
  });

  it("ignores a discovery event with no camera name", async () => {
    (handlers.message as MessageHandler)(
      "droplet/cameras/discovered",
      Buffer.from(JSON.stringify({ event: "camera_discovered", camera: { ip: "192.168.9.9" } })),
    );
    // Give the fire-and-forget upsert a chance to run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upsert).not.toHaveBeenCalled();
  });
});

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
 *
 * The second half of this file covers camera identity: the row is keyed by the
 * camera's hardware (MAC, falling back to IP), not by the name discovery
 * derived for it this sweep. A `where: { name }` upsert minted a second row
 * every time `_sanitize_camera_name` changed its answer — the "one camera, two
 * tiles, neither with a feed" the operator sees.
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
  syncCamerasFromDb: vi.fn().mockResolvedValue([]),
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
import { syncCamerasFromDb } from "./frigate.client.js";

interface Row {
  id: string;
  name: string;
  ipAddress: string;
  macAddress: string | null;
  enabled: boolean;
  createdAt: Date;
}

/** Rows the fake `findMany` will match against; set per test. */
let rows: Row[] = [];

const findMany = vi.fn(async () => rows);
const create = vi.fn().mockResolvedValue({});
const update = vi.fn().mockResolvedValue({});
const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
const prisma = { camera: { findMany, create, update, deleteMany } } as never;

/** Publish one discovery message through the real MQTT handler. */
async function publishDiscovery(camera: Record<string, unknown>): Promise<void> {
  (handlers.message as MessageHandler)(
    "droplet/cameras/discovered",
    Buffer.from(JSON.stringify({ event: "camera_discovered", camera })),
  );
  // upsertCameraRecord is fire-and-forget inside the handler.
  await vi.waitFor(() => expect(create.mock.calls.length + update.mock.calls.length).toBeGreaterThan(0));
}

function row(overrides: Partial<Row> & Pick<Row, "id" | "name">): Row {
  return {
    ipAddress: "",
    macAddress: null,
    enabled: false,
    createdAt: new Date("2026-08-10T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(async () => {
  rows = [];
  findMany.mockClear();
  create.mockClear();
  update.mockClear();
  deleteMany.mockClear();
  vi.mocked(syncCamerasFromDb).mockClear();
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

    expect(create.mock.calls[0][0].data).toMatchObject({
      name: "XNV_C8083R",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
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

    expect(create.mock.calls[0][0].data.enabled).toBe(false);
  });

  it("creates a camera that verified and reached Frigate as enabled", async () => {
    await publishDiscovery({
      name: "front_door",
      ip: "192.168.9.60",
      mac: "AA:BB:CC:DD:EE:FF",
      status: "active",
    });

    expect(create.mock.calls[0][0].data.enabled).toBe(true);
  });

  it("never writes enabled on update, so an operator's disable survives rediscovery", async () => {
    rows = [row({ id: "c1", name: "front_door", ipAddress: "192.168.9.60", enabled: false })];

    await publishDiscovery({
      name: "front_door",
      ip: "192.168.9.60",
      status: "active",
    });

    expect(update.mock.calls[0][0].data).not.toHaveProperty("enabled");
  });

  it("ignores a discovery event with no camera name", async () => {
    (handlers.message as MessageHandler)(
      "droplet/cameras/discovered",
      Buffer.from(JSON.stringify({ event: "camera_discovered", camera: { ip: "192.168.9.9" } })),
    );
    // Give the fire-and-forget upsert a chance to run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("camera identity", () => {
  it("stores a synthetic sweep key as no MAC rather than a fake one", async () => {
    await publishDiscovery({
      name: "camera_192_168_9_219",
      ip: "192.168.9.219",
      mac: "ip:192.168.9.219",
      status: "pending",
    });

    expect(create.mock.calls[0][0].data.macAddress).toBeNull();
  });

  it("updates the existing row when the same MAC arrives under a new name", async () => {
    rows = [
      row({
        id: "c1",
        name: "camera_192_168_9_219",
        ipAddress: "192.168.9.219",
        macAddress: "e4:30:22:50:2a:fd",
      }),
    ];

    await publishDiscovery({
      name: "xnv_c8083r",
      ip: "192.168.9.219",
      mac: "E4:30:22:50:2A:FD",
      status: "needs_setup",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: "c1" });
    // The placeholder name gives way to the real hostname once DHCP knows it.
    expect(update.mock.calls[0][0].data).toMatchObject({
      name: "xnv_c8083r",
      displayName: "Xnv C8083r",
    });
  });

  it("matches on IP when the sweep lost the DHCP lease and only has a placeholder", async () => {
    rows = [
      row({
        id: "c1",
        name: "xnv_c8083r_e43022502afd",
        ipAddress: "192.168.9.219",
        macAddress: "e4:30:22:50:2a:fd",
        enabled: true,
      }),
    ];

    await publishDiscovery({
      name: "camera_192_168_9_219",
      ip: "192.168.9.219",
      mac: "ip:192.168.9.219",
      status: "pending",
    });

    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].where).toEqual({ id: "c1" });
    // Adopted row: Frigate is keyed by this exact name, so it must not move,
    // and the real MAC must not be wiped by the placeholder.
    expect(update.mock.calls[0][0].data).not.toHaveProperty("name");
    expect(update.mock.calls[0][0].data).not.toHaveProperty("macAddress");
  });

  it("never renames a row to the camera_<ip> fallback", async () => {
    rows = [
      row({
        id: "c1",
        name: "xnv_c8083r",
        ipAddress: "192.168.9.219",
        macAddress: "e4:30:22:50:2a:fd",
        enabled: false,
      }),
    ];

    await publishDiscovery({
      name: "camera_192_168_9_219",
      ip: "192.168.9.219",
      mac: "E4:30:22:50:2A:FD",
      status: "pending",
    });

    expect(update.mock.calls[0][0].data).not.toHaveProperty("name");
  });

  it("collapses an existing duplicate pair onto the oldest row and prunes Frigate", async () => {
    rows = [
      row({
        id: "c1",
        name: "xnv_c8083r_e43022502afd",
        ipAddress: "192.168.9.219",
        macAddress: "e4:30:22:50:2a:fd",
        enabled: true,
        createdAt: new Date("2026-08-10T00:00:00Z"),
      }),
      row({
        id: "c2",
        name: "camera_192_168_9_219",
        ipAddress: "192.168.9.219",
        macAddress: null,
        createdAt: new Date("2026-08-11T00:00:00Z"),
      }),
    ];

    await publishDiscovery({
      name: "camera_192_168_9_219",
      ip: "192.168.9.219",
      mac: "E4:30:22:50:2A:FD",
      status: "active",
    });

    expect(update.mock.calls[0][0].where).toEqual({ id: "c1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["c2"] } } });
    // Without the prune, getCameras() re-adds the orphaned Frigate entry as a
    // phantom tile on the next poll and the duplicate is back.
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
  });

  it("leaves a recycled DHCP address alone — a different MAC is a different camera", async () => {
    rows = [
      row({
        id: "c1",
        name: "old_cam",
        ipAddress: "192.168.9.219",
        macAddress: "aa:bb:cc:dd:ee:ff",
      }),
    ];

    await publishDiscovery({
      name: "new_cam",
      ip: "192.168.9.219",
      mac: "E4:30:22:50:2A:FD",
      status: "pending",
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

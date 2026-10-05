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
 *   2. `GET /api/cameras/discovered`, which selects discovery placeholders,
 *      could never match it — the discovery list was structurally empty.
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
 *
 * The third half is WARP-3510: WHICH of those rows survives a merge. It used to
 * be the OLDEST — usually the never-adopted discovery placeholder — so when the
 * operator had added the device by hand, the merge deleted their live camera and
 * pruned it from Frigate (the Camera row stores no stream URL, so the
 * credentials-bearing config was lost with it). Adoption is now an explicit
 * state, ADOPTED outranks age, and only CANDIDATE rows are ever deleted or
 * renamed. The Camera table is an in-memory fake that EVALUATES where-clauses,
 * so the assertions are about what is left in the table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MessageHandler = (topic: string, payload: Buffer) => void;

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  dispatchDetectionEvent: vi.fn(),
}));

import { initCameraService, shutdownCameraService } from "./camera.service.js";
import { syncCamerasFromDb, type CameraKeySnapshot } from "./frigate.client.js";
import { cacheDel } from "./cache.service.js";
import { makeFakeTable } from "../__tests__/helpers/fake-table.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

type Row = Record<string, unknown>;

const table = makeFakeTable(() => ({
  displayName: "",
  manufacturer: null,
  model: null,
  ipAddress: "",
  macAddress: null,
  enabled: true,
  autoDiscovered: false,
  adoption: "CANDIDATE",
  lastSeen: new Date("2026-08-10T00:00:00Z"),
}));
const prismaStub: Record<string, unknown> = { camera: table.delegate };
const seam = createTransactionSeam({ client: () => prismaStub, stores: { cameras: table.rows } });
prismaStub.$transaction = seam.$transaction;
const prisma = prismaStub as never;

const rows = () => table.rows as Row[];
const byName = (name: string) => rows().find((r) => r.name === name);
const names = () => rows().map((r) => r.name).sort();
const day = (d: number) => new Date(`2026-08-${String(d).padStart(2, "0")}T00:00:00Z`);

/** Publish one discovery message through the real MQTT handler and let it settle. */
async function publishDiscovery(camera: Record<string, unknown>): Promise<void> {
  const before = vi.mocked(cacheDel).mock.calls.length;
  (handlers.message as MessageHandler)(
    "droplet/cameras/discovered",
    Buffer.from(JSON.stringify({ event: "camera_discovered", camera })),
  );
  // upsertCameraRecord is fire-and-forget inside the handler; it busts the
  // camera-list cache as its last step.
  await vi.waitFor(() => expect(vi.mocked(cacheDel).mock.calls.length).toBeGreaterThan(before));
}

/** A row as camera-discovery's earlier sweeps left it. */
function seed(over: Row): Row {
  return table.seed({ ipAddress: "", macAddress: null, createdAt: day(10), ...over });
}

const HANWHA = { ip: "192.168.9.219", mac: "E4:30:22:50:2A:FD" };

beforeEach(async () => {
  table.rows.length = 0;
  vi.clearAllMocks();
  vi.mocked(syncCamerasFromDb).mockResolvedValue([]);
  await initCameraService(prisma);
});

afterEach(async () => {
  await shutdownCameraService();
});

describe("discovery upsert", () => {
  it("creates a candidate that still needs credentials as a disabled CANDIDATE", async () => {
    await publishDiscovery({
      name: "xnv_c8083r",
      ...HANWHA,
      manufacturer: "Hanwha",
      status: "needs_setup",
      detection_method: "rtsp_default_credentials",
    });

    expect(byName("xnv_c8083r")).toMatchObject({
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      autoDiscovered: true,
      adoption: "CANDIDATE",
    });
  });

  it("creates a port-open guess as a disabled CANDIDATE too", async () => {
    await publishDiscovery({
      name: "camera_192_168_9_176",
      ip: "192.168.9.176",
      status: "pending",
      detection_method: "rtsp_port_open",
    });

    expect(byName("camera_192_168_9_176")).toMatchObject({ enabled: false, adoption: "CANDIDATE" });
  });

  it("creates a camera that verified and reached Frigate as an enabled ADOPTED row", async () => {
    await publishDiscovery({
      name: "front_door",
      ip: "192.168.9.60",
      mac: "AA:BB:CC:DD:EE:FF",
      status: "active",
    });

    expect(byName("front_door")).toMatchObject({ enabled: true, adoption: "ADOPTED", autoDiscovered: true });
  });

  it("never writes enabled on update, so an operator's disable survives rediscovery", async () => {
    seed({ name: "front_door", ipAddress: "192.168.9.60", enabled: false, adoption: "ADOPTED" });

    await publishDiscovery({ name: "front_door", ip: "192.168.9.60", status: "active" });

    expect(byName("front_door")).toMatchObject({ enabled: false, adoption: "ADOPTED" });
  });

  it("ignores a discovery event with no camera name", async () => {
    (handlers.message as MessageHandler)(
      "droplet/cameras/discovered",
      Buffer.from(JSON.stringify({ event: "camera_discovered", camera: { ip: "192.168.9.9" } })),
    );
    // Give the fire-and-forget upsert a chance to run before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rows()).toHaveLength(0);
  });

  it("files a camera under its canonical Frigate key", async () => {
    await publishDiscovery({ name: "Front-Door", ip: "192.168.9.60", status: "active" });

    expect(names()).toEqual(["front_door"]);
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

    expect(byName("camera_192_168_9_219")?.macAddress).toBeNull();
  });

  it("updates the existing row when the same MAC arrives under a new name", async () => {
    const r = seed({
      name: "camera_192_168_9_219",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
    });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(rows()).toHaveLength(1);
    // The never-adopted placeholder name gives way to the real hostname once DHCP knows it.
    expect(rows()[0]).toMatchObject({ id: r.id, name: "xnv_c8083r", displayName: "Xnv C8083r" });
  });

  it("matches on IP when the sweep lost the DHCP lease and only has a placeholder", async () => {
    const r = seed({
      name: "xnv_c8083r_e43022502afd",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: true,
      adoption: "ADOPTED",
    });

    await publishDiscovery({
      name: "camera_192_168_9_219",
      ip: "192.168.9.219",
      mac: "ip:192.168.9.219",
      status: "pending",
    });

    expect(rows()).toHaveLength(1);
    // Adopted row: Frigate is keyed by this exact name, so it must not move,
    // and the real MAC must not be wiped by the placeholder.
    expect(rows()[0]).toMatchObject({
      id: r.id,
      name: "xnv_c8083r_e43022502afd",
      macAddress: "e4:30:22:50:2a:fd",
    });
  });

  it("never renames a row to the camera_<ip> fallback", async () => {
    seed({
      name: "xnv_c8083r",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
    });

    await publishDiscovery({ name: "camera_192_168_9_219", ...HANWHA, status: "pending" });

    expect(names()).toEqual(["xnv_c8083r"]);
  });

  it("leaves a recycled DHCP address alone — a different MAC is a different camera", async () => {
    seed({ name: "old_cam", ipAddress: "192.168.9.219", macAddress: "aa:bb:cc:dd:ee:ff", enabled: false });

    await publishDiscovery({ name: "new_cam", ...HANWHA, status: "pending" });

    expect(names()).toEqual(["new_cam", "old_cam"]);
    expect(byName("old_cam")).toMatchObject({ macAddress: "aa:bb:cc:dd:ee:ff" });
    expect(syncCamerasFromDb).not.toHaveBeenCalled();
  });
});

describe("WARP-3510 — an ADOPTED camera outranks age in a merge", () => {
  it("keeps the operator's newer live camera and drops the older placeholder (the inverse order)", async () => {
    // R1: discovery's never-adopted placeholder, oldest. R2: the operator's
    // live camera, added by hand under another name — newer, no MAC yet.
    seed({
      name: "camera_192_168_9_219",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      adoption: "CANDIDATE",
      createdAt: day(10),
    });
    const live = seed({
      name: "warp_lab_office",
      ipAddress: "192.168.9.219",
      macAddress: null,
      enabled: true,
      adoption: "ADOPTED",
      createdAt: day(11),
    });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(names()).toEqual(["warp_lab_office"]);
    expect(rows()[0]).toMatchObject({
      id: live.id,
      adoption: "ADOPTED",
      enabled: true,
      // …and it picks up the hardware address discovery learned.
      macAddress: "e4:30:22:50:2a:fd",
    });
  });

  it("never prunes the surviving camera's Frigate key after the merge", async () => {
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", enabled: false, createdAt: day(10) });
    seed({ name: "warp_lab_office", ipAddress: "192.168.9.219", enabled: true, adoption: "ADOPTED", createdAt: day(11) });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    // The prune takes its DB snapshot inside Frigate's config lock, via a
    // reader — and what it reads names the live camera as ADOPTED.
    await vi.waitFor(() => expect(syncCamerasFromDb).toHaveBeenCalledTimes(1));
    const reader = vi.mocked(syncCamerasFromDb).mock.calls[0][0] as () => Promise<CameraKeySnapshot>;
    expect(typeof reader).toBe("function");
    expect(await reader()).toEqual({ names: ["warp_lab_office"], adopted: ["warp_lab_office"] });
  });

  it("deletes only CANDIDATE rows — an ADOPTED row between two placeholders survives", async () => {
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", enabled: false, createdAt: day(10) });
    seed({ name: "front_cam", ipAddress: "192.168.9.219", enabled: true, adoption: "ADOPTED", createdAt: day(11) });
    seed({ name: "xnv_c8083r", ipAddress: "192.168.9.219", enabled: false, createdAt: day(12) });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(names()).toEqual(["front_cam"]);
  });

  it("deletes nothing when two ADOPTED rows share a device, and says so", async () => {
    // Two cameras the operator owns on one device (a second stream profile, or
    // a double add). Neither is ours to delete; the operator has to look.
    seed({ name: "office_main", ipAddress: "192.168.9.219", adoption: "ADOPTED", createdAt: day(10) });
    seed({ name: "office_sub", ipAddress: "192.168.9.219", adoption: "ADOPTED", createdAt: day(11) });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(names()).toEqual(["office_main", "office_sub"]);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ adopted: ["office_main", "office_sub"] }),
      expect.stringMatching(/adopted camera rows share one device/i),
    );
    expect(syncCamerasFromDb).not.toHaveBeenCalled();
  });

  it("never renames an ADOPTED camera, even one the operator has disabled", async () => {
    // `enabled: false` is the operator switching detection off on a LIVE
    // camera. It used to read as "never adopted", so a discovery hostname
    // renamed the row — and the reconcile pruned the Frigate key it left behind.
    const r = seed({
      name: "xnv_c8083r_e43022502afd",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      adoption: "ADOPTED",
    });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id: r.id, name: "xnv_c8083r_e43022502afd", enabled: false, adoption: "ADOPTED" });
  });

  it("promotes a CANDIDATE to ADOPTED when discovery reports it verified and in Frigate", async () => {
    const r = seed({
      name: "camera_192_168_9_219",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
    });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "active" });

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ id: r.id, name: "xnv_c8083r", adoption: "ADOPTED", enabled: true });
  });

  it("files the row under the key Frigate holds, even when that key is the camera_<ip> fallback", async () => {
    // For an ACTIVE event the name IS the Frigate key camera-discovery just
    // added. A row left under another name would be pruned as an orphan.
    seed({ name: "xnv_c8083r", ipAddress: "192.168.9.219", macAddress: "e4:30:22:50:2a:fd", enabled: false });

    await publishDiscovery({ name: "camera_192_168_9_219", ...HANWHA, status: "active" });

    expect(names()).toEqual(["camera_192_168_9_219"]);
    expect(rows()[0]).toMatchObject({ adoption: "ADOPTED" });
  });

  it("reconciles Frigate only when a placeholder was actually deleted", async () => {
    seed({ name: "xnv_c8083r", ipAddress: "192.168.9.219", macAddress: "e4:30:22:50:2a:fd", enabled: false });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(syncCamerasFromDb).not.toHaveBeenCalled();
  });

  it("collapses an existing placeholder pair onto the oldest row and prunes Frigate", async () => {
    seed({ name: "xnv_c8083r_e43022502afd", ipAddress: "192.168.9.219", macAddress: "e4:30:22:50:2a:fd", createdAt: day(10) });
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", macAddress: null, createdAt: day(11) });

    await publishDiscovery({ name: "camera_192_168_9_219", ...HANWHA, status: "pending" });

    expect(names()).toEqual(["xnv_c8083r_e43022502afd"]);
    // Without the prune, getCameras() re-adds the orphaned Frigate entry as a
    // phantom tile on the next poll and the duplicate is back.
    await vi.waitFor(() => expect(syncCamerasFromDb).toHaveBeenCalledTimes(1));
  });

  it("still merges when the Frigate prune fails — it is best-effort", async () => {
    vi.mocked(syncCamerasFromDb).mockRejectedValueOnce(new Error("frigate down"));
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", createdAt: day(10) });
    seed({ name: "warp_lab_office", ipAddress: "192.168.9.219", adoption: "ADOPTED", createdAt: day(11) });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(names()).toEqual(["warp_lab_office"]);
  });
});

describe("a merge is one transaction (WARP-3510)", () => {
  it("leaves the placeholders in place when the survivor's update fails", async () => {
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", createdAt: day(10) });
    seed({ name: "warp_lab_office", ipAddress: "192.168.9.219", adoption: "ADOPTED", createdAt: day(11) });
    table.delegate.update.mockRejectedValueOnce(new Error("connection reset"));

    (handlers.message as MessageHandler)(
      "droplet/cameras/discovered",
      Buffer.from(JSON.stringify({ event: "camera_discovered", camera: { name: "xnv_c8083r", ...HANWHA, status: "needs_setup" } })),
    );
    await vi.waitFor(() => expect(h.logger.error).toHaveBeenCalled());

    // The delete of the placeholder was rolled back with the failed update.
    expect(names()).toEqual(["camera_192_168_9_219", "warp_lab_office"]);
  });

  it("never deletes a row adopted after the merge read it", async () => {
    seed({ name: "camera_192_168_9_219", ipAddress: "192.168.9.219", createdAt: day(10) });
    const racing = seed({ name: "xnv_c8083r", ipAddress: "192.168.9.219", createdAt: day(11) });
    const realFindMany = table.delegate.findMany.getMockImplementation()!;
    table.delegate.findMany.mockImplementationOnce(async (args) => {
      const stale = await realFindMany(args);
      (racing as Row).adoption = "ADOPTED"; // another request adopts it now
      return stale;
    });

    await publishDiscovery({ name: "xnv_c8083r", ...HANWHA, status: "needs_setup" });

    expect(byName("xnv_c8083r")).toMatchObject({ adoption: "ADOPTED" });
    // The survivor does not take over a name the surviving row still holds.
    expect(byName("camera_192_168_9_219")).toBeTruthy();
  });
});

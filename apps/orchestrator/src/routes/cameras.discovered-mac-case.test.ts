/**
 * WARP-3508 — the ✕ and Add buttons on a discovered camera answered 404.
 *
 * The orchestrator builds a candidate id from the MAC it normalises for display
 * (`mac:E4:30:22:50:2A:FD`, upper-case) and forwarded the MAC inside it to
 * camera-discovery verbatim. camera-discovery keys its pending map by the
 * LOWER-case MAC and looks it up exactly, so every accept and reject missed.
 * (Reproduced live on a box: the same reject with the lower-case MAC returned 200.)
 *
 * This drives the real route and the real candidates service against a fake
 * camera-discovery that is exactly as strict as the deployed one, so the
 * orchestrator's half of the contract is pinned end to end rather than as a
 * mock-call assertion. The other half — discovery accepting any case — is
 * services/camera-discovery/tests/test_camera_key_contract.py.
 *
 * Harness: the same shape as cameras.discovered-list.test.ts, minus the mock of
 * camera-candidates.service (that mock is what hid this).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
    FRIGATE_URL: "http://frigate.test:5000",
    CAMERA_DISCOVERY_URL: "http://camera-discovery.test:8085",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  requireRoleOrMcpService:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));

vi.mock("../services/camera-retention-purge.service.js", () => ({
  loadCameraRetentionPolicy: vi.fn().mockResolvedValue({ clipDays: 14, eventDays: null }),
}));

const internalFetch = vi.fn();
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
  internalBaseUrl: (url: string) => url,
}));

const syncCamerasFromDb = vi.fn();
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(),
  fetchEventThumbnail: vi.fn(),
  fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(),
  fetchFaceImage: vi.fn(),
  deleteKnownFace: vi.fn(),
  deleteFaceImage: vi.fn(),
  deleteKnownPlate: vi.fn(),
  nameKnownPlate: vi.fn(),
  regenerateEventDescription: vi.fn(),
  tagEventAsFace: vi.fn(),
  openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(),
  enableDetection: vi.fn(),
  disableDetection: vi.fn(),
  deleteCamera: vi.fn(),
  addCamera: vi.fn(),
  withFrigateConfigLock: (section: () => Promise<unknown>) => section(),
  syncCamerasFromDb: (...a: unknown[]) => syncCamerasFromDb(...a),
  fetchEvents: vi.fn(),
  fetchConfig: vi.fn().mockResolvedValue({ cameras: {} }),
  buildRecordingClipUrl: vi.fn(),
  buildVodMasterUrl: vi.fn(),
  buildVodSegmentUrl: vi.fn(),
  fetchHlsPlaylist: vi.fn(),
  fetchPtzCapabilities: vi.fn(),
  ptzGoToPreset: vi.fn(),
  ptzMove: vi.fn(),
  restartFrigate: vi.fn(),
}));

vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(),
  invalidateCamerasCache: vi.fn(),
  getEventsFiltered: vi.fn(),
  getRecentEvents: vi.fn(),
  getRecordings: vi.fn(),
  getRecordingsSummary: vi.fn(),
  getReviewsFiltered: vi.fn(),
  getStats: vi.fn(),
  getTimelineEntries: vi.fn(),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: vi.fn(),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn(),
  signShareUrl: vi.fn(),
  verifyShareUrl: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncDownloadFile: vi.fn(),
}));
vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: vi.fn(),
  isValidGroupName: vi.fn(),
  isValidGroupIcon: vi.fn(),
}));
vi.mock("../services/camera-pins.service.js", () => ({}));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
}));

import { createCamerasRouter } from "./cameras.js";
import { makeFakeTable } from "../__tests__/helpers/fake-table.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

function makeDb() {
  const table = makeFakeTable(() => ({
    displayName: "",
    manufacturer: null,
    model: null,
    ipAddress: "",
    macAddress: null,
    enabled: false,
    autoDiscovered: true,
    adoption: "CANDIDATE",
    lastSeen: new Date("2026-08-10T00:00:00Z"),
  }));
  const prisma: Record<string, unknown> = { camera: table.delegate };
  const seam = createTransactionSeam({ client: () => prisma, stores: { cameras: table.rows } });
  prisma.$transaction = seam.$transaction;
  return { table, prisma };
}

function makeApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter(prisma as never));
  return app;
}

/**
 * camera-discovery as deployed: `pending_cameras` is keyed by the lower-case MAC
 * and accept/reject look it up with an exact match, so an upper-case key 404s.
 */
function fakeDiscovery(pendingKeys: string[]) {
  internalFetch.mockImplementation(async (url: string) => {
    const match = /\/cameras\/discovered\/([^/]+)\/(accept|reject)$/.exec(url);
    if (!match) return new Response("[]", { status: 200 });
    const key = decodeURIComponent(match[1]);
    if (!pendingKeys.includes(key)) {
      return new Response(JSON.stringify({ detail: "Camera not found" }), { status: 404 });
    }
    const ipOnly = key.startsWith("ip:");
    return new Response(JSON.stringify(match[2] === "accept" ? {
      status: "accepted",
      camera: {
        name: ipOnly ? "front_door_77" : "xnv_c8083r_e43022502afd",
        ip: ipOnly ? key.slice(3) : "192.168.9.219",
        mac: key,
        manufacturer: "Hanwha",
        model: "XNV-C8083R",
      },
    } : { status: "rejected" }), { status: 200 });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  syncCamerasFromDb.mockImplementation(async (loadSnapshot: () => Promise<unknown>) => {
    await loadSnapshot();
    return [];
  });
});

describe("accept / reject of a discovered camera, end to end", () => {
  const MAC = "e4:30:22:50:2a:fd";
  const ID = "mac:E4:30:22:50:2A:FD"; // what GET /api/cameras/discovered hands the dashboard

  it("accepts a camera whose candidate id carries an upper-case MAC", async () => {
    fakeDiscovery([MAC]);
    const db = makeDb();
    // The address changed since discovery filed the placeholder. Matching the
    // real MAC, case-insensitively, must still adopt that same row.
    const placeholder = db.table.seed({
      name: "camera_192_168_9_200", ipAddress: "192.168.9.200", macAddress: MAC.toUpperCase(),
    });

    const res = await request(makeApp(db.prisma)).post(`/api/cameras/discovered/${ID}/accept`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted" });
    expect(db.table.rows).toHaveLength(1);
    expect(db.table.rows[0]).toMatchObject({
      id: placeholder.id, name: "xnv_c8083r_e43022502afd", macAddress: MAC,
      ipAddress: "192.168.9.219", adoption: "ADOPTED", enabled: true,
    });
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
  });

  it("rejects a camera whose candidate id carries an upper-case MAC", async () => {
    fakeDiscovery([MAC]);
    const db = makeDb();
    db.table.seed({ name: "placeholder", macAddress: MAC });
    const adopted = db.table.seed({ name: "front_door", macAddress: MAC, adoption: "ADOPTED", enabled: true });

    const res = await request(makeApp(db.prisma)).post(`/api/cameras/discovered/${ID}/reject`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "rejected" });
    // The rejection also cleared the DB row, or the fallback list would resurrect it.
    expect(db.table.rows.map((row) => row.id)).toEqual([adopted.id]);
    expect(db.table.delegate.deleteMany).toHaveBeenCalledWith({
      where: { macAddress: { in: ["E4:30:22:50:2A:FD", MAC] }, adoption: "CANDIDATE" },
    });
  });

  it("reaches camera-discovery with the lower-case MAC in the path", async () => {
    fakeDiscovery([MAC]);

    await request(makeApp(makeDb().prisma)).post(`/api/cameras/discovered/${ID}/reject`);

    const urls = internalFetch.mock.calls.map((call) => (call as [string])[0]);
    expect(urls).toContain(
      "http://camera-discovery.test:8085/cameras/discovered/e4%3A30%3A22%3A50%3A2a%3Afd/reject",
    );
  });

  it("works for a camera discovery only knows by IP (no DHCP lease yet)", async () => {
    // normaliseMac upper-cases the synthetic `ip:` key too, so the id is `mac:IP:…`.
    fakeDiscovery(["ip:192.168.9.77"]);
    const db = makeDb();
    // A differently named row with no MAC can be found only by its address.
    const placeholder = db.table.seed({ name: "camera_192_168_9_77", ipAddress: "192.168.9.77" });

    const res = await request(makeApp(db.prisma)).post(
      "/api/cameras/discovered/mac:IP:192.168.9.77/accept",
    );

    expect(res.status).toBe(200);
    expect(db.table.rows).toHaveLength(1);
    expect(db.table.rows[0]).toMatchObject({
      id: placeholder.id, name: "front_door_77", macAddress: null,
      ipAddress: "192.168.9.77", adoption: "ADOPTED", enabled: true,
    });
    expect(internalFetch.mock.calls.map((call) => (call as [string])[0])).toContain(
      "http://camera-discovery.test:8085/cameras/discovered/ip%3A192.168.9.77/accept",
    );
  });

  it("still reports a genuinely unknown camera as 404", async () => {
    fakeDiscovery([]);
    const db = makeDb();
    db.table.seed({ name: "untouched", adoption: "ADOPTED", enabled: true });
    const before = structuredClone(db.table.rows);

    const res = await request(makeApp(db.prisma)).post(`/api/cameras/discovered/${ID}/accept`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(db.table.rows).toEqual(before);
    expect(syncCamerasFromDb).not.toHaveBeenCalled();
  });
});

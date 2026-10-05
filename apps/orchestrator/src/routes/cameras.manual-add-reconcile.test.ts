/**
 * POST /api/cameras — the manual "Add camera" pipeline.
 *
 * 2026-06-09 sweep — it must run the same best-effort Frigate reconcile (#11)
 * as accept/reject/delete, or an operator who only ever adds cameras manually
 * keeps stale orphaned Frigate config entries (e.g. camera_192_168_20_176 left
 * behind by a prior version / Postgres wipe) forever.
 *
 * WARP-3506 / WARP-3510 — the pipeline now:
 *   - files the camera under ONE canonical key (`Warp_Lab_Office` →
 *     `warp_lab_office`) in both Frigate and the DB, and keeps what the operator
 *     typed in `displayName` — it used to store the typed name verbatim, so the
 *     reconcile that follows every add pruned the camera it had just added;
 *   - links the device to the discovery placeholder camera-discovery already
 *     filed for it (by MAC, then IP) and adopts that row in place, instead of
 *     minting a duplicate that the next merge would keep and delete the live
 *     camera in favour of;
 *   - holds Frigate's config lock across the Frigate write AND the DB write, so
 *     a concurrent reconcile cannot prune a camera whose row is not there yet;
 *   - answers `ok` only once the camera is actually streaming, and otherwise a
 *     distinct, non-error `202 added_no_stream` the dashboard can show.
 *
 * Focused harness: supertest + a pass-through role gate; every service module
 * cameras.ts imports is mocked except camera-adoption (real, over an in-memory
 * Camera table that evaluates where-clauses), and only the manual-add path is
 * driven.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: { SERVICE_SECRET: "", FRIGATE_URL: "http://frigate.test:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  // cameras.ts also gates POST /cameras/clips/share with requireRoleOrMcpService;
  // stub it pass-through so createCamerasRouter doesn't throw at construction (WARP-912).
  requireRoleOrMcpService:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));

const addCamera = vi.fn();
const syncCamerasFromDb = vi.fn();
const waitForCameraStreaming = vi.fn();
const configLock = vi.fn();
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
  deleteCamera: vi.fn(),
  addCamera: (...a: unknown[]) => addCamera(...a),
  syncCamerasFromDb: (...a: unknown[]) => syncCamerasFromDb(...a),
  waitForCameraStreaming: (...a: unknown[]) => waitForCameraStreaming(...a),
  withFrigateConfigLock: (section: () => Promise<unknown>) => configLock(section),
  fetchEvents: vi.fn(),
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
  // WARP-1286 follow-up: reconcileFrigateCameras() now invalidates cameras:list,
  // so the manual-add path (which reconciles) calls this — mock it or the call
  // resolves to undefined and the add 500s.
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

type Row = Record<string, unknown>;

function makeDb() {
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
  const prisma: Record<string, unknown> = { camera: table.delegate };
  const seam = createTransactionSeam({ client: () => prisma, stores: { cameras: table.rows } });
  prisma.$transaction = seam.$transaction;
  return { table, prisma };
}
type Db = ReturnType<typeof makeDb>;

function makeApp(db: Db) {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter(db.prisma as never));
  return app;
}

const rows = (db: Db) => db.table.rows as Row[];
const URL_OK = "rtsp://192.168.100.50/stream";

beforeEach(() => {
  vi.clearAllMocks();
  addCamera.mockResolvedValue(true);
  syncCamerasFromDb.mockResolvedValue([]);
  waitForCameraStreaming.mockResolvedValue({ streaming: true, fps: 5 });
  configLock.mockImplementation((section: () => Promise<unknown>) => section());
});

describe("POST /api/cameras — manual add reconciles Frigate config (#11)", () => {
  it("runs the best-effort reconcile after a successful add, same as accept/reject/delete", async () => {
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", camera: "front_door" });
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
    // The reconcile reads the DB itself, inside Frigate's config lock: it is
    // handed a reader, not a list taken before the lock.
    const reader = syncCamerasFromDb.mock.calls[0][0] as () => Promise<unknown>;
    expect(typeof reader).toBe("function");
    expect(await reader()).toEqual({ names: ["front_door"], adopted: ["front_door"] });
  });

  it("still succeeds when the reconcile fails (best-effort — a Frigate hiccup must not fail the add)", async () => {
    syncCamerasFromDb.mockRejectedValue(new Error("frigate down"));
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("does not reconcile, write a row or verify when Frigate refuses the add (nothing changed)", async () => {
    addCamera.mockResolvedValue(false);
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(500);
    expect(syncCamerasFromDb).not.toHaveBeenCalled();
    expect(waitForCameraStreaming).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("POST /api/cameras — one canonical key (WARP-3506)", () => {
  it.each([
    ["Warp_Lab_Office", "warp_lab_office", "Warp Lab Office"],
    ["Front-Door", "front_door", "Front-Door"],
    ["front_door", "front_door", "Front Door"],
  ])("files %s as the key %s and keeps %s as the label", async (typed, key, label) => {
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: typed, rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", camera: key });
    // Frigate and the DB agree on the one key…
    expect(addCamera).toHaveBeenCalledWith(key, URL_OK);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ name: key, displayName: label, adoption: "ADOPTED", enabled: true });
    // …so the reconcile that follows sees no orphan, and verification looks
    // for the camera under that key.
    expect(waitForCameraStreaming).toHaveBeenCalledWith(key);
  });

  it("rejects a name with no usable key before any Frigate write", async () => {
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "---", rtspUrl: URL_OK });

    expect(res.status).toBe(400);
    expect(addCamera).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("POST /api/cameras — links the discovered device (WARP-3510)", () => {
  it("adopts the discovery placeholder for the same IP in place, not a duplicate", async () => {
    const db = makeDb();
    const placeholder = db.table.seed({
      name: "camera_192_168_100_50",
      displayName: "Camera 192 168 100 50",
      ipAddress: "192.168.100.50",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      autoDiscovered: true,
      adoption: "CANDIDATE",
    });

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "Warp_Lab_Office", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({
      id: placeholder.id,
      name: "warp_lab_office",
      adoption: "ADOPTED",
      enabled: true,
      macAddress: "e4:30:22:50:2a:fd", // what discovery learned is kept
    });
  });

  it("finds the placeholder by the MAC the request carries", async () => {
    const db = makeDb();
    const placeholder = db.table.seed({
      name: "xnv_c8083r",
      ipAddress: "192.168.100.77",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      autoDiscovered: true,
      adoption: "CANDIDATE",
    });

    const res = await request(makeApp(db))
      .post("/api/cameras")
      .send({ name: "office", rtspUrl: URL_OK, macAddress: "E4:30:22:50:2A:FD" });

    expect(res.status).toBe(200);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ id: placeholder.id, name: "office", ipAddress: "192.168.100.50" });
  });

  it("rejects a macAddress that is not a MAC", async () => {
    const db = makeDb();

    const res = await request(makeApp(db))
      .post("/api/cameras")
      .send({ name: "office", rtspUrl: URL_OK, macAddress: "not-a-mac" });

    expect(res.status).toBe(400);
    expect(addCamera).not.toHaveBeenCalled();
  });

  it("holds Frigate's config lock across the Frigate write AND the DB write, and releases it before verifying", async () => {
    // A reconcile that took the lock between the two would snapshot a DB that
    // does not yet name the camera Frigate already holds, and prune it.
    let locked = false;
    const order: string[] = [];
    configLock.mockImplementation(async (section: () => Promise<unknown>) => {
      locked = true;
      try {
        return await section();
      } finally {
        locked = false;
      }
    });
    addCamera.mockImplementation(async () => {
      order.push(locked ? "frigate:locked" : "frigate:UNLOCKED");
      return true;
    });
    const db = makeDb();
    const realCreate = db.table.delegate.create.getMockImplementation()!;
    db.table.delegate.create.mockImplementation(async (args) => {
      order.push(locked ? "db:locked" : "db:UNLOCKED");
      return realCreate(args);
    });
    syncCamerasFromDb.mockImplementation(async () => {
      order.push(locked ? "reconcile:LOCKED" : "reconcile:free");
      return [];
    });
    waitForCameraStreaming.mockImplementation(async () => {
      order.push(locked ? "verify:LOCKED" : "verify:free");
      return { streaming: true, fps: 5 };
    });

    await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(order).toEqual(["frigate:locked", "db:locked", "reconcile:free", "verify:free"]);
  });
});

describe("POST /api/cameras — verifies the camera before saying ok (WARP-3506)", () => {
  it("answers ok only after the camera is streaming", async () => {
    const db = makeDb();
    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", camera: "front_door" });
    expect(waitForCameraStreaming).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no_frames", /address|password/i],
    ["not_started", /did not start/i],
    ["frigate_unreachable", /not responding|unreachable|reach/i],
  ])("answers a distinct, non-error 202 when the camera never streams (%s)", async (reason, message) => {
    waitForCameraStreaming.mockResolvedValue({ streaming: false, reason });
    const db = makeDb();

    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "added_no_stream", camera: "front_door", code: reason });
    expect(res.body.reason).toMatch(message);
    // The camera IS added — the operator can see it and fix the address — so
    // the row exists and the reconcile ran.
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ name: "front_door", adoption: "ADOPTED" });
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
  });
});

// WARP-3193 SEC-INJ-5 — Frigate expands `{FRIGATE_*}` placeholders in the
// URL it is given, so `rtsp://evil/{FRIGATE_CAMERA_X_PASSWORD}` would send a
// camera password to any host. Validation must also finish BEFORE the Frigate
// write: the old code parsed the host only after addCamera(), so a URL the
// parser rejects left Frigate configured and the DB without the row.
describe("POST /api/cameras — rtspUrl validation (SEC-INJ-5)", () => {
  it.each([
    "rtsp://evil.example/{FRIGATE_CAMERA_X_PASSWORD}",
    "rtsp://evil.example/}",
    "rtsp://cam.local/stream 1",
    "rtsp://cam.local/\tstream",
    "http://192.168.1.5/stream",
    "rtsp://[::1",
    "rtsp:///stream",
  ])("rejects %s with 400 before any Frigate write", async (rtspUrl) => {
    const db = makeDb();
    const res = await request(makeApp(db)).post("/api/cameras").send({ name: "cam", rtspUrl });
    expect(res.status).toBe(400);
    expect(addCamera).not.toHaveBeenCalled();
    expect(rows(db)).toHaveLength(0);
  });

  it("accepts credentials, a port and rtsps", async () => {
    const db = makeDb();
    const res = await request(makeApp(db))
      .post("/api/cameras")
      .send({ name: "cam", rtspUrl: "rtsps://admin:s3cret%21@192.168.100.50:322/stream1" });
    expect(res.status).toBe(200);
    expect(rows(db)[0]).toMatchObject({ ipAddress: "192.168.100.50" });
  });
});

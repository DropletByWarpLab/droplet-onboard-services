/**
 * 2026-06-09 sweep — POST /api/cameras (manual add) must run the same
 * best-effort Frigate reconcile (#11) as accept/reject/delete.
 *
 * Without it, an operator who only ever adds cameras manually keeps stale
 * orphaned Frigate config entries (e.g. camera_192_168_20_176 left behind by
 * a prior version / Postgres wipe) forever — the prune only ran on the
 * discovery accept/reject and delete paths.
 *
 * Focused harness: supertest + a pass-through role gate; every service module
 * cameras.ts imports is mocked, and only the manual-add path is driven.
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
  addCamera: (...a: unknown[]) => addCamera(...a),
  syncCamerasFromDb: (...a: unknown[]) => syncCamerasFromDb(...a),
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

function makePrisma() {
  return {
    camera: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([{ name: "front_door" }]),
    },
  };
}

function makeApp(prisma: ReturnType<typeof makePrisma>) {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter(prisma as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/cameras — manual add reconciles Frigate config (#11)", () => {
  it("runs the best-effort reconcile after a successful add, same as accept/reject/delete", async () => {
    addCamera.mockResolvedValue(true);
    syncCamerasFromDb.mockResolvedValue([]);
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post("/api/cameras")
      .send({ name: "front_door", rtspUrl: "rtsp://192.168.100.50/stream" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", camera: "front_door" });
    expect(prisma.camera.upsert).toHaveBeenCalledTimes(1);
    // The reconcile pruned against the full DB camera set.
    expect(syncCamerasFromDb).toHaveBeenCalledTimes(1);
    expect(syncCamerasFromDb).toHaveBeenCalledWith(["front_door"]);
  });

  it("still succeeds when the reconcile fails (best-effort — a Frigate hiccup must not fail the add)", async () => {
    addCamera.mockResolvedValue(true);
    syncCamerasFromDb.mockRejectedValue(new Error("frigate down"));
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post("/api/cameras")
      .send({ name: "front_door", rtspUrl: "rtsp://192.168.100.50/stream" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok" });
  });

  it("does not reconcile when Frigate refuses the add (nothing changed)", async () => {
    addCamera.mockResolvedValue(false);
    const prisma = makePrisma();

    const res = await request(makeApp(prisma))
      .post("/api/cameras")
      .send({ name: "front_door", rtspUrl: "rtsp://192.168.100.50/stream" });

    expect(res.status).toBe(500);
    expect(syncCamerasFromDb).not.toHaveBeenCalled();
  });
});

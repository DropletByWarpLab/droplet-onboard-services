/**
 * WARP-3511 - the retention repair's dry run says WHAT it would apply, not only
 * to whom.
 *
 * The dashboard's "Fix" asks the person to confirm before the camera service
 * restarts, and "start saving footage" without saying for how long is not a
 * decision anyone can make. The windows are the repair's own effective
 * defaults, which are configurable per box and are changing (WARP-3514), so
 * they are read from the same function the POST applies, never written into
 * copy. These tests compare against that function rather than a number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const h = vi.hoisted(() => ({
  planRetentionBackfill: vi.fn(),
  backfillCameraRetention: vi.fn(),
  getCameras: vi.fn(),
  getRecentEvents: vi.fn(),
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
  fetchPtzCapabilities: vi.fn(),
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
  invalidateCamerasCache: vi.fn(),
  cameraUpdateMany: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: { SERVICE_SECRET: "", FRIGATE_URL: "http://frigate.test:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

vi.mock("../services/camera.service.js", () => ({
  getCameras: (...a: unknown[]) => h.getCameras(...a),
  getEventsFiltered: vi.fn(),
  getRecentEvents: (...a: unknown[]) => h.getRecentEvents(...a),
  getRecordings: vi.fn(),
  getRecordingsSummary: vi.fn(),
  getReviewsFiltered: vi.fn(),
  getStats: vi.fn(),
  getTimelineEntries: vi.fn(),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
  invalidateCamerasCache: (...a: unknown[]) => h.invalidateCamerasCache(...a),
  isInitialized: vi.fn().mockReturnValue(true),
}));

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
  addCamera: vi.fn(),
  syncCamerasFromDb: vi.fn(),
  fetchEvents: vi.fn(),
  buildRecordingClipUrl: vi.fn(),
  buildVodMasterUrl: vi.fn(),
  buildVodSegmentUrl: vi.fn(),
  fetchHlsPlaylist: vi.fn(),
  fetchPtzCapabilities: (...a: unknown[]) => h.fetchPtzCapabilities(...a),
  ptzGoToPreset: vi.fn(),
  ptzMove: vi.fn(),
  restartFrigate: vi.fn(),
}));

vi.mock("../services/camera-system.service.js", () => ({ getCameraSystemStatus: vi.fn() }));
vi.mock("../services/camera-retention-backfill.service.js", () => ({
  planRetentionBackfill: (...a: unknown[]) => h.planRetentionBackfill(...a),
  backfillCameraRetention: (...a: unknown[]) => h.backfillCameraRetention(...a),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: (...a: unknown[]) => h.evaluateNetworkCommand(...a),
  confirmNetworkCommand: (...a: unknown[]) => h.confirmNetworkCommand(...a),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn(),
  signShareUrl: vi.fn(),
  verifyShareUrl: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn() }));
vi.mock("../services/nextcloud.client.js", () => ({ ncDownloadFile: vi.fn() }));
vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: vi.fn(),
  isValidGroupName: vi.fn(),
  isValidGroupIcon: vi.fn(),
}));
vi.mock("../services/camera-pins.service.js", () => ({}));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: (...a: unknown[]) => h.getCameraSettings(...a),
  updateCameraSettings: (...a: unknown[]) => h.updateCameraSettings(...a),
}));

import { createCamerasRouter } from "./cameras.js";
import { resolveRetentionDefaults } from "../services/camera-retention-defaults.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "owner-1", role: "owner" };
    next();
  });
  app.use("/api", createCamerasRouter({} as never));
  return app;
}

const PLAN = [
  { camera: "front_door", reason: "no_retention_authored", willWrite: true },
  { camera: "garage", reason: "already_authored", willWrite: false },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/cameras/retention/backfill", () => {
  it("returns the plan and the windows the repair would write", async () => {
    h.planRetentionBackfill.mockResolvedValue(PLAN);
    const res = await request(makeApp()).get("/api/cameras/retention/backfill");
    expect(res.status).toBe(200);
    expect(res.body.plan).toEqual(PLAN);
    expect(res.body.defaults).toEqual({
      continuousDays: resolveRetentionDefaults().continuousDays,
      motionDays: resolveRetentionDefaults().motionDays,
      alertsRetainDays: resolveRetentionDefaults().alertsRetainDays,
      detectionsRetainDays: resolveRetentionDefaults().detectionsRetainDays,
    });
  });

  it("follows the box's own configuration, not a built-in number", async () => {
    h.planRetentionBackfill.mockResolvedValue(PLAN);
    const saved = {
      c: process.env.NVR_DEFAULT_CONTINUOUS_DAYS,
      m: process.env.NVR_DEFAULT_MOTION_DAYS,
    };
    process.env.NVR_DEFAULT_CONTINUOUS_DAYS = "13";
    process.env.NVR_DEFAULT_MOTION_DAYS = "17";
    try {
      const res = await request(makeApp()).get("/api/cameras/retention/backfill");
      expect(res.body.defaults.continuousDays).toBe(13);
      expect(res.body.defaults.motionDays).toBe(17);
    } finally {
      if (saved.c === undefined) delete process.env.NVR_DEFAULT_CONTINUOUS_DAYS;
      else process.env.NVR_DEFAULT_CONTINUOUS_DAYS = saved.c;
      if (saved.m === undefined) delete process.env.NVR_DEFAULT_MOTION_DAYS;
      else process.env.NVR_DEFAULT_MOTION_DAYS = saved.m;
    }
  });

  it("reports only the four windows a person would read, not capture padding or snapshots", async () => {
    h.planRetentionBackfill.mockResolvedValue(PLAN);
    const res = await request(makeApp()).get("/api/cameras/retention/backfill");
    expect(Object.keys(res.body.defaults).sort()).toEqual([
      "alertsRetainDays",
      "continuousDays",
      "detectionsRetainDays",
      "motionDays",
    ]);
  });

  it("a Frigate outage is the same 503 degraded answer, not a 500", async () => {
    const down = new Error("fetch failed");
    (down as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    h.planRetentionBackfill.mockRejectedValue(down);
    const res = await request(makeApp()).get("/api/cameras/retention/backfill");
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  });

  it("any other failure is still an error", async () => {
    h.planRetentionBackfill.mockRejectedValue(new Error("Frigate config raw: 403"));
    const res = await request(makeApp()).get("/api/cameras/retention/backfill");
    expect(res.status).toBe(500);
  });
});

describe("POST /api/cameras/retention/backfill", () => {
  it("applies the repair and returns what it wrote", async () => {
    h.backfillCameraRetention.mockResolvedValue({ planned: PLAN, written: ["front_door"], noop: false });
    const res = await request(makeApp()).post("/api/cameras/retention/backfill");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ planned: PLAN, written: ["front_door"], noop: false });
    expect(h.invalidateCamerasCache).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate a healthy list when there was nothing to repair", async () => {
    h.backfillCameraRetention.mockResolvedValue({ planned: PLAN, written: [], noop: true });
    const res = await request(makeApp()).post("/api/cameras/retention/backfill");
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });

  it("a Frigate outage is the same 503 degraded answer, not a 500", async () => {
    const down = new Error("fetch failed");
    (down as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    h.backfillCameraRetention.mockRejectedValue(down);
    const res = await request(makeApp()).post("/api/cameras/retention/backfill");
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });

  it("a refusal by the camera service stays a real error, with its reason", async () => {
    h.backfillCameraRetention.mockRejectedValue(new Error("Frigate rejected the retention backfill (400): bad key"));
    const res = await request(makeApp()).post("/api/cameras/retention/backfill");
    expect(res.status).toBe(500);
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });
});

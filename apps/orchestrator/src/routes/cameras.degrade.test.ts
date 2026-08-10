/**
 * Degrade-on-outage regression — when Frigate is unreachable, the
 * dashboard-polled camera GETs must serve their empty shape (200) rather
 * than letting the client error bubble to an unhandled 500. Mirrors the
 * models-summary.service.ts precedent (empty payload on dependency down).
 *
 * Covers the four read surfaces the SWR poll hits:
 *   GET /api/cameras/system        → { status: <empty system status> }
 *   GET /api/cameras/events        → { events: [], nextCursor: null }
 *   GET /api/cameras/reviews       → { reviews: [], nextCursor: null }
 *   GET /api/cameras/events/recent → { events: [] }
 *
 * Plus a guard: a NON-connectivity error (a Frigate 403) is a real failure
 * and must still surface (500 via the default handler), never be masked as
 * an empty 200.
 *
 * Focused harness — same shape as cameras.manual-add-reconcile.test.ts:
 * supertest + pass-through role gate; every service cameras.ts imports is
 * mocked so only the read paths are driven.
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

const getEventsFiltered = vi.fn();
const getReviewsFiltered = vi.fn();
const getRecentEvents = vi.fn();
vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(),
  getEventsFiltered: (...a: unknown[]) => getEventsFiltered(...a),
  getRecentEvents: (...a: unknown[]) => getRecentEvents(...a),
  getRecordings: vi.fn(),
  getRecordingsSummary: vi.fn(),
  getReviewsFiltered: (...a: unknown[]) => getReviewsFiltered(...a),
  getStats: vi.fn(),
  getTimelineEntries: vi.fn(),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
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
  enableDetection: vi.fn(),
  disableDetection: vi.fn(),
  deleteCamera: vi.fn(),
  addCamera: vi.fn(),
  syncCamerasFromDb: vi.fn(),
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

const getCameraSystemStatus = vi.fn();
vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: (...a: unknown[]) => getCameraSystemStatus(...a),
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter({} as never));
  return app;
}

/** An undici "fetch failed" with the socket cause Frigate-down produces. */
function frigateDown(): Error {
  const e = new Error("fetch failed");
  (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Camera read endpoints degrade to empty when Frigate is unreachable", () => {
  it("GET /api/cameras/system → 200 with an empty system status", async () => {
    getCameraSystemStatus.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/system");
    expect(res.status).toBe(200);
    expect(res.body.status).toMatchObject({
      version: "unknown",
      cameraCount: 0,
      camerasLive: 0,
      cameraFps: [],
      detectors: [],
      gpus: [],
      storage: [],
    });
  });

  it("GET /api/cameras/events → 200 { events: [], nextCursor: null } on a 5xx upstream", async () => {
    getEventsFiltered.mockRejectedValue(new Error("Frigate events: 502"));
    const res = await request(makeApp()).get("/api/cameras/events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], nextCursor: null });
  });

  it("GET /api/cameras/reviews → 200 { reviews: [], nextCursor: null } when Frigate is unreachable", async () => {
    getReviewsFiltered.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/reviews");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reviews: [], nextCursor: null });
  });

  it("GET /api/cameras/events/recent → 200 { events: [] } when Frigate is unreachable", async () => {
    getRecentEvents.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/events/recent");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });

  it("does NOT degrade a real Frigate error — a 403 still surfaces (500), not a 200 empty list", async () => {
    getEventsFiltered.mockRejectedValue(new Error("Frigate events: 403"));
    const res = await request(makeApp()).get("/api/cameras/events");
    expect(res.status).toBe(500);
    expect(res.body).not.toEqual({ events: [], nextCursor: null });
  });
});

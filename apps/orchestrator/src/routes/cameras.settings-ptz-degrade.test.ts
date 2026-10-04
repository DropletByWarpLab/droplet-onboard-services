/**
 * WARP-3511 — the per-camera reads the dashboard polls (`/settings`, `/ptz`)
 * and the writes that go through Frigate's config answer a Frigate outage the
 * WARP-3105 way: the `X-Droplet-Degraded: frigate-unavailable` marker, never an
 * unhandled 500 the SWR poll retries forever.
 *
 * Two of them have no honest "empty" answer, so they differ from the event
 * lists in cameras.degrade.test.ts:
 *
 *   /settings  503. An empty form served as a 200 would be saved straight back
 *              over the camera's real configuration.
 *   /ptz       200 `{ supported: false }`. A camera whose PTZ probe fails has
 *              no PTZ controls to show; that is a normal answer, not an error.
 *
 * Same focused harness as cameras.degrade.test.ts: supertest, pass-through
 * role gate, every service cameras.ts imports mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const h = vi.hoisted(() => ({
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

function makeApp() {
  const app = express();
  app.use(express.json());
  // The per-camera access guard resolves a scope from the caller's role.
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "owner-1", role: "owner" };
    next();
  });
  app.use("/api", createCamerasRouter({ camera: { updateMany: h.cameraUpdateMany } } as never));
  return app;
}

/** An undici "fetch failed" with the socket cause Frigate-down produces. */
function frigateDown(): Error {
  const e = new Error("fetch failed");
  (e as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  return e;
}

const SETTINGS = { detectEnabled: true, detectFps: 5, recordEnabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.evaluateNetworkCommand.mockResolvedValue({ requiresConfirmation: false });
  h.cameraUpdateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/cameras/:name/settings", () => {
  it("serves the settings when Frigate answers", async () => {
    h.getCameraSettings.mockResolvedValue(SETTINGS);
    const res = await request(makeApp()).get("/api/cameras/front_door/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settings: SETTINGS });
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
  });

  it("503 with the degraded marker when Frigate is unreachable — not a 500", async () => {
    h.getCameraSettings.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/front_door/settings");
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    expect(res.body).toMatchObject({ error: "frigate_unavailable", degraded: true });
    expect(typeof res.body.message).toBe("string");
  });

  it("503 as well when Frigate answers 5xx (it is mid-restart after a save)", async () => {
    h.getCameraSettings.mockRejectedValue(new Error("Frigate config: 502"));
    const res = await request(makeApp()).get("/api/cameras/front_door/settings");
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  });

  it("never serves an empty settings object for an outage", async () => {
    h.getCameraSettings.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/front_door/settings");
    expect(res.body.settings).toBeUndefined();
  });

  it("an unknown camera is still a 404, not a degrade", async () => {
    h.getCameraSettings.mockRejectedValue(new Error("camera ghost not found"));
    const res = await request(makeApp()).get("/api/cameras/ghost/settings");
    expect(res.status).toBe(404);
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
  });

  it("a real Frigate refusal (403) is not masked as an outage", async () => {
    h.getCameraSettings.mockRejectedValue(new Error("Frigate config: 403"));
    const res = await request(makeApp()).get("/api/cameras/front_door/settings");
    expect(res.status).toBe(500);
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
  });
});

describe("PATCH /api/cameras/:name/settings", () => {
  it("503 with the degraded marker when Frigate is unreachable", async () => {
    h.updateCameraSettings.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).patch("/api/cameras/front_door/settings").send({ detectFps: 5 });
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  });

  it("a rejected value is still a 400 the form can show inline", async () => {
    h.updateCameraSettings.mockRejectedValue(new Error("detectFps must be between 1 and 30"));
    const res = await request(makeApp()).patch("/api/cameras/front_door/settings").send({ detectFps: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 30/);
  });
});

describe("GET /api/cameras/:name/ptz", () => {
  const NO_PTZ = { supported: false, supportsPanTilt: false, supportsZoom: false, presets: [] };

  it("passes a PTZ camera's capabilities through", async () => {
    h.fetchPtzCapabilities.mockResolvedValue({
      supported: true,
      supportsPanTilt: true,
      supportsZoom: true,
      presets: ["door"],
    });
    const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ supported: true, supportsPanTilt: true, presets: ["door"] });
  });

  it("a camera with no PTZ answers supported:false", async () => {
    h.fetchPtzCapabilities.mockResolvedValue(NO_PTZ);
    const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(NO_PTZ);
  });

  it("a Frigate 500 on the probe is 'no PTZ' — the live failure that logged 'PTZ info: 500'", async () => {
    h.fetchPtzCapabilities.mockRejectedValue(new Error("PTZ info: 500"));
    const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(NO_PTZ);
  });

  it("an unreachable Frigate is also 'no PTZ', marked degraded so a client can tell it from a real no", async () => {
    h.fetchPtzCapabilities.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...NO_PTZ, degraded: true });
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  });

  it("a gateway-class error on the probe is 'unknown', not a permanent 'no PTZ'", async () => {
    // Frigate answering 502/503/504 is the service being sick, not this camera
    // lacking PTZ: marking it degraded gets it asked again, instead of the
    // dashboard caching "no PTZ" for a camera that has it.
    for (const status of [502, 503, 504]) {
      h.fetchPtzCapabilities.mockRejectedValue(new Error(`PTZ info: ${status}`));
      const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ...NO_PTZ, degraded: true });
      expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    }
  });

  it("a plain 'no PTZ' is NOT marked degraded", async () => {
    h.fetchPtzCapabilities.mockResolvedValue(NO_PTZ);
    const res = await request(makeApp()).get("/api/cameras/front_door/ptz");
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
    expect(res.body.degraded).toBeUndefined();
  });

  it("still rejects a malformed camera name", async () => {
    const res = await request(makeApp()).get("/api/cameras/bad name/ptz");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cameras/:name/enable — detection is a persisted setting", () => {
  it("writes detect.enabled through the settings path and records the camera as enabled", async () => {
    h.updateCameraSettings.mockResolvedValue(SETTINGS);
    const res = await request(makeApp()).post("/api/cameras/front_door/enable");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "enabled", camera: "front_door" });
    expect(h.updateCameraSettings).toHaveBeenCalledWith("front_door", { detectEnabled: true });
    expect(h.cameraUpdateMany).toHaveBeenCalledWith({ where: { name: "front_door" }, data: { enabled: true } });
    expect(h.invalidateCamerasCache).toHaveBeenCalled();
  });

  it("leaves the camera's enabled flag alone when the config write fails", async () => {
    h.updateCameraSettings.mockRejectedValue(new Error("Frigate rejected the config: 400"));
    const res = await request(makeApp()).post("/api/cameras/front_door/enable");
    expect(res.status).toBe(500);
    expect(h.cameraUpdateMany).not.toHaveBeenCalled();
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });

  it("503 with the degraded marker when Frigate is unreachable", async () => {
    h.updateCameraSettings.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).post("/api/cameras/front_door/enable");
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    expect(h.cameraUpdateMany).not.toHaveBeenCalled();
  });

  it("an unknown camera is a 404", async () => {
    h.updateCameraSettings.mockRejectedValue(new Error("camera ghost not found"));
    const res = await request(makeApp()).post("/api/cameras/ghost/enable");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/cameras — an unreadable Frigate is said, not rendered as 'all offline'", () => {
  const cam = (name: string, degraded: boolean) => ({
    name,
    displayName: name,
    status: "offline",
    recording: { degraded, mode: degraded ? null : "continuous" },
  });

  it("carries the degraded marker and flag when the cameras could not be read", async () => {
    h.getCameras.mockResolvedValue([cam("a", true), cam("b", true)]);
    const res = await request(makeApp()).get("/api/cameras");
    expect(res.status).toBe(200);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    expect(res.body.degraded).toBe(true);
    expect(res.body.cameras).toHaveLength(2);
  });

  it("a healthy list has neither", async () => {
    h.getCameras.mockResolvedValue([cam("a", false)]);
    const res = await request(makeApp()).get("/api/cameras");
    expect(res.status).toBe(200);
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
    expect(res.body.degraded).toBeUndefined();
  });

  it("no cameras at all is not a degraded list", async () => {
    h.getCameras.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/cameras");
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
  });
});

describe("GET /api/cameras/:name — recent events must not turn an outage into a 500", () => {
  it("serves the camera with no events and the degraded marker when Frigate is down", async () => {
    h.getCameras.mockResolvedValue([
      { name: "front_door", displayName: "Front door", status: "offline", recording: { degraded: true, mode: null } },
    ]);
    h.getRecentEvents.mockRejectedValue(frigateDown());
    const res = await request(makeApp()).get("/api/cameras/front_door");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "front_door", recentEvents: [] });
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  });

  it("a healthy camera has the events and no marker", async () => {
    h.getCameras.mockResolvedValue([
      { name: "front_door", displayName: "Front door", status: "recording", recording: { degraded: false, mode: "continuous" } },
    ]);
    h.getRecentEvents.mockResolvedValue([{ id: "e1" }]);
    const res = await request(makeApp()).get("/api/cameras/front_door");
    expect(res.status).toBe(200);
    expect(res.body.recentEvents).toEqual([{ id: "e1" }]);
    expect(res.headers["x-droplet-degraded"]).toBeUndefined();
  });

  it("a real events error is not masked", async () => {
    h.getCameras.mockResolvedValue([
      { name: "front_door", displayName: "Front door", status: "recording", recording: { degraded: false, mode: "continuous" } },
    ]);
    h.getRecentEvents.mockRejectedValue(new Error("Frigate events: 403"));
    const res = await request(makeApp()).get("/api/cameras/front_door");
    expect(res.status).toBe(500);
  });

  it("an unknown camera is still a 404", async () => {
    h.getCameras.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/cameras/ghost");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/cameras/command/confirm — the confirmed disable is the production path", () => {
  const confirmDisable = () => {
    h.confirmNetworkCommand.mockResolvedValue({
      confirmed: true,
      operation: "disable_camera",
      params: { name: "front_door" },
    });
    return request(makeApp())
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok", operation: "disable_camera" });
  };

  it("writes the persisted detect.enabled setting and records the camera as disabled", async () => {
    h.updateCameraSettings.mockResolvedValue(SETTINGS);
    const res = await confirmDisable();
    expect(res.status).toBe(200);
    expect(h.updateCameraSettings).toHaveBeenCalledWith("front_door", { detectEnabled: false });
    expect(h.cameraUpdateMany).toHaveBeenCalledWith({ where: { name: "front_door" }, data: { enabled: false } });
  });

  it("503 with the degraded marker when Frigate is unreachable — not a 500", async () => {
    h.updateCameraSettings.mockRejectedValue(frigateDown());
    const res = await confirmDisable();
    expect(res.status).toBe(503);
    expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    expect(h.cameraUpdateMany).not.toHaveBeenCalled();
  });

  it("an unknown camera is a 404", async () => {
    h.updateCameraSettings.mockRejectedValue(new Error("camera front_door not found"));
    const res = await confirmDisable();
    expect(res.status).toBe(404);
    expect(h.cameraUpdateMany).not.toHaveBeenCalled();
  });

  it("a real failure is still an error, not masked as an outage", async () => {
    h.updateCameraSettings.mockRejectedValue(new Error("Frigate rejected the config: 400"));
    const res = await confirmDisable();
    expect(res.status).toBe(500);
    expect(h.cameraUpdateMany).not.toHaveBeenCalled();
  });
});

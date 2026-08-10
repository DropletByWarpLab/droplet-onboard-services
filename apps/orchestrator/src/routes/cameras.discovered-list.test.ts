/**
 * WARP-1847 — the routes behind the operator's "what's on my network" list.
 *
 * Three route-level contracts, each of which was broken before:
 *   GET  /api/cameras/discovered      → an envelope with the merged candidate
 *        list + `discoveryOnline`, so "nothing found" and "the scanner isn't
 *        running" are distinguishable instead of both rendering as an empty list.
 *   POST /api/cameras/scan            → returns what the scan found, not only
 *        `{ known, pending }` counts the caller had no way to act on.
 *   POST /api/cameras/discovered/:id/{accept,reject}
 *        → a `mac:` id addresses a live camera-discovery record (only that
 *        service holds the probed RTSP URL and verifies the stream); a uuid
 *        still takes the legacy Prisma path. A rejected live camera must also
 *        lose its DB row, or the fallback list resurrects it.
 *
 * Focused harness, same shape as cameras.manual-add-reconcile.test.ts.
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

const getCameraCandidates = vi.fn();
const mutateLiveCandidate = vi.fn();
vi.mock("../services/camera-candidates.service.js", async () => {
  // macFromCandidateId is pure id parsing — the routes' dispatch logic is what's
  // under test, so keep the real implementation and fake only the I/O.
  const actual = await vi.importActual<
    typeof import("../services/camera-candidates.service.js")
  >("../services/camera-candidates.service.js");
  return {
    ...actual,
    getCameraCandidates: (...a: unknown[]) => getCameraCandidates(...a),
    mutateLiveCandidate: (...a: unknown[]) => mutateLiveCandidate(...a),
  };
});

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

const HANWHA_ID = "mac:E4:30:22:50:2A:FD";

function makePrisma() {
  return {
    camera: {
      findMany: vi.fn().mockResolvedValue([{ name: "front_door" }]),
      update: vi.fn().mockResolvedValue({ name: "old_cam" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
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
  syncCamerasFromDb.mockResolvedValue([]);
});

describe("GET /api/cameras/discovered", () => {
  it("returns the candidate list in an envelope with discoveryOnline", async () => {
    getCameraCandidates.mockResolvedValue({
      candidates: [{ id: HANWHA_ID, name: "XNV_C8083R", status: "ready" }],
      discoveryOnline: true,
    });

    const res = await request(makeApp(makePrisma())).get("/api/cameras/discovered");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cameras: [{ id: HANWHA_ID, name: "XNV_C8083R", status: "ready" }],
      discoveryOnline: true,
    });
  });

  it("reports discoveryOnline false so an empty list can be explained", async () => {
    getCameraCandidates.mockResolvedValue({ candidates: [], discoveryOnline: false });

    const res = await request(makeApp(makePrisma())).get("/api/cameras/discovered");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cameras: [], discoveryOnline: false });
  });
});

describe("POST /api/cameras/scan", () => {
  it("returns the candidates the scan found alongside the counts", async () => {
    internalFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 0, pending: 1 }), {
        status: 200,
      }),
    );
    getCameraCandidates.mockResolvedValue({
      candidates: [{ id: HANWHA_ID, status: "needs_credentials" }],
      discoveryOnline: true,
    });

    const res = await request(makeApp(makePrisma())).post("/api/cameras/scan");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "scan_complete",
      known: 0,
      pending: 1,
      cameras: [{ id: HANWHA_ID, status: "needs_credentials" }],
    });
  });

  it("still reports a successful scan when the candidate read fails", async () => {
    internalFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 1, pending: 0 }), {
        status: 200,
      }),
    );
    getCameraCandidates.mockRejectedValue(new Error("boom"));

    const res = await request(makeApp(makePrisma())).post("/api/cameras/scan");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "scan_complete", cameras: [] });
  });

  it("carries an empty list on the scan_unavailable envelope", async () => {
    internalFetch.mockRejectedValue(new Error("fetch failed"));

    const res = await request(makeApp(makePrisma())).post("/api/cameras/scan");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "scan_unavailable", cameras: [] });
    expect(res.body.message).toMatch(/not running/);
  });
});

describe("POST /api/cameras/discovered/:id/accept", () => {
  it("routes a mac: id to camera-discovery and syncs the DB row", async () => {
    mutateLiveCandidate.mockResolvedValue({ ok: true, status: 200 });
    const prisma = makePrisma();

    const res = await request(makeApp(prisma)).post(
      `/api/cameras/discovered/${HANWHA_ID}/accept`,
    );

    expect(res.status).toBe(200);
    expect(mutateLiveCandidate).toHaveBeenCalledWith("E4:30:22:50:2A:FD", "accept");
    // Prisma is never asked to update a row by the synthetic mac: id.
    expect(prisma.camera.update).not.toHaveBeenCalled();
    expect(prisma.camera.updateMany).toHaveBeenCalledWith({
      where: { macAddress: { in: ["E4:30:22:50:2A:FD", "e4:30:22:50:2a:fd"] } },
      data: { enabled: true },
    });
  });

  it("surfaces the upstream 422 prose when the stream does not verify", async () => {
    mutateLiveCandidate.mockResolvedValue({
      ok: false,
      status: 422,
      message: "Camera stream did not verify — the RTSP path or credentials are likely wrong.",
    });

    const res = await request(makeApp(makePrisma())).post(
      `/api/cameras/discovered/${HANWHA_ID}/accept`,
    );

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/did not verify/);
  });

  it("normalises an upstream 5xx to 502", async () => {
    mutateLiveCandidate.mockResolvedValue({ ok: false, status: 500, message: "boom" });

    const res = await request(makeApp(makePrisma())).post(
      `/api/cameras/discovered/${HANWHA_ID}/accept`,
    );

    expect(res.status).toBe(502);
  });

  it("keeps the legacy DB path for a uuid id", async () => {
    const prisma = makePrisma();

    const res = await request(makeApp(prisma)).post("/api/cameras/discovered/db-1/accept");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "accepted", camera: "old_cam" });
    expect(mutateLiveCandidate).not.toHaveBeenCalled();
    expect(prisma.camera.update).toHaveBeenCalledWith({
      where: { id: "db-1" },
      data: { enabled: true },
    });
  });
});

describe("POST /api/cameras/discovered/:id/reject", () => {
  it("rejects upstream AND clears the DB row so the camera cannot reappear", async () => {
    mutateLiveCandidate.mockResolvedValue({ ok: true, status: 200 });
    const prisma = makePrisma();

    const res = await request(makeApp(prisma)).post(
      `/api/cameras/discovered/${HANWHA_ID}/reject`,
    );

    expect(res.status).toBe(200);
    expect(mutateLiveCandidate).toHaveBeenCalledWith("E4:30:22:50:2A:FD", "reject");
    expect(prisma.camera.deleteMany).toHaveBeenCalledWith({
      where: {
        macAddress: { in: ["E4:30:22:50:2A:FD", "e4:30:22:50:2a:fd"] },
        autoDiscovered: true,
        enabled: false,
      },
    });
  });

  it("mirrors a 409 from an accept that is already in flight", async () => {
    mutateLiveCandidate.mockResolvedValue({
      ok: false,
      status: 409,
      message: "Camera accept in progress; cannot reject until it completes.",
    });
    const prisma = makePrisma();

    const res = await request(makeApp(prisma)).post(
      `/api/cameras/discovered/${HANWHA_ID}/reject`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/accept in progress/);
    // A failed rejection must not delete the row.
    expect(prisma.camera.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps the legacy DB path for a uuid id", async () => {
    const prisma = makePrisma();

    const res = await request(makeApp(prisma)).post("/api/cameras/discovered/db-1/reject");

    expect(res.status).toBe(200);
    expect(prisma.camera.delete).toHaveBeenCalledWith({ where: { id: "db-1" } });
  });
});

/**
 * WARP-1851 — HTTP-level tests for the storage-budget endpoints.
 *
 * `camera-budget.service.test.ts` covers the pure controller maths and
 * `reconcileCameraBudgets` against a mocked Prisma. Neither exercises the
 * routes, so RBAC, request validation, the 503-on-Frigate-outage mapping and
 * the response shapes were unpinned by anything CI runs — and the defect that
 * forced the #1499 revert was precisely the kind that unit tests over pure
 * functions cannot see. These drive the real router through supertest.
 *
 * Scaffolding per cameras-mcp-guards.test.ts: real auth guards and the real
 * camera-budget service, heavy I/O (Frigate settings + storage) mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    FRIGATE_URL: "http://frigate.test:5000",
    CAMERA_DISCOVERY_URL: "http://camera-discovery.test:8085",
    ROUTING_SERVICE_URL: "http://routing.test:8080",
    SERVICE_SECRET: "svc",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(), getEventsFiltered: vi.fn(), getRecentEvents: vi.fn(),
  getRecordings: vi.fn(), getRecordingsSummary: vi.fn(), getReviewsFiltered: vi.fn(),
  getStats: vi.fn(), getTimelineEntries: vi.fn(), searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(), setReviewViewed: vi.fn(), subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true), invalidateCamerasCache: vi.fn(),
}));
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(), fetchEventThumbnail: vi.fn(), fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(), fetchFaceImage: vi.fn(), deleteKnownFace: vi.fn(),
  deleteFaceImage: vi.fn(), deleteKnownPlate: vi.fn(), nameKnownPlate: vi.fn(),
  regenerateEventDescription: vi.fn(), tagEventAsFace: vi.fn(), openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(), enableDetection: vi.fn(), disableDetection: vi.fn(),
  deleteCamera: vi.fn(), deleteEvent: vi.fn(), addCamera: vi.fn(),
  syncCamerasFromDb: vi.fn().mockResolvedValue([]),
  fetchEvents: vi.fn(), buildRecordingClipUrl: vi.fn(), buildVodMasterUrl: vi.fn(),
  buildVodSegmentUrl: vi.fn(), fetchHlsPlaylist: vi.fn(), fetchPtzCapabilities: vi.fn(),
  ptzGoToPreset: vi.fn(), ptzMove: vi.fn(), restartFrigate: vi.fn(),
}));
vi.mock("../services/camera-system.service.js", () => ({ getCameraSystemStatus: vi.fn() }));
vi.mock("../services/camera-groups.service.js", () => ({
  isValidGroupName: () => true, isValidGroupIcon: () => true,
  listGroups: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
  addMembers: vi.fn(), removeMember: vi.fn(),
}));
vi.mock("../services/camera-pins.service.js", () => ({
  listPins: vi.fn(), addPin: vi.fn(), reorderPins: vi.fn(), removePin: vi.fn(),
}));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn(), updateCameraSettings: vi.fn(),
}));
vi.mock("../services/camera-storage.service.js", () => ({
  getCameraStorage: vi.fn(), checkStorageNearFull: vi.fn(),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateDirectory: vi.fn(), ncUploadFile: vi.fn(), ncDownloadFile: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nctok"),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(), confirmNetworkCommand: vi.fn(),
}));
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: vi.fn(), internalBaseUrl: (u: string) => u,
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { getCameraSettings } from "../services/camera-settings.service.js";
import { getCameraStorage } from "../services/camera-storage.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mockGetSettings = vi.mocked(getCameraSettings);
const mockGetStorage = vi.mocked(getCameraStorage);

const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const guest: AuthUser = {
  id: "u-guest", username: "guest", displayName: "guest", role: "guest",
};

const GB = 1024 ** 3;

/** Live windows the mocked Frigate reports for every camera. */
const LIVE_SETTINGS = {
  continuousRetainDays: 10,
  motionRetainDays: 0,
  alertsRetainDays: 14,
  detectionsRetainDays: 14,
} as const;

const findUnique = vi.fn();
const update = vi.fn();
const findMany = vi.fn();

const prismaShim = {
  camera: {
    findUnique, update, findMany,
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
} as unknown as PrismaClient;

function buildApp(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prismaShim));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    name: "front", retentionMode: "MANUAL",
    storageBudgetBytes: null, retentionCeiling: null,
  });
  update.mockResolvedValue({});
  // No budgeted cameras by default, so the reconcile pass is a no-op.
  findMany.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ ...LIVE_SETTINGS } as never);
  mockGetStorage.mockResolvedValue({
    volume: { totalBytes: 2000 * GB, usedBytes: 100 * GB },
    cameras: [{ camera: "front", usedBytes: 50 * GB, bytesPerHour: 1e9, sharePercent: 2.5, daysAtCurrentRate: 5 }],
    totalBytesPerHour: 1e9,
  } as never);
});

describe("GET /cameras/:name/budget", () => {
  it("400s an invalid camera name without touching the DB", async () => {
    const res = await request(buildApp(owner)).get("/api/cameras/bad%20name/budget");
    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("404s an unknown camera", async () => {
    findUnique.mockResolvedValue(null);
    const res = await request(buildApp(owner)).get("/api/cameras/nope/budget");
    expect(res.status).toBe(404);
  });

  it("returns the stored allocation so the control is not write-only", async () => {
    findUnique.mockResolvedValue({
      name: "front", retentionMode: "BUDGET",
      storageBudgetBytes: BigInt(500 * GB),
      retentionCeiling: { continuous: 10, motion: 0, alerts: 14, detections: 14 },
    });
    findMany.mockResolvedValue([{ storageBudgetBytes: BigInt(500 * GB) }]);

    const res = await request(buildApp(owner)).get("/api/cameras/front/budget");

    expect(res.status).toBe(200);
    expect(res.body.retentionMode).toBe("BUDGET");
    expect(res.body.budgetBytes).toBe(500 * GB);
    expect(res.body.retentionCeiling).toEqual({
      continuous: 10, motion: 0, alerts: 14, detections: 14,
    });
  });

  it("reports fleet over-allocation — the shared-volume caveat the per-camera number needs", async () => {
    findUnique.mockResolvedValue({
      name: "front", retentionMode: "BUDGET",
      storageBudgetBytes: BigInt(2000 * GB), retentionCeiling: null,
    });
    // 2 TB + 1.5 TB promised against a 2 TB volume.
    findMany.mockResolvedValue([
      { storageBudgetBytes: BigInt(2000 * GB) },
      { storageBudgetBytes: BigInt(1500 * GB) },
    ]);

    const res = await request(buildApp(owner)).get("/api/cameras/front/budget");

    expect(res.status).toBe(200);
    expect(res.body.overAllocation).toEqual({
      allocatedBytes: 3500 * GB,
      capacityBytes: 2000 * GB,
      overAllocated: true,
    });
  });

  it("degrades over-allocation to null when Frigate is down, still answering the read", async () => {
    mockGetStorage.mockRejectedValue(new Error("frigate unreachable"));
    findUnique.mockResolvedValue({
      name: "front", retentionMode: "BUDGET",
      storageBudgetBytes: BigInt(500 * GB), retentionCeiling: null,
    });

    const res = await request(buildApp(owner)).get("/api/cameras/front/budget");

    expect(res.status).toBe(200);
    expect(res.body.budgetBytes).toBe(500 * GB);
    expect(res.body.overAllocation).toBeNull();
  });
});

describe("PATCH /cameras/:name/budget", () => {
  it("403s a guest — setting an allocation is an owner/admin action", async () => {
    const res = await request(buildApp(guest))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: 500 * GB });

    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("400s an invalid camera name", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/cameras/bad%20name/budget")
      .send({ budgetBytes: 500 * GB });
    expect(res.status).toBe(400);
  });

  it("404s an unknown camera", async () => {
    findUnique.mockResolvedValue(null);
    const res = await request(buildApp(owner))
      .patch("/api/cameras/nope/budget")
      .send({ budgetBytes: 500 * GB });
    expect(res.status).toBe(404);
  });

  it("400s a missing budgetBytes — absent is not the same as null", async () => {
    const res = await request(buildApp(owner)).patch("/api/cameras/front/budget").send({});
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  // NaN is deliberately absent: JSON.stringify(NaN) is `null`, so it arrives
  // as an explicit clear-the-budget request and correctly 200s. There is no
  // NaN to reject at this layer.
  it.each([0, -1, "big", true, []])("400s a non-positive budgetBytes (%s)", async (v) => {
    const res = await request(buildApp(owner))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: v });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("503s and stores NOTHING when the ceiling cannot be read from Frigate", async () => {
    mockGetSettings.mockRejectedValue(new Error("frigate unreachable"));

    const res = await request(buildApp(owner))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: 500 * GB });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("camera_service_unavailable");
    // The whole point: a budget with no ceiling is worse than no budget.
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a budget back to MANUAL and says plainly that nothing was deleted", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: null });

    expect(res.status).toBe(200);
    expect(res.body.retentionMode).toBe("MANUAL");
    expect(res.body.budgetBytes).toBeNull();
    expect(res.body.note).toMatch(/deletes nothing/i);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: "front" },
        data: expect.objectContaining({ retentionMode: "MANUAL", storageBudgetBytes: null }),
      }),
    );
  });

  it("stores the budget with the live windows captured as the ceiling", async () => {
    const res = await request(buildApp(owner))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: 500 * GB });

    expect(res.status).toBe(200);
    expect(res.body.retentionMode).toBe("BUDGET");
    expect(res.body.budgetBytes).toBe(500 * GB);
    expect(res.body.retentionCeiling).toEqual({
      continuous: 10, motion: 0, alerts: 14, detections: 14,
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retentionMode: "BUDGET",
          storageBudgetBytes: BigInt(500 * GB),
        }),
      }),
    );
  });

  it("returns 200 with an honest note when the post-commit reconcile fails", async () => {
    // The budget is committed BEFORE the pass runs, so a Frigate drop in that
    // window must not 500 — a 500 reads as "nothing was saved" when it was.
    findMany.mockResolvedValue([
      { name: "front", storageBudgetBytes: BigInt(500 * GB), retentionCeiling: null },
    ]);
    mockGetStorage.mockRejectedValue(new Error("frigate dropped mid-write"));

    const res = await request(buildApp(owner))
      .patch("/api/cameras/front/budget")
      .send({ budgetBytes: 500 * GB });

    expect(res.status).toBe(200);
    expect(res.body.retentionMode).toBe("BUDGET");
    expect(res.body.note).toMatch(/Budget saved, but adjusting retention failed/i);
  });
});

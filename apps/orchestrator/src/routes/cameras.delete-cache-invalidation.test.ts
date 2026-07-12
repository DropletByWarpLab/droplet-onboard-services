/**
 * WARP-1286 — deleting a camera must invalidate the 5s `cameras:list` cache,
 * or a removed camera resurrects on any refetch inside the TTL.
 *
 * `getCameras` caches the merged Frigate+DB list; only the discovery-upsert
 * path invalidated it. `delete_camera` is a Tier-2 network-safety op, so
 * DELETE /cameras/:name returns 202 (confirmation required) and the REAL delete
 * runs in POST /cameras/command/confirm -> case "delete_camera" (WARP-861).
 * That confirm executor deleted from Frigate + DB but left the cache warm, so a
 * GET landing inside the TTL read the deleted row back (reachable via
 * WARP-1282's recovery reload).
 *
 * The suite drives the ACTUAL production path (DELETE 202 -> confirm -> GET),
 * not the direct-delete branch, and models the cache contract with a stateful
 * fake: `getCameras` serves a warm cache if present else rebuilds from the DB
 * and caches; `invalidateCamerasCache()` clears it; `prisma.camera.deleteMany`
 * mutates the DB.
 *
 * Focused harness: supertest + a pass-through role gate + an injected user;
 * every service module cameras.ts imports is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Stateful fake for the cameras:list cache + its DB source of truth. Hoisted so
// the vi.mock factories below can reference it (mocks hoist above imports).
const h = vi.hoisted(() => {
  const state: { db: { name: string }[]; cache: { name: string }[] | null } = {
    db: [],
    cache: null,
  };
  return {
    state,
    // Serve the warm cache if present, else rebuild from the DB and cache it —
    // the real getCameras() contract, minus the Frigate merge we don't exercise.
    getCameras: vi.fn(async () => {
      if (state.cache) return state.cache;
      state.cache = state.db.map((c) => ({ ...c }));
      return state.cache;
    }),
    invalidateCamerasCache: vi.fn(async () => {
      state.cache = null;
    }),
    deleteCamera: vi.fn(async () => {}),
    syncCamerasFromDb: vi.fn(async () => []),
    // delete_camera is Tier-2: evaluate 202s with a token, confirm executes.
    evaluateNetworkCommand: vi.fn(async () => ({
      allowed: false,
      requiresConfirmation: true,
      confirmationToken: "tok-del",
      reason: "Confirm camera removal",
      tier: 2,
    })),
    confirmNetworkCommand: vi.fn(
      async (
        _prisma: unknown,
        _token: unknown,
        _userId: unknown,
        opts: { operation: string }
      ) => ({ confirmed: true, operation: opts.operation, params: { name: "front_door" } })
    ),
  };
});

vi.mock("../config.js", () => ({
  config: { SERVICE_SECRET: "", FRIGATE_URL: "http://frigate.test:5000" },
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
  loadCameraRetentionPolicy: vi
    .fn()
    .mockResolvedValue({ clipDays: 14, eventDays: null }),
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
  deleteCamera: h.deleteCamera,
  addCamera: vi.fn(),
  syncCamerasFromDb: h.syncCamerasFromDb,
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
  getCameras: h.getCameras,
  invalidateCamerasCache: h.invalidateCamerasCache,
  getEventsFiltered: vi.fn(),
  getRecentEvents: vi.fn().mockResolvedValue([]),
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
  evaluateNetworkCommand: h.evaluateNetworkCommand,
  confirmNetworkCommand: h.confirmNetworkCommand,
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
      // The confirm executor removes the row from the DB source of truth.
      deleteMany: vi.fn(async ({ where }: { where: { name: string } }) => {
        const before = h.state.db.length;
        h.state.db = h.state.db.filter((c) => c.name !== where.name);
        return { count: before - h.state.db.length };
      }),
      // reconcileFrigateCameras() reads the post-delete DB.
      findMany: vi.fn(async () => h.state.db.map((c) => ({ name: c.name }))),
    },
  };
}

function makeApp(prisma: ReturnType<typeof makePrisma>) {
  const app = express();
  app.use(express.json());
  // The confirm handler requires an authenticated user (userId); the role gate
  // is stubbed pass-through, so inject a user for every request.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "owner-1" };
    next();
  });
  app.use("/api", createCamerasRouter(prisma as never));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.db = [{ name: "front_door" }, { name: "garage" }];
  h.state.cache = null;
});

describe("camera delete invalidates the cameras:list cache (WARP-1286)", () => {
  it("Tier-2 confirm delete drops a warm cache so the removed camera does not resurrect", async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma);

    // Warm the cache: this GET populates cameras:list with both cameras.
    const warm = await request(app).get("/api/cameras");
    expect(warm.status).toBe(200);
    expect(warm.body.cameras.map((c: { name: string }) => c.name)).toContain("front_door");

    // DELETE is Tier-2 -> 202 confirmation required, and NOTHING is deleted or
    // invalidated yet (the direct-delete branch must not run for a Tier-2 op).
    const del = await request(app).delete("/api/cameras/front_door");
    expect(del.status).toBe(202);
    expect(del.body).toMatchObject({ status: "confirmation_required" });
    expect(h.deleteCamera).not.toHaveBeenCalled();
    expect(prisma.camera.deleteMany).not.toHaveBeenCalled();
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();

    // Confirm — the real executor deletes and (with the fix) invalidates.
    const confirm = await request(app)
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-del", operation: "delete_camera" });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ status: "ok", operation: "delete_camera" });
    expect(h.deleteCamera).toHaveBeenCalledWith("front_door");
    expect(prisma.camera.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.invalidateCamerasCache).toHaveBeenCalledTimes(1);

    // Immediate refetch: the cache was invalidated, so the rebuild reflects the
    // DB and front_door is gone. Without the fix the warm cache would still list
    // it (the resurrection bug).
    const after = await request(app).get("/api/cameras");
    expect(after.status).toBe(200);
    const names = after.body.cameras.map((c: { name: string }) => c.name);
    expect(names).not.toContain("front_door");
    expect(names).toContain("garage");
  });

  it("the confirm executor invalidates after the DB delete", async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma);

    const confirm = await request(app)
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-del", operation: "delete_camera" });
    expect(confirm.status).toBe(200);

    // Invalidation must run after the DB row is gone: if it ran before the
    // delete, a concurrent getCameras() could rebuild + re-cache the
    // still-present camera on its next read and re-introduce the staleness.
    expect(h.invalidateCamerasCache.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.camera.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it("rejects an invalid camera name before any delete or invalidation", async () => {
    const prisma = makePrisma();
    const app = makeApp(prisma);

    const res = await request(app).delete("/api/cameras/bad.name");
    expect(res.status).toBe(400);
    expect(prisma.camera.deleteMany).not.toHaveBeenCalled();
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });
});

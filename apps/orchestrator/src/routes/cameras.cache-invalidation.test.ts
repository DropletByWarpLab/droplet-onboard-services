/**
 * WARP-1286 follow-up — every path that mutates the camera set/shape must
 * invalidate the 5s `cameras:list` cache, or getCameras() serves a stale
 * snapshot for up to CACHE_TTL. WARP-1286 (PR #1032) fixed only the
 * DELETE/confirm-delete path; an adversarial review found the same class of
 * staleness on the other mutators:
 *
 *   - POST /cameras/discovered/:id/reject — hard-deletes a row (resurrection
 *     mirror of the delete bug).
 *   - POST /cameras (manual add) — upserts a row (add-side: invisible for 5s).
 *   - POST /cameras/:name/enable — flips `enabled` inline (stale flag).
 *   - disable_camera — flips `enabled`; Tier-2, so the REAL executor is
 *     POST /cameras/command/confirm -> case "disable_camera", NOT the direct
 *     /disable route (which 202s). The direct branch is defense-in-depth.
 *
 * The fix centralises invalidation inside the router's reconcileFrigateCameras()
 * closure (covers add/accept/reject/delete, which all reconcile) and adds
 * explicit invalidation to the enable/disable mutators (which don't reconcile).
 *
 * Each test drives the ACTUAL production path and models the cache contract
 * with a stateful fake: getCameras() serves a warm cache if present else
 * rebuilds from the DB and caches; invalidateCamerasCache() clears it;
 * the prisma mutation updates the DB source of truth. A GET landing inside the
 * TTL after a mutation must reflect the mutation — proving the cache was busted
 * rather than serving the pre-mutation snapshot. (The fake IS the assertion: if
 * a fix is removed, the warm cache survives and the GET reads stale.)
 *
 * Focused harness: supertest + a pass-through role gate + an injected user (the
 * confirm handler needs a userId); every service module cameras.ts imports is
 * mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Stateful fake for the cameras:list cache + its DB source of truth. Hoisted so
// the vi.mock factories below can reference it (mocks hoist above imports).
const h = vi.hoisted(() => {
  interface Row {
    id: string;
    name: string;
    enabled: boolean;
    // WARP-1893: optional so the pre-existing fixtures below still typecheck;
    // only the rename test cares about it.
    displayName?: string;
  }
  const state: {
    db: Row[];
    cache: { name: string; enabled: boolean; displayName?: string }[] | null;
  } = {
    db: [],
    cache: null,
  };
  return {
    state,
    // Serve the warm cache if present, else rebuild from the DB and cache it —
    // the real getCameras() contract, minus the Frigate merge we don't exercise.
    getCameras: vi.fn(async () => {
      if (state.cache) return state.cache;
      state.cache = state.db.map((c) => ({
        name: c.name,
        enabled: c.enabled,
        displayName: c.displayName,
      }));
      return state.cache;
    }),
    invalidateCamerasCache: vi.fn(async () => {
      state.cache = null;
    }),
    // Frigate client side-effects — irrelevant to the cache contract, no-ops.
    enableDetection: vi.fn(async () => {}),
    disableDetection: vi.fn(async () => {}),
    deleteCamera: vi.fn(async () => {}),
    addCamera: vi.fn(async () => true),
    syncCamerasFromDb: vi.fn(async () => []),
    // Network-safety evaluator — per-test overridable (a test may force the
    // inline-allowed shape). Broad return type so both the Tier-2 202 shape and
    // the `{ allowed: true }` override are assignable. Default: Tier-2 202.
    evaluateNetworkCommand: vi.fn(async (): Promise<Record<string, unknown>> => ({
      allowed: false,
      requiresConfirmation: true,
      confirmationToken: "tok",
      reason: "Confirm",
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
  enableDetection: h.enableDetection,
  disableDetection: h.disableDetection,
  deleteCamera: h.deleteCamera,
  addCamera: h.addCamera,
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
      // reject: hard-delete a row by id.
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        h.state.db = h.state.db.filter((c) => c.id !== where.id);
        return {};
      }),
      // delete_camera confirm / direct DELETE: remove by name.
      deleteMany: vi.fn(async ({ where }: { where: { name: string } }) => {
        const before = h.state.db.length;
        h.state.db = h.state.db.filter((c) => c.name !== where.name);
        return { count: before - h.state.db.length };
      }),
      // manual add: insert or update a row by name.
      upsert: vi.fn(async ({ where, create }: { where: { name: string }; create: { name: string } }) => {
        const found = h.state.db.find((c) => c.name === where.name);
        if (found) return { id: found.id, name: found.name };
        const row = { id: `id-${create.name}`, name: create.name, enabled: true };
        h.state.db.push(row);
        return { id: row.id, name: row.name };
      }),
      // enable/disable: flip the enabled flag by name.
      // WARP-1893: also the rename path, which writes `displayName` through
      // the same updateMany. Each field is applied only when present so a
      // rename can't clear `enabled` (or vice versa).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { name: string };
          data: { enabled?: boolean; displayName?: string };
        }) => {
          let count = 0;
          for (const c of h.state.db) {
            if (c.name === where.name) {
              if (data.enabled !== undefined) c.enabled = data.enabled;
              if (data.displayName !== undefined) c.displayName = data.displayName;
              count++;
            }
          }
          return { count };
        },
      ),
      // accept: enable a discovered row by id.
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { enabled: boolean } }) => {
        const row = h.state.db.find((c) => c.id === where.id);
        if (row) row.enabled = data.enabled;
        return row ?? { name: "unknown" };
      }),
      // reconcileFrigateCameras() reads the post-mutation DB.
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
    // WARP-1962: a ROLE is required as well as an id. The per-camera
    // access guard resolves scope from the principal's role, and this
    // injector previously supplied an id alone — a shape the real auth
    // middleware never produces, and which the guard correctly reads as
    // "unknown principal" and denies.
    (req as unknown as { user: { id: string; role: string } }).user = {
      id: "owner-1",
      role: "owner",
    };
    next();
  });
  app.use("/api", createCamerasRouter(prisma as never));
  return app;
}

async function getCameraNames(app: express.Express): Promise<string[]> {
  const res = await request(app).get("/api/cameras");
  expect(res.status).toBe(200);
  return (res.body.cameras as { name: string }[]).map((c) => c.name);
}

async function getEnabled(app: express.Express, name: string): Promise<boolean | undefined> {
  const res = await request(app).get("/api/cameras");
  expect(res.status).toBe(200);
  return (res.body.cameras as { name: string; enabled: boolean }[]).find((c) => c.name === name)?.enabled;
}

async function getDisplayName(app: express.Express, name: string): Promise<string | undefined> {
  const res = await request(app).get("/api/cameras");
  expect(res.status).toBe(200);
  return (res.body.cameras as { name: string; displayName?: string }[]).find(
    (c) => c.name === name,
  )?.displayName;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.db = [];
  h.state.cache = null;
  // Restore the default Tier-2 evaluator (a test may override it).
  h.evaluateNetworkCommand.mockImplementation(async () => ({
    allowed: false,
    requiresConfirmation: true,
    confirmationToken: "tok",
    reason: "Confirm",
    tier: 2,
  }));
});

describe("WARP-1286 follow-up — cameras:list invalidation on every camera mutation", () => {
  it("reject: a rejected camera does not resurrect on a GET inside the TTL", async () => {
    h.state.db = [
      { id: "id-front", name: "front_door", enabled: true },
      { id: "id-back", name: "back_yard", enabled: true },
    ];
    const app = makeApp(makePrisma());

    // Warm the cache with both cameras.
    expect(await getCameraNames(app)).toEqual(["front_door", "back_yard"]);
    expect(h.state.cache).not.toBeNull();

    const res = await request(app).post("/api/cameras/discovered/id-back/reject");
    expect(res.status).toBe(200);
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    // Refetch inside the TTL — the rejected camera must be gone, not served stale.
    expect(await getCameraNames(app)).toEqual(["front_door"]);
  });

  it("accept: a freshly accepted discovered camera shows enabled on a GET inside the TTL", async () => {
    // Discovered cameras land disabled; accept flips enabled true and reconciles.
    h.state.db = [{ id: "id-new", name: "new_cam", enabled: false }];
    const app = makeApp(makePrisma());

    expect(await getEnabled(app, "new_cam")).toBe(false);

    const res = await request(app).post("/api/cameras/discovered/id-new/accept");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "accepted" });
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getEnabled(app, "new_cam")).toBe(true);
  });

  it("manual add: a newly added camera is visible on a GET inside the TTL", async () => {
    h.state.db = [{ id: "id-front", name: "front_door", enabled: true }];
    const app = makeApp(makePrisma());

    expect(await getCameraNames(app)).toEqual(["front_door"]);

    const res = await request(app)
      .post("/api/cameras")
      .send({ name: "garage", rtspUrl: "rtsp://192.168.100.50/stream" });
    expect(res.status).toBe(200);
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getCameraNames(app)).toEqual(expect.arrayContaining(["front_door", "garage"]));
  });

  it("enable: the enabled flag flips on a GET inside the TTL", async () => {
    h.state.db = [{ id: "id-front", name: "front_door", enabled: false }];
    const app = makeApp(makePrisma());

    expect(await getEnabled(app, "front_door")).toBe(false);

    const res = await request(app).post("/api/cameras/front_door/enable");
    expect(res.status).toBe(200);
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getEnabled(app, "front_door")).toBe(true);
  });

  it("disable (Tier-2 confirm — the production path): direct route 202s and mutates nothing; confirm flips the flag within the TTL", async () => {
    h.state.db = [{ id: "id-front", name: "front_door", enabled: true }];
    const app = makeApp(makePrisma());

    expect(await getEnabled(app, "front_door")).toBe(true);

    // Direct /disable is Tier-2 → 202, no mutation, no invalidation (dead branch).
    const gate = await request(app).post("/api/cameras/front_door/disable");
    expect(gate.status).toBe(202);
    expect(gate.body).toMatchObject({ status: "confirmation_required" });
    expect(h.disableDetection).not.toHaveBeenCalled();
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
    // Still true, and the cache is still warm from the GET above.
    expect(await getEnabled(app, "front_door")).toBe(true);

    // The confirm handler is the real executor.
    const confirm = await request(app)
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok", operation: "disable_camera" });
    expect(confirm.status).toBe(200);
    expect(h.disableDetection).toHaveBeenCalledWith("front_door");
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getEnabled(app, "front_door")).toBe(false);
  });

  it("disable (direct branch — defense-in-depth): if the op is ever allowed inline, the flag flips within the TTL", async () => {
    h.state.db = [{ id: "id-front", name: "front_door", enabled: true }];
    // Force the non-Tier-2 inline path: allowed, no confirmation required.
    h.evaluateNetworkCommand.mockImplementation(async () => ({ allowed: true }));
    const app = makeApp(makePrisma());

    expect(await getEnabled(app, "front_door")).toBe(true);

    const res = await request(app).post("/api/cameras/front_door/disable");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "disabled" });
    expect(h.disableDetection).toHaveBeenCalledWith("front_door");
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getEnabled(app, "front_door")).toBe(false);
  });

  it("rename (WARP-1893): the new display name is visible on a GET inside the TTL", async () => {
    // displayName rides in the same `cameras:list` payload as `enabled`, so a
    // rename that skips invalidation reads back as the OLD label for up to
    // CACHE_TTL — the user sees their rename do nothing and renames again.
    h.state.db = [
      { id: "id-front", name: "front_door", enabled: true, displayName: "Xnv C8083r E43022502afd" },
    ];
    const app = makeApp(makePrisma());

    // Warm the cache with the pre-rename label.
    expect(await getDisplayName(app, "front_door")).toBe("Xnv C8083r E43022502afd");
    expect(h.state.cache).not.toBeNull();

    const res = await request(app)
      .patch("/api/cameras/front_door")
      .send({ displayName: "Driveway" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "renamed", displayName: "Driveway" });
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    // Refetch inside the TTL — must be the NEW label, not the warm snapshot.
    expect(await getDisplayName(app, "front_door")).toBe("Driveway");
  });

  it("rename does NOT reconcile Frigate — the camera SET is unchanged", async () => {
    // Renaming touches a label, not the set of cameras. Calling
    // syncCamerasFromDb here would be pointless Frigate traffic on every
    // rename; the invalidation above is the only side effect required.
    h.state.db = [{ id: "id-front", name: "front_door", enabled: true, displayName: "Old" }];
    const app = makeApp(makePrisma());

    const res = await request(app).patch("/api/cameras/front_door").send({ displayName: "New" });
    expect(res.status).toBe(200);
    expect(h.syncCamerasFromDb).not.toHaveBeenCalled();
  });

  it("delete (Tier-2 confirm): the centralised reconcile invalidation removes the camera within the TTL", async () => {
    h.state.db = [
      { id: "id-front", name: "front_door", enabled: true },
      { id: "id-back", name: "back_yard", enabled: true },
    ];
    // confirmNetworkCommand returns the name that was deleted.
    h.confirmNetworkCommand.mockImplementation(async (_p, _t, _u, opts) => ({
      confirmed: true,
      operation: opts.operation,
      params: { name: "back_yard" },
    }));
    const app = makeApp(makePrisma());

    expect(await getCameraNames(app)).toEqual(["front_door", "back_yard"]);

    // Direct DELETE is Tier-2 → 202.
    const gate = await request(app).delete("/api/cameras/back_yard");
    expect(gate.status).toBe(202);

    const confirm = await request(app)
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok", operation: "delete_camera" });
    expect(confirm.status).toBe(200);
    expect(h.invalidateCamerasCache).toHaveBeenCalled();

    expect(await getCameraNames(app)).toEqual(["front_door"]);
  });
});

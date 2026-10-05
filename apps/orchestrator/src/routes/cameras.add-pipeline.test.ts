/**
 * WARP-3506 / WARP-3510 — the manual add, end to end against a Frigate that
 * behaves like 0.17.1.
 *
 * The other POST /api/cameras suite (cameras.manual-add-reconcile.test.ts)
 * mocks the Frigate client, so it can prove the route CALLS the right things
 * but not that they add up. This one wires the REAL Frigate client, the real
 * adoption service and the real reconcile to a stateful fake Frigate (config
 * file + restart + /api/stats) and an in-memory Camera table, and drives the
 * live-box failures through the HTTP route:
 *
 *   - `Warp_Lab_Office` was written to Frigate as `warp_lab_office`, stored in
 *     the DB verbatim, and pruned by the reconcile in the same request — logged
 *     three times on the box ("Pruned orphaned cameras … warp_lab_office");
 *   - with a lowercase name the prune did not fire, but `config/set` only wrote
 *     config.yml: nothing started until a manual `POST /api/restart`;
 *   - the route answered `ok` without checking a frame ever arrived.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The REAL Frigate client, except that verification waits ~60 ms instead of
// ~45 s so the "never streams" path is testable.
vi.mock("../services/frigate.client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/frigate.client.js")>();
  return {
    ...actual,
    waitForCameraStreaming: (name: string) =>
      actual.waitForCameraStreaming(name, { timeoutMs: 60, intervalMs: 10 }),
  };
});

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
vi.mock("../services/camera-system.service.js", () => ({ getCameraSystemStatus: vi.fn() }));
vi.mock("../services/network-safety.service.js", () => ({ evaluateNetworkCommand: vi.fn() }));
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
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
}));

import { createCamerasRouter } from "./cameras.js";
import { syncCamerasFromDb } from "../services/frigate.client.js";
import { readCameraKeySnapshot } from "../services/camera-adoption.service.js";
import { makeFakeFrigate, type FakeFrigate } from "../__tests__/helpers/fake-frigate.js";
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

const URL_OK = "rtsp://admin:s3cret%21@192.168.9.219:554/profile2/media.smp";
let fake: FakeFrigate;
let db: ReturnType<typeof makeDb>;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", createCamerasRouter(db.prisma as never));
  return a;
}

const saves = () => fake.calls.filter((c) => c.startsWith("POST /api/config/save"));

beforeEach(() => {
  // A data volume that does not exist: the pre-image is skipped, never written
  // into a real directory.
  process.env.FRIGATE_CONFIG_PREIMAGE_DIR = join(tmpdir(), "no-such-volume-warp-3506", "frigate-config");
  db = makeDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FRIGATE_CONFIG_PREIMAGE_DIR;
});

function frigate(opts: Parameters<typeof makeFakeFrigate>[0] = {}) {
  fake = makeFakeFrigate(opts);
  vi.stubGlobal("fetch", fake.fetch);
}

describe("POST /api/cameras against a Frigate that behaves like 0.17.1", () => {
  it.each([
    ["Warp_Lab_Office", "warp_lab_office"],
    ["Front-Door", "front_door"],
  ])("%s: the camera is added, started, verified — and survives the reconcile", async (typed, key) => {
    frigate();

    const res = await request(app()).post("/api/cameras").send({ name: typed, rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", camera: key });
    // Frigate holds it, started — config/set alone would have left it cold.
    expect(fake.cameras()).toEqual([key]);
    expect(fake.restarts()).toBe(1);
    // The reconcile found nothing to prune: no `config/save` was ever sent.
    expect(saves()).toHaveLength(0);
    // The DB and Frigate agree on the one key; the operator's text is the label.
    expect(db.table.rows).toHaveLength(1);
    expect(db.table.rows[0]).toMatchObject({ name: key, adoption: "ADOPTED", enabled: true });
  });

  it("restarts Frigate after the write — the order is config/set, restart, then the stats polls", async () => {
    frigate();

    await request(app()).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    const writes = fake.calls.filter((c) => !c.startsWith("GET "));
    expect(writes[0]).toBe("PUT /api/config/set");
    expect(writes[1]).toBe("POST /api/restart");
    expect(fake.calls.filter((c) => c.startsWith("GET /api/stats")).length).toBeGreaterThanOrEqual(1);
  });

  it("answers 202 added_no_stream — not 200, not 500 — when the camera never produces a frame", async () => {
    frigate({ fpsAfterRestart: { front_door: 0 } });

    const res = await request(app()).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "added_no_stream", camera: "front_door", code: "no_frames" });
    expect(res.body.reason).toMatch(/address|password/i);
    // Added all the same: the tile exists and re-adding with a corrected URL fixes it.
    expect(fake.cameras()).toEqual(["front_door"]);
    expect(db.table.rows[0]).toMatchObject({ name: "front_door", adoption: "ADOPTED" });
  });

  it("answers 202 with not_started when Frigate never starts the camera", async () => {
    frigate({ fpsAfterRestart: { front_door: null } });

    const res = await request(app()).post("/api/cameras").send({ name: "front_door", rtspUrl: URL_OK });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "added_no_stream", code: "not_started" });
  });

  it("prunes an orphan next to the new camera but never the new camera itself", async () => {
    frigate({
      yaml: "cameras:\n  camera_192_168_20_176:\n    ffmpeg:\n      inputs:\n        - path: rtsp://stale\n",
    });

    const res = await request(app()).post("/api/cameras").send({ name: "Warp_Lab_Office", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(fake.cameras()).toEqual(["warp_lab_office"]);
    expect(saves()).toHaveLength(1);
  });

  it("does not prune a legacy camera whose DB name differs from its Frigate key only by case", async () => {
    // A row from before the canonical-key migration: `Front-Door` in the DB,
    // `front_door` in Frigate. The case-sensitive reconcile pruned it.
    frigate({ yaml: "cameras:\n  front_door:\n    ffmpeg:\n      inputs:\n        - path: rtsp://old\n" });
    db.table.seed({ name: "Front-Door", adoption: "ADOPTED", enabled: true });

    const res = await request(app()).post("/api/cameras").send({ name: "back_yard", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(fake.cameras().sort()).toEqual(["back_yard", "front_door"]);
    expect(saves()).toHaveLength(0);
  });

  it("links the discovered device: ONE adopted row, not a placeholder plus a duplicate", async () => {
    frigate();
    const placeholder = db.table.seed({
      name: "camera_192_168_9_219",
      ipAddress: "192.168.9.219",
      macAddress: "e4:30:22:50:2a:fd",
      enabled: false,
      autoDiscovered: true,
      adoption: "CANDIDATE",
    });

    const res = await request(app()).post("/api/cameras").send({ name: "Warp_Lab_Office", rtspUrl: URL_OK });

    expect(res.status).toBe(200);
    expect(db.table.rows).toHaveLength(1);
    expect(db.table.rows[0]).toMatchObject({
      id: placeholder.id,
      name: "warp_lab_office",
      adoption: "ADOPTED",
      macAddress: "e4:30:22:50:2a:fd",
    });
  });

  it("a reconcile that overlaps the add cannot prune the camera it is adding", async () => {
    // The add is parked inside Frigate's config/set — Frigate has (or is about
    // to have) the camera, the DB does not name it yet. A reconcile queued now
    // would snapshot that DB and prune the camera. It waits behind the add, and
    // reads the DB only after the add's row is written.
    frigate();
    const releaseSet = fake.hold("PUT /api/config/set");

    const posting = request(app())
      .post("/api/cameras")
      .send({ name: "front_door", rtspUrl: URL_OK })
      .then((r) => r);
    await vi.waitFor(() => expect(fake.calls.some((c) => c.startsWith("PUT /api/config/set"))).toBe(true));
    const reconciling = syncCamerasFromDb(() => readCameraKeySnapshot(db.prisma as never));
    await new Promise((r) => setTimeout(r, 20));

    releaseSet();
    const [res, removed] = await Promise.all([posting, reconciling]);

    expect(res.status).toBe(200);
    expect(removed).toEqual([]);
    expect(fake.cameras()).toEqual(["front_door"]);
    expect((db.table.rows as Row[]).map((r) => r.name)).toEqual(["front_door"]);
  });
});

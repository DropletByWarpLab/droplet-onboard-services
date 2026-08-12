/**
 * WARP-1893 — PATCH /api/cameras/:name (rename to a household-facing label).
 *
 * The invariant this file exists to protect is the first one: **`Camera.name`
 * is never written**. That column is the Frigate config key — it names the
 * recording directory, keys the event rows, and roots the MQTT topic tree, so
 * a rename that touched it would orphan every recording the household has.
 * `displayName` is the only field this route may write, and the test asserts
 * that against the actual Prisma payload, not just the response body.
 *
 * The rest is input validation. `displayName` is free text (spaces, accents,
 * emoji are all legitimate names for a camera), so the only limits are length
 * and control characters — the latter because they corrupt every surface that
 * renders the name and can smuggle line breaks into log lines.
 *
 * Cache invalidation for this route is covered in cameras.cache-invalidation.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const h = vi.hoisted(() => ({
  updateMany: vi.fn(),
  invalidateCamerasCache: vi.fn(async () => {}),
}));

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
    FRIGATE_URL: "http://frigate.test:5000",
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
  syncCamerasFromDb: vi.fn(async () => []),
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
  getCameras: vi.fn(async () => []),
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

vi.mock("../services/camera-system.service.js", () => ({ getCameraSystemStatus: vi.fn() }));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
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
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
}));

import { createCamerasRouter } from "./cameras.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: "owner-1" };
    next();
  });
  app.use("/api", createCamerasRouter({ camera: { updateMany: h.updateMany } } as never));
  return app;
}

/** Default: one row matched. */
function matched() {
  h.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  matched();
});

describe("WARP-1893 — PATCH /api/cameras/:name", () => {
  it("writes displayName and NEVER touches name", async () => {
    const res = await request(makeApp())
      .patch("/api/cameras/xnv_c8083r_e43022502afd")
      .send({ displayName: "Driveway" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "renamed",
      camera: "xnv_c8083r_e43022502afd",
      displayName: "Driveway",
    });

    expect(h.updateMany).toHaveBeenCalledTimes(1);
    const call = h.updateMany.mock.calls[0][0] as {
      where: { name: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ name: "xnv_c8083r_e43022502afd" });
    expect(call.data).toEqual({ displayName: "Driveway" });
    // The load-bearing assertion: the Frigate config key is untouched, so
    // existing recordings and event history keep resolving.
    expect(Object.keys(call.data)).not.toContain("name");
  });

  it("ignores a client attempt to smuggle `name` into the body", async () => {
    const res = await request(makeApp())
      .patch("/api/cameras/front_door")
      .send({ displayName: "Porch", name: "hijacked" });

    expect(res.status).toBe(200);
    const call = h.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ displayName: "Porch" });
  });

  it("trims surrounding whitespace before writing", async () => {
    await request(makeApp()).patch("/api/cameras/front_door").send({ displayName: "  Porch  " });
    const call = h.updateMany.mock.calls[0][0] as { data: { displayName: string } };
    expect(call.data.displayName).toBe("Porch");
  });

  it("accepts free text — spaces, accents, and emoji are legitimate camera names", async () => {
    for (const name of ["Front Door", "Jardín Trasero", "Garage 🚗", "Kids' Room"]) {
      h.updateMany.mockClear();
      const res = await request(makeApp()).patch("/api/cameras/cam_1").send({ displayName: name });
      expect(res.status, `expected 200 for ${name}`).toBe(200);
      const call = h.updateMany.mock.calls[0][0] as { data: { displayName: string } };
      expect(call.data.displayName).toBe(name);
    }
  });

  it("persists NFC — an NFD 'Café' (e + combining acute) is stored composed", async () => {
    // WARP-1893 review — iOS dictation and some IMEs emit decomposed
    // (NFD) strings. Without normalization the same visible name can be
    // stored in two byte forms, so the rename_camera tool's display-name
    // resolution and duplicate-looking labels get inconsistent. Normalize
    // once, on write.
    const nfd = "Cafe\u0301"; // "Cafe" + combining acute (decomposed)
    const nfc = "Caf\u00e9"; // precomposed
    expect(nfd).not.toBe(nfc); // the fixture really is two byte forms
    const res = await request(makeApp())
      .patch("/api/cameras/cam_1")
      .send({ displayName: nfd });
    expect(res.status).toBe(200);
    const call = h.updateMany.mock.calls[0][0] as { data: { displayName: string } };
    expect(call.data.displayName).toBe(nfc);
    expect(res.body.displayName).toBe(nfc);
  });

  it("accepts exactly 64 characters and rejects 65", async () => {
    const ok = await request(makeApp())
      .patch("/api/cameras/cam_1")
      .send({ displayName: "y".repeat(64) });
    expect(ok.status).toBe(200);

    h.updateMany.mockClear();
    const tooLong = await request(makeApp())
      .patch("/api/cameras/cam_1")
      .send({ displayName: "y".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["missing body", {}],
    ["null displayName", { displayName: null }],
    ["numeric displayName", { displayName: 7 }],
    ["empty string", { displayName: "" }],
    ["whitespace only", { displayName: "   " }],
    ["newline", { displayName: "Porch\nDoor" }],
    ["tab", { displayName: "Porch\tDoor" }],
    ["NUL", { displayName: "Porch\u0000Door" }],
    ["zero-width joiner", { displayName: "Porch\u200DDoor" }],
  ])("rejects %s with 400 and no write", async (_label, body) => {
    const res = await request(makeApp()).patch("/api/cameras/cam_1").send(body);
    expect(res.status).toBe(400);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an invalid camera name in the path with 400 and no write", async () => {
    const res = await request(makeApp())
      .patch("/api/cameras/not%20a%20camera!")
      .send({ displayName: "Porch" });
    expect(res.status).toBe(400);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("404s when no camera row matches, and does not invalidate the cache", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(makeApp())
      .patch("/api/cameras/ghost_cam")
      .send({ displayName: "Nowhere" });

    expect(res.status).toBe(404);
    expect(h.invalidateCamerasCache).not.toHaveBeenCalled();
  });

  it("permits a duplicate display name — two cameras may both be a 'Side Gate'", async () => {
    // displayName is deliberately NOT unique-checked; Camera.name remains the
    // unique key. This is why the rename_camera tool must refuse to guess
    // between same-named cameras rather than pick one.
    const res = await request(makeApp())
      .patch("/api/cameras/cam_2")
      .send({ displayName: "Side Gate" });
    expect(res.status).toBe(200);
  });
});

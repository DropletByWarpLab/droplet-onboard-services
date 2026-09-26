/**
 * WARP-3103 / WARP-3104 — watching is audited, saving is custody, and a
 * member cannot switch detection off through the confirm handshake either.
 *
 * Real router and guards; Frigate, the activity recorder and fetch stubbed.
 * Role gates for every route are pinned in cameras-view-gate.test.ts; this
 * file pins the audit rows (kind, camera, dedupe) and the confirm gate.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    FRIGATE_URL: "http://frigate.test:5000",
    SERVICE_SECRET: "svc",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue({ id: 1n }),
}));

vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(), getEventsFiltered: vi.fn(), getRecentEvents: vi.fn(),
  getRecordings: vi.fn(), getRecordingsSummary: vi.fn(), getReviewsFiltered: vi.fn(),
  getStats: vi.fn(), getTimelineEntries: vi.fn(), searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(), setReviewViewed: vi.fn(), subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true), invalidateCamerasCache: vi.fn(),
}));
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(), fetchEventCamera: vi.fn(), fetchReviewCamera: vi.fn(),
  fetchEventThumbnail: vi.fn(), fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(), fetchFaceImage: vi.fn(), deleteKnownFace: vi.fn(),
  deleteFaceImage: vi.fn(), deleteKnownPlate: vi.fn(), nameKnownPlate: vi.fn(),
  regenerateEventDescription: vi.fn(), tagEventAsFace: vi.fn(), openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(), enableDetection: vi.fn(), disableDetection: vi.fn(),
  deleteCamera: vi.fn(), deleteEvent: vi.fn(), addCamera: vi.fn(),
  syncCamerasFromDb: vi.fn().mockResolvedValue([]),
  fetchEvents: vi.fn(), buildRecordingClipUrl: vi.fn().mockReturnValue("http://frigate.test/clip.mp4"),
  buildVodMasterUrl: vi.fn().mockReturnValue("http://frigate.test/master.m3u8"),
  buildVodSegmentUrl: vi.fn().mockReturnValue("http://frigate.test/0.ts"),
  fetchHlsPlaylist: vi.fn(), fetchPtzCapabilities: vi.fn(),
  ptzGoToPreset: vi.fn(), ptzMove: vi.fn(), restartFrigate: vi.fn(),
  isValidIanaTimezone: () => true,
  NoRecordingsInRangeError: class NoRecordingsInRangeError extends Error {},
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { recordActivity } from "../services/activity.singleton.js";
import {
  fetchEventCamera,
  fetchHlsPlaylist,
  openMjpegStream,
  disableDetection,
  deleteCamera,
  restartFrigate,
} from "../services/frigate.client.js";
import { confirmNetworkCommand } from "../services/network-safety.service.js";
import {
  auditCameraWatch,
  resetCameraWatchDedupe,
  WATCH_DEDUPE_MS,
} from "../services/camera-watch-audit.js";
import type { AuthUser } from "../middleware/auth.js";

const mockRecord = vi.mocked(recordActivity);

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "ana", displayName: "Ana", role: "admin" };
const member: AuthUser = { id: "u-member", username: "sam", displayName: "Sam", role: "family" };

const prismaShim = {
  cameraAccessGrant: { findMany: vi.fn(async () => [{ camera: { name: "front" } }]) },
  camera: {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
} as unknown as PrismaClient;

function appAs(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prismaShim));
  return app;
}

/** The audit is fire-and-forget; let its promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

function rows() {
  return mockRecord.mock.calls.map(([p]) => p);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue({ id: 1n } as never);
  resetCameraWatchDedupe();
  vi.mocked(fetchEventCamera).mockResolvedValue("front");
  vi.mocked(openMjpegStream).mockImplementation(async () =>
    // image/jpeg, not multipart: supertest would try to parse a real MJPEG body.
    new globalThis.Response("frame", { headers: { "content-type": "image/jpeg" } }),
  );
  vi.mocked(fetchHlsPlaylist).mockResolvedValue("#EXTM3U\n#EXTINF:10,\n0.ts\n");
  vi.stubGlobal("fetch", vi.fn(async () => new globalThis.Response("mp4bytes", { headers: { "content-type": "video/mp4" } })));
});

describe("watching writes one audit row per (actor, camera, kind) per window", () => {
  it("opening a live view writes actor, camera, kind and time", async () => {
    const res = await request(appAs(member)).get("/api/cameras/front/live");
    expect(res.status).toBe(200);
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      kind: "camera",
      severity: "info",
      sub: "front",
      what: "Fetched a live view (inline)",
      refs: { surface: "camera_watch", camera: "front", watch: "live", saved: false, delivery: "inline", actor: "sam" },
      actor: { type: "user", id: "u-member" },
    });
  });

  it("reopening the same live view inside the window writes nothing new", async () => {
    await request(appAs(member)).get("/api/cameras/front/live");
    await request(appAs(member)).get("/api/cameras/front/live");
    await request(appAs(member)).get("/api/cameras/front/live");
    await settle();
    expect(rows()).toHaveLength(1);
  });

  it("another person, camera or kind is its own row", async () => {
    await request(appAs(member)).get("/api/cameras/front/live");
    await request(appAs(owner)).get("/api/cameras/front/live");
    await request(appAs(owner)).get("/api/cameras/back/live");
    await request(appAs(owner)).get("/api/cameras/front/playback.m3u8?after=1000&before=2000");
    await settle();
    expect(rows().map((r) => [r.actor, (r.refs as { camera: string; watch: string }).camera, (r.refs as { watch: string }).watch])).toEqual([
      [{ type: "user", id: "u-member" }, "front", "live"],
      [{ type: "user", id: "u-owner" }, "front", "live"],
      [{ type: "user", id: "u-owner" }, "back", "live"],
      [{ type: "user", id: "u-owner" }, "front", "recording"],
    ]);
  });

  it("a recording's segments are never audited, only its playlist", async () => {
    await request(appAs(member)).get("/api/cameras/front/playback.segment?after=1000&before=2000&seg=0.ts");
    await request(appAs(member)).get("/api/cameras/front/playback.segment?after=1000&before=2000&seg=1.ts");
    await settle();
    expect(rows()).toHaveLength(0);
  });

  it("mp4 playback of a recording is audited as recording", async () => {
    const res = await request(appAs(member)).get("/api/cameras/front/playback?after=1000&before=1600");
    expect(res.status).toBe(200);
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].refs).toMatchObject({ camera: "front", watch: "recording" });
  });

  it("a member playing an event clip inline is audited as clip against the event's camera", async () => {
    const res = await request(appAs(member)).get("/api/cameras/clips/event/ev1");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBeUndefined();
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].refs).toMatchObject({ camera: "front", watch: "clip", saved: false, eventId: "ev1" });
  });

  it("a failed write does not arm the window: the next fetch writes again", async () => {
    mockRecord.mockResolvedValueOnce(null);
    await auditCameraWatch({ user: owner }, "front", "live", { now: 0 });
    await auditCameraWatch({ user: owner }, "front", "live", { now: 1 });
    await auditCameraWatch({ user: owner }, "front", "live", { now: 2 });
    expect(rows()).toHaveLength(2);
  });

  it("the window expires: the same watch after 5 minutes is a new row", async () => {
    const req = { user: owner };
    await auditCameraWatch(req, "front", "live", { now: 0 });
    await auditCameraWatch(req, "front", "live", { now: WATCH_DEDUPE_MS - 1 });
    await auditCameraWatch(req, "front", "live", { now: WATCH_DEDUPE_MS });
    expect(rows()).toHaveLength(2);
  });
});

describe("saving footage is custody: attachment for owner/admin, 403 for members, never deduped", () => {
  it("a member asking for the clip as a file is refused before Frigate is called", async () => {
    const res = await request(appAs(member)).get("/api/cameras/clips/event/ev1?download=1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CAMERA_CUSTODY_REQUIRED");
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    await settle();
    expect(rows()).toHaveLength(0);
  });

  it("an admin gets an attachment, and every save is its own row", async () => {
    const first = await request(appAs(admin)).get("/api/cameras/clips/event/ev1?download=1");
    expect(first.status).toBe(200);
    expect(first.headers["content-disposition"]).toBe('attachment; filename="clip-ev1.mp4"');
    expect(first.headers["cache-control"]).toBe("private, no-store");
    await request(appAs(admin)).get("/api/cameras/clips/event/ev1?download=1");
    await settle();
    expect(rows()).toHaveLength(2);
    expect(rows().every((r) => (r.refs as { saved: boolean }).saved)).toBe(true);
    expect(rows()[0].what).toBe("Saved an event clip");
  });

  it("an event snapshot saved by the owner is an attachment with a saved row", async () => {
    const res = await request(appAs(owner)).get("/api/cameras/events/ev1/snapshot?download=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="snapshot-ev1.jpg"');
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].refs).toMatchObject({ camera: "front", watch: "snapshot", saved: true });
  });

  it("viewing an event snapshot inline is not audited", async () => {
    const res = await request(appAs(member)).get("/api/cameras/events/ev1/snapshot");
    expect(res.status).toBe(200);
    await settle();
    expect(rows()).toHaveLength(0);
  });
});

describe("a member cannot complete a detection-off handshake (WARP-3104)", () => {
  beforeEach(() => {
    vi.mocked(confirmNetworkCommand).mockResolvedValue({
      confirmed: true,
      operation: "disable_camera",
      params: { name: "front" },
    } as never);
  });

  it("member → 403, detection untouched", async () => {
    const res = await request(appAs(member))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "t", operation: "disable_camera" });
    expect(res.status).toBe(403);
    expect(vi.mocked(disableDetection)).not.toHaveBeenCalled();
  });

  it("owner → 200, detection off", async () => {
    const res = await request(appAs(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "t", operation: "disable_camera" });
    expect(res.status).toBe(200);
    expect(vi.mocked(disableDetection)).toHaveBeenCalledWith("front");
  });
});

describe("confirm handshakes for camera administration (WARP-3104)", () => {
  const confirmAs = (user: AuthUser, operation: string, params: object = {}) => {
    vi.mocked(confirmNetworkCommand).mockResolvedValue({ confirmed: true, operation, params } as never);
    return request(appAs(user)).post("/api/cameras/command/confirm").send({ confirmationToken: "t", operation });
  };

  it("a member cannot complete delete_camera", async () => {
    expect((await confirmAs(member, "delete_camera", { name: "front" })).status).toBe(403);
    expect(vi.mocked(deleteCamera)).not.toHaveBeenCalled();
  });

  it("an admin completes delete_camera", async () => {
    expect((await confirmAs(admin, "delete_camera", { name: "front" })).status).toBe(200);
    expect(vi.mocked(deleteCamera)).toHaveBeenCalledWith("front");
  });

  it("restart_frigate executes on the confirm step, for the owner only", async () => {
    expect((await confirmAs(admin, "restart_frigate")).status).toBe(403);
    expect(vi.mocked(restartFrigate)).not.toHaveBeenCalled();
    expect((await confirmAs(owner, "restart_frigate")).status).toBe(200);
    expect(vi.mocked(restartFrigate)).toHaveBeenCalledTimes(1);
  });
});

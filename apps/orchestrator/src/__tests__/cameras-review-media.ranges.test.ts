/**
 * Review media uses Frigate's metadata-backed WebP and preview endpoints.
 * Real client and router exercise safe thumbnail paths, missing media,
 * content types, and partial-content response headers.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
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
vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateDirectory: vi.fn(), ncUploadFile: vi.fn(), ncDownloadFile: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nctok"),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { AuthUser } from "../middleware/auth.js";

const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  app.use("/api", createCamerasRouter({} as PrismaClient));
  app.use(errorHandler);
  return app;
}

const EVENT = "1719000000.123456-abc123";

let fetchSpy: MockInstance<typeof fetch>;

/** Frigate answers `status` (with `body`) for any URL. */
function frigateAnswers(status: number, body: BodyInit | null = null, headers?: HeadersInit) {
  fetchSpy.mockImplementation(async () => new Response(body, { status, headers }));
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

const REVIEW_ID = "1791217034.251212-bpm83f";
const REVIEW_PATH = `/api/cameras/reviews/${REVIEW_ID}`;
const thumbPath = `/media/frigate/clips/review/thumb-warp_lab_office-${REVIEW_ID}.webp`;

describe("Frigate review media", () => {
  it("looks up and serves the review's WebP thumbnail from its actual clips path", async () => {
    fetchSpy.mockImplementation(async (input) => String(input).endsWith(`/api/review/${REVIEW_ID}`)
      ? Response.json({ camera: "warp_lab_office", thumb_path: thumbPath })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/octet-stream" } }));
    const res = await request(buildApp()).get(`${REVIEW_PATH}/thumbnail`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(fetchSpy).toHaveBeenLastCalledWith(`http://frigate.test:5000${thumbPath.replace("/media/frigate", "")}`, expect.anything());
  });

  it.each(["/etc/passwd", "http://other.test/picture", "/media/frigate/clips/review/../../secret", thumbPath.replace(REVIEW_ID, "different")])(
    "refuses an unrelated or unsafe thumbnail path: %s", async (path) => {
      fetchSpy.mockResolvedValue(Response.json({ camera: "warp_lab_office", thumb_path: path }));
      const res = await request(buildApp()).get(`${REVIEW_PATH}/thumbnail`);
      expect(res.status).toBe(404);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it("requests the real preview endpoint and preserves partial byte responses", async () => {
    frigateAnswers(206, "abc", { "content-type": "video/mp4", "content-length": "3", "content-range": "bytes 0-2/12", "accept-ranges": "bytes" });
    const res = await request(buildApp()).get(`${REVIEW_PATH}/preview`).set("Range", "bytes=0-2");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-2/12");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(fetchSpy).toHaveBeenCalledWith(`http://frigate.test:5000/api/review/${REVIEW_ID}/preview?format=mp4`, expect.objectContaining({ headers: { Range: "bytes=0-2" } }));
  });

  it("preserves a missing preview and an unsatisfiable byte range", async () => {
    frigateAnswers(404, "Missing", { "content-length": "7" });
    const missing = await request(buildApp()).get(`${REVIEW_PATH}/preview`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: "preview_not_found" });
    frigateAnswers(416, null, { "content-range": "bytes */12", "content-length": "0" });
    const res = await request(buildApp()).get(`${REVIEW_PATH}/preview`).set("Range", "bytes=999-");
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */12");
    expect(res.body).toEqual({ error: "frigate 416" });
  });

  it("passes browser ranges through the individual event clip route", async () => {
    fetchSpy.mockImplementation(async (url, options) => String(url).endsWith("clip.mp4")
      ? new Response("abc", { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-2/12" } })
      : Response.json({ camera: "warp_lab_office" }));
    const res = await request(buildApp()).get(`/api/cameras/clips/event/${EVENT}`).set("Range", "bytes=0-2");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-2/12");
    expect(fetchSpy).toHaveBeenCalledWith(`http://frigate.test:5000/api/events/${EVENT}/clip.mp4`, expect.objectContaining({ headers: { Range: "bytes=0-2" } }));
  });
});

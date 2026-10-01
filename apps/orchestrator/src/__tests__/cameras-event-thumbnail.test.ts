/**
 * GET /api/cameras/events/:eventId/thumbnail — a missing thumbnail is a 404.
 *
 * Frigate answers 404 for an event it has pruned and for one it never made a
 * thumbnail for. The frigate client threw a plain Error for every non-2xx, so
 * the route's `next(err)` turned "no such thumbnail" into a 500 — a client
 * (the native apps) cannot tell "this event has no picture" from "the server
 * broke". Sibling media routes (`/snapshot`, `/reviews/:id/thumbnail`) pass
 * Frigate's status through; this one now answers 404 for the missing case and
 * leaves every other upstream failure exactly where it was.
 *
 * Real frigate client, real cameras router, real error handler: only the
 * network (`fetch`) and the heavy sibling services are stubbed, so the test
 * covers the client's status sniff and the route's mapping together.
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
const PATH = `/api/cameras/events/${EVENT}/thumbnail`;

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

describe("GET /api/cameras/events/:eventId/thumbnail", () => {
  it("serves the image bytes when Frigate has the thumbnail", async () => {
    frigateAnswers(200, new Uint8Array([0xff, 0xd8, 0xff]), { "content-type": "image/jpeg" });
    const res = await request(buildApp()).get(PATH);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://frigate.test:5000/api/events/${EVENT}/thumbnail.jpg`,
      expect.anything(),
    );
  });

  it("404 with the route's { error } shape when Frigate has no thumbnail for the event", async () => {
    frigateAnswers(404);
    const res = await request(buildApp()).get(PATH);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Thumbnail not found" });
  });

  it.each([500, 502, 503])(
    "a Frigate %i is not 'missing': it keeps answering the generic 500",
    async (status) => {
      frigateAnswers(status);
      const res = await request(buildApp()).get(PATH);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "Internal server error",
        message: "Something went wrong",
      });
    },
  );

  it("an unreachable Frigate keeps answering the generic 500", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const res = await request(buildApp()).get(PATH);

    expect(res.status).toBe(500);
  });

  it("does not match on the message: an Error saying thumbnail_not_found is still a 500", async () => {
    fetchSpy.mockRejectedValue(new Error("thumbnail_not_found"));
    const res = await request(buildApp()).get(PATH);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Internal server error",
      message: "Something went wrong",
    });
  });

  it("400 on a malformed event id, without touching Frigate", async () => {
    const res = await request(buildApp()).get(
      `/api/cameras/events/${encodeURIComponent("not ok/../id")}/thumbnail`,
    );

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * DELETE /api/cameras/events/:eventId — WARP-1440 delete-clip route.
 *
 * Scaffolding copied from `clips-share-confirmation.routes.test.ts`: mount
 * ONLY createCamerasRouter behind a req.user-injecting shim, keep the REAL
 * auth guards (requireRole / requireRoleOrMcpService) so the role matrix is
 * exercised for real, and mock the heavy service modules the router imports.
 *
 * Pinned behavior:
 *   - happy path: frigate client's deleteEvent is called with the id,
 *     route answers { status: "deleted", event: id },
 *   - Frigate "event_not_found" sentinel → 404,
 *   - any other Frigate failure → 502 passthrough,
 *   - role guard: the MCP service principal (`_service:mcp`) is admitted
 *     (the delete_clip LLM tool dispatches through it); a guest is 403 and
 *     Frigate is never touched.
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

// Heavy modules the cameras router imports — stubbed so import succeeds. Only
// frigate.client's deleteEvent is exercised by the route under test.
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
vi.mock("../services/nextcloud.client.js", () => ({
  ncCreateDirectory: vi.fn(), ncUploadFile: vi.fn(), ncDownloadFile: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("nctok"),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { deleteEvent } from "../services/frigate.client.js";
import type { AuthUser } from "../middleware/auth.js";

const mockDeleteEvent = vi.mocked(deleteEvent);

const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const guest: AuthUser = {
  id: "u-guest", username: "guest", displayName: "guest", role: "guest",
};

function buildApp(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter({} as unknown as PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteEvent.mockResolvedValue(undefined);
});

describe("DELETE /api/cameras/events/:eventId", () => {
  it("happy path: calls the frigate client with the id and answers deleted", async () => {
    const res = await request(buildApp(owner)).delete(
      "/api/cameras/events/1719000000.123456-abc123",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "deleted",
      event: "1719000000.123456-abc123",
    });
    expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteEvent).toHaveBeenCalledWith("1719000000.123456-abc123");
  });

  it("404 when Frigate reports the event does not exist", async () => {
    mockDeleteEvent.mockRejectedValue(new Error("event_not_found"));
    const res = await request(buildApp(owner)).delete("/api/cameras/events/nope-1");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
  });

  it("502 passthrough on any other Frigate failure", async () => {
    mockDeleteEvent.mockRejectedValue(new Error("Frigate event delete: 500"));
    const res = await request(buildApp(owner)).delete("/api/cameras/events/ev-1");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Frigate event delete: 500" });
  });

  it("400 on a malformed event id, without touching Frigate", async () => {
    const res = await request(buildApp(owner)).delete(
      `/api/cameras/events/${encodeURIComponent("not ok/../id")}`,
    );

    expect(res.status).toBe(400);
    expect(mockDeleteEvent).not.toHaveBeenCalled();
  });

  describe("role guard (real requireRoleOrMcpService)", () => {
    it("admits the MCP service principal — the delete_clip tool's dispatch identity", async () => {
      const res = await request(buildApp(mcpPrincipal)).delete("/api/cameras/events/ev-2");

      expect(res.status).toBe(200);
      expect(mockDeleteEvent).toHaveBeenCalledWith("ev-2");
    });

    it("rejects an unauthorized role (guest) with 403 before Frigate is reached", async () => {
      const res = await request(buildApp(guest)).delete("/api/cameras/events/ev-3");

      expect(res.status).toBe(403);
      expect(mockDeleteEvent).not.toHaveBeenCalled();
    });
  });
});

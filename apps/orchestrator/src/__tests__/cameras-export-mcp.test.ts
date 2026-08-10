/**
 * POST /api/cameras/:name/clips/export — WARP-1439 MCP-callable export route.
 *
 * Scaffolding copied from `cameras-delete-event.test.ts` (itself from
 * `clips-share-confirmation.routes.test.ts`): mount ONLY createCamerasRouter
 * behind a req.user-injecting shim, keep the REAL auth guards
 * (requireRole / requireRoleOrMcpService) so the role matrix is exercised
 * for real, and mock the heavy service modules the router imports.
 *
 * Pinned behavior:
 *   - the MCP service principal (`_service:mcp`) is admitted and its
 *     Nextcloud credential is resolved from the X-Nextcloud-Token /
 *     X-Nextcloud-User headers (same posture as the /api/files routes,
 *     WARP-861) — the export_clip LLM tool dispatches through it,
 *   - the MCP principal WITHOUT the NC token header → 401
 *     nextcloud_session_missing (fail-closed, no default identity),
 *   - the MCP principal with a token but no NC user header → 401
 *     unauthenticated,
 *   - guest → 403 before the clips service is reached,
 *   - human sessions are unchanged: session-based resolveNcToken +
 *     req.user.username, with any NC headers a human sends IGNORED.
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
// clips.service's exportClip is exercised by the route under test.
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
  resolveNcToken: vi.fn().mockResolvedValue("session-nc-token"),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn(), signShareUrl: vi.fn(), verifyShareUrl: vi.fn(),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { exportClip } from "../services/clips.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mockExportClip = vi.mocked(exportClip);
const mockResolveNcToken = vi.mocked(resolveNcToken);

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

const BODY = { starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" };
const EXPORT_RESULT = { ncPath: "/Clips/front/20260101-000000Z.mp4", bytes: 4096, durationSec: 300 };

beforeEach(() => {
  vi.clearAllMocks();
  mockExportClip.mockResolvedValue(EXPORT_RESULT);
  mockResolveNcToken.mockResolvedValue("session-nc-token");
});

describe("POST /api/cameras/:name/clips/export (WARP-1439 MCP path)", () => {
  it("admits the MCP service principal and resolves the NC credential from the headers", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/cameras/front/clips/export")
      .set("X-Nextcloud-Token", "header-nc-token")
      .set("X-Nextcloud-User", "alice")
      .send(BODY);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(EXPORT_RESULT);
    expect(mockExportClip).toHaveBeenCalledTimes(1);
    expect(mockExportClip).toHaveBeenCalledWith("header-nc-token", "alice", {
      camera: "front",
      startsAt: new Date(BODY.starts_at),
      endsAt: new Date(BODY.ends_at),
    });
    // The service principal's credential comes from the headers, never the
    // session store.
    expect(mockResolveNcToken).not.toHaveBeenCalled();
  });

  it("401 nextcloud_session_missing for the MCP principal without the NC token header", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/cameras/front/clips/export")
      .set("X-Nextcloud-User", "alice")
      .send(BODY);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "nextcloud_session_missing" });
    expect(mockExportClip).not.toHaveBeenCalled();
  });

  it("401 unauthenticated for the MCP principal with a token but no NC user header", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/cameras/front/clips/export")
      .set("X-Nextcloud-Token", "header-nc-token")
      .send(BODY);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
    expect(mockExportClip).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized role (guest) with 403 before the clips service is reached", async () => {
    const res = await request(buildApp(guest))
      .post("/api/cameras/front/clips/export")
      .set("X-Nextcloud-Token", "header-nc-token")
      .set("X-Nextcloud-User", "guest")
      .send(BODY);

    expect(res.status).toBe(403);
    expect(mockExportClip).not.toHaveBeenCalled();
  });

  describe("human-session path (unchanged behavior)", () => {
    it("resolves the NC credential from the session, not headers", async () => {
      const res = await request(buildApp(owner))
        .post("/api/cameras/front/clips/export")
        .send(BODY);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(EXPORT_RESULT);
      expect(mockResolveNcToken).toHaveBeenCalledTimes(1);
      expect(mockExportClip).toHaveBeenCalledWith("session-nc-token", "romain", {
        camera: "front",
        startsAt: new Date(BODY.starts_at),
        endsAt: new Date(BODY.ends_at),
      });
    });

    it("ignores NC headers a human session sends — session identity still rules", async () => {
      const res = await request(buildApp(owner))
        .post("/api/cameras/front/clips/export")
        .set("X-Nextcloud-Token", "spoofed-token")
        .set("X-Nextcloud-User", "someone-else")
        .send(BODY);

      expect(res.status).toBe(201);
      expect(mockExportClip).toHaveBeenCalledWith("session-nc-token", "romain", {
        camera: "front",
        startsAt: new Date(BODY.starts_at),
        endsAt: new Date(BODY.ends_at),
      });
    });

    it("401 nextcloud_session_missing when the session has no NC token", async () => {
      mockResolveNcToken.mockResolvedValue(null);
      const res = await request(buildApp(owner))
        .post("/api/cameras/front/clips/export")
        .send(BODY);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "nextcloud_session_missing" });
      expect(mockExportClip).not.toHaveBeenCalled();
    });
  });
});

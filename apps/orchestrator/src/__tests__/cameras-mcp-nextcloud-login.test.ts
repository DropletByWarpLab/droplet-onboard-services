/**
 * WARP-3117 — the camera routes that write to, or sign a link into, the
 * acting person's Nextcloud act as that person's Nextcloud LOGIN.
 *
 * `_service:mcp` names the person in X-Nextcloud-User: `User.username` on
 * stdio, `User.id` over the HTTP transport, never `User.nextcloudUsername`.
 * Both routes used to take that value verbatim as the WebDAV user:
 *
 *   - POST /cameras/:name/clips/export → exportClip(ncToken, <header>, …),
 *     i.e. /remote.php/dav/files/<User.id>/Clips/… over HTTP;
 *   - POST /cameras/clips/share → signShareUrl(<header>, …), whose subject the
 *     public download route reads back as the WebDAV user.
 *
 * The person is now resolved (`resolveAssertedUser`) and mapped to their
 * `nextcloudUsername`. A person with none — every SSO / SCIM row — has no
 * Nextcloud account and is refused before any WebDAV call or token mint.
 *
 * Share is Tier-2, so the MCP principal's first call stops at a 202 and a
 * human's confirmation signs for that human. The header reaches the signer
 * only on the Tier-1 fallthrough, which is what `evaluateNetworkCommand` is
 * stubbed to return here.
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

// Heavy modules the cameras router imports — stubbed so import succeeds.
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
vi.mock("../services/network-safety.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/network-safety.service.js")>()),
  evaluateNetworkCommand: vi.fn(),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";
import { exportClip, signShareUrl } from "../services/clips.service.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mockExportClip = vi.mocked(exportClip);
const mockSignShareUrl = vi.mocked(signShareUrl);
const mockEvaluate = vi.mocked(evaluateNetworkCommand);

// Owners, so the per-camera guard in front of export sees every camera and the
// Nextcloud mapping is the only thing under test. ALICE's login differs from
// her handle, as ADR-013 allows.
const ALICE: DirectoryUser = { id: "u-alice", username: "alice", nextcloudUsername: "alice.nc", role: "owner" };
// SSO / SCIM-provisioned: an active owner with no Nextcloud account.
const CAROL: DirectoryUser = { id: "u-carol", username: "carol", nextcloudUsername: null, role: "owner" };
// "sam" is SAM's username and SAMANTHA's Nextcloud login: two people.
const SAM: DirectoryUser = { id: "u-sam", username: "sam", nextcloudUsername: "samuel", role: "owner" };
const SAMANTHA: DirectoryUser = { id: "u-samantha", username: "samantha", nextcloudUsername: "sam", role: "owner" };
const GONE: DirectoryUser = { id: "u-gone", username: "gone", nextcloudUsername: "gone", role: "owner", directoryStatus: "DEACTIVATED" };

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};

function buildApp(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter({
    user: userDirectory([ALICE, CAROL, SAM, SAMANTHA, GONE]),
    cameraAccessGrant: { findMany: async () => [] },
  } as unknown as PrismaClient));
  return app;
}

const EXPORT_BODY = { starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-01T00:05:00Z" };
const EXPORT_RESULT = { ncPath: "/Clips/front/20260101-000000Z.mp4", bytes: 4096, durationSec: 300 };
const SHARE_BODY = { nc_path: "/Clips/front/x.mp4", ttl_minutes: 60 };

beforeEach(() => {
  vi.clearAllMocks();
  mockExportClip.mockResolvedValue(EXPORT_RESULT);
  mockSignShareUrl.mockReturnValue("signed-token");
  mockEvaluate.mockResolvedValue({ allowed: true, tier: 1 });
});

function exportAs(asserted: string) {
  return request(buildApp(mcpPrincipal))
    .post("/api/cameras/front/clips/export")
    .set("X-Nextcloud-Token", "header-nc-token")
    .set("X-Nextcloud-User", asserted)
    .send(EXPORT_BODY);
}

function shareAs(asserted: string) {
  return request(buildApp(mcpPrincipal))
    .post("/api/cameras/clips/share")
    .set("X-Nextcloud-User", asserted)
    .send(SHARE_BODY);
}

describe("POST /api/cameras/:name/clips/export — the MCP principal exports as the person's Nextcloud login", () => {
  it("maps a User.id (the HTTP transport) to the Nextcloud login", async () => {
    const res = await exportAs("u-alice");

    expect(res.status).toBe(201);
    expect(mockExportClip).toHaveBeenCalledWith("header-nc-token", "alice.nc", {
      camera: "front",
      startsAt: new Date(EXPORT_BODY.starts_at),
      endsAt: new Date(EXPORT_BODY.ends_at),
    });
  });

  it("maps a username (stdio) to the Nextcloud login, not the username", async () => {
    const res = await exportAs("alice");

    expect(res.status).toBe(201);
    expect(mockExportClip).toHaveBeenCalledWith("header-nc-token", "alice.nc", expect.anything());
  });

  it("refuses an SSO / SCIM person with 403 no_nextcloud_account, before any WebDAV write", async () => {
    const res = await exportAs("u-carol");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_nextcloud_account");
    expect(mockExportClip).not.toHaveBeenCalled();
  });

  // The per-camera guard in front of this route resolves the same header with
  // the same resolver and answers first (404, "Camera not found"); these pin
  // that nothing reaches the export either way.
  it("refuses a value naming two people", async () => {
    const res = await exportAs("sam");

    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(mockExportClip).not.toHaveBeenCalled();
  });

  it("refuses a deactivated person", async () => {
    const res = await exportAs("u-gone");

    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(mockExportClip).not.toHaveBeenCalled();
  });
});

describe("POST /api/cameras/clips/share — the MCP principal signs for the person's Nextcloud login", () => {
  it("maps a User.id (the HTTP transport) to the Nextcloud login in the signed token", async () => {
    const res = await shareAs("u-alice");

    expect(res.status).toBe(200);
    expect(mockSignShareUrl).toHaveBeenCalledWith("alice.nc", "/Clips/front/x.mp4", 3600);
  });

  it("maps a username (stdio) to the Nextcloud login, not the username", async () => {
    const res = await shareAs("alice");

    expect(res.status).toBe(200);
    expect(mockSignShareUrl).toHaveBeenCalledWith("alice.nc", "/Clips/front/x.mp4", 3600);
  });

  it("refuses a value naming two people with 403, before a confirmation is parked", async () => {
    const res = await shareAs("sam");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "ambiguous" });
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockSignShareUrl).not.toHaveBeenCalled();
  });

  it("refuses an SSO / SCIM person with 403 no_nextcloud_account, before a confirmation is parked", async () => {
    const res = await shareAs("u-carol");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("no_nextcloud_account");
    expect(mockEvaluate).not.toHaveBeenCalled();
    expect(mockSignShareUrl).not.toHaveBeenCalled();
  });

  it("refuses a deactivated person", async () => {
    const res = await shareAs("u-gone");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "deactivated" });
    expect(mockSignShareUrl).not.toHaveBeenCalled();
  });

  it("refuses a value naming nobody", async () => {
    const res = await shareAs("u-nobody");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "asserted_user_unresolved", reason: "not_found" });
    expect(mockSignShareUrl).not.toHaveBeenCalled();
  });
});

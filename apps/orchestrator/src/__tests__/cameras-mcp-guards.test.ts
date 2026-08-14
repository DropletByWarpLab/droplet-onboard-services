/**
 * WARP-1440 — MCP-principal admission on the camera write routes the
 * set_camera_detection / set_detection_zones LLM tools dispatch through.
 *
 * The tools present the `_service:mcp` principal (role "service"), which
 * plain requireRole 403s — the exact dead-tool class WARP-1439 fixed for
 * the event/clip tools. These tests pin that the four guards stay
 * requireRoleOrMcpService: /enable, /disable (202 mint), /command/confirm
 * (handshake completion), and PATCH /settings. Scaffolding per
 * cameras-delete-event.test.ts: real auth guards, heavy services mocked.
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
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));
// WARP-1462: the scan route proxies camera-discovery via internalFetch; mock it
// so the guard-admission assertions never touch the network.
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: vi.fn(),
  internalBaseUrl: (u: string) => u,
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { enableDetection, disableDetection } from "../services/frigate.client.js";
import { updateCameraSettings } from "../services/camera-settings.service.js";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
} from "../services/network-safety.service.js";
import { internalFetch } from "../lib/internal-tls.js";
import type { AuthUser } from "../middleware/auth.js";

const mockEnable = vi.mocked(enableDetection);
const mockDisable = vi.mocked(disableDetection);
const mockUpdateSettings = vi.mocked(updateCameraSettings);
const mockEvaluate = vi.mocked(evaluateNetworkCommand);
const mockConfirm = vi.mocked(confirmNetworkCommand);
const mockInternalFetch = vi.mocked(internalFetch);

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const guest: AuthUser = {
  id: "u-guest", username: "guest", displayName: "guest", role: "guest",
};

const prismaShim = {
  // WARP-1975: camera routes now scope to the ACTING human behind the MCP
  // principal, resolved from X-Nextcloud-User. Without a user table the
  // resolution throws and the guard fails CLOSED with a 503 — correct
  // behaviour, wrong test fixture. Model what production has.
  user: {
    findUnique: vi.fn(async ({ where }: { where: { nextcloudUsername?: string } }) =>
      where.nextcloudUsername
        ? { id: `u-${where.nextcloudUsername}`, role: "owner" }
        : null,
    ),
  },
  cameraAccessGrant: { findMany: vi.fn(async () => []) },
  camera: {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
} as unknown as PrismaClient;

function buildApp(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prismaShim));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnable.mockResolvedValue(undefined);
  mockDisable.mockResolvedValue(undefined);
});

describe("camera write-route guards admit the MCP service principal (WARP-1440)", () => {
  it("POST /cameras/:name/enable — MCP principal toggles inline", async () => {
    const res = await request(buildApp(mcpPrincipal)).post("/api/cameras/front/enable")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "enabled", camera: "front" });
    expect(mockEnable).toHaveBeenCalledWith("front");
  });

  it("POST /cameras/:name/disable — MCP principal gets the Tier-2 202 mint", async () => {
    mockEvaluate.mockResolvedValue({
      requiresConfirmation: true, confirmationToken: "tok-1", reason: "tier2", tier: 2,
    } as never);
    const res = await request(buildApp(mcpPrincipal)).post("/api/cameras/front/disable")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");

    expect(res.status).toBe(202);
    expect(res.body.confirmationToken).toBe("tok-1");
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it("POST /cameras/command/confirm — MCP principal completes the handshake", async () => {
    mockConfirm.mockResolvedValue({
      confirmed: true, operation: "disable_camera", params: { name: "front" },
    } as never);
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/cameras/command/confirm")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice")
      .send({ confirmationToken: "tok-1", operation: "disable_camera" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", operation: "disable_camera", confirmed: true });
    expect(mockConfirm).toHaveBeenCalledWith(
      prismaShim, "tok-1", "_service:mcp", { operation: "disable_camera" },
    );
    expect(mockDisable).toHaveBeenCalledWith("front");
  });

  it("PATCH /cameras/:name/settings — MCP principal reaches the settings service", async () => {
    mockUpdateSettings.mockResolvedValue({ ok: true } as never);
    const res = await request(buildApp(mcpPrincipal))
      .patch("/api/cameras/front/settings")
      .set("X-Nextcloud-User", "alice")
      .send({ zones: [] });

    // Pin guard admission only: whatever the settings handler answers, it
    // must not be an auth rejection, and the service must have been reached.
    expect([401, 403]).not.toContain(res.status);
    expect(mockUpdateSettings).toHaveBeenCalled();
  });

  it("human roles unchanged: owner enable 200, guest enable 403 without Frigate", async () => {
    const ok = await request(buildApp(owner)).post("/api/cameras/front/enable")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");
    expect(ok.status).toBe(200);

    const denied = await request(buildApp(guest)).post("/api/cameras/front/enable")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");
    expect(denied.status).toBe(403);
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });
});

describe("POST /cameras/scan guard admits the MCP service principal (WARP-1462)", () => {
  it("MCP principal reaches the scan proxy (not 401/403)", async () => {
    mockInternalFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 0, pending: 0 }), {
        status: 200,
      }),
    );
    const res = await request(buildApp(mcpPrincipal)).post("/api/cameras/scan")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");

    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("scan_complete");
    expect(mockInternalFetch).toHaveBeenCalled();
  });

  it("human roles unchanged: owner reaches the proxy, guest is 403", async () => {
    mockInternalFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "scan_complete", known: 0, pending: 0 }), {
        status: 200,
      }),
    );
    const ok = await request(buildApp(owner)).post("/api/cameras/scan")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");
    expect(ok.status).toBe(200);

    const denied = await request(buildApp(guest)).post("/api/cameras/scan")
      // WARP-1975: camera routes scope to the acting human; the real
      // tools assert one, so the test must too.
      .set("X-Nextcloud-User", "alice");
    expect(denied.status).toBe(403);
    // Guest is rejected at the guard — the sweep only ran for the owner call.
    // Asserted on the URL rather than a total call count: WARP-1847 made an
    // authorized scan also read back the candidate list (/cameras/discovered +
    // /cameras/known) so the response can carry what it found, so the total is
    // no longer 1-per-scan. The guard contract is that /scan itself is reached
    // exactly once — by the owner, never by the guest.
    const scanCalls = mockInternalFetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/scan"),
    );
    expect(scanCalls).toHaveLength(1);
  });
});

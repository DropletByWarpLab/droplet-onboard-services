/**
 * /cameras/command/confirm route wiring (WARP-861).
 *
 * Covers the four review findings fixed in this branch:
 *   F1 – userId undefined → 401 UNAUTHENTICATED before confirmNetworkCommand.
 *   F2 – (dashboard-side; no orchestrator coverage needed here)
 *   F3 – Tier-2 202 bodies include the `operation` field.
 *   F4 – camera_subnet_setup uses ?? (not ||) so vlanId/dhcpStart/dhcpLimit=0
 *         passes through to the routing service rather than being replaced by
 *         the hardcoded defaults.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    FRIGATE_URL: "http://frigate.test",
    ROUTING_SERVICE_URL: "http://routing.test",
    CAMERA_DISCOVERY_URL: "http://discovery.test",
    SERVICE_SECRET: "",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

// camera.service — only the confirm-handler branches need reconcile + isInitialized.
vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn().mockResolvedValue([]),
  getEventsFiltered: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
  getRecentEvents: vi.fn().mockResolvedValue([]),
  getRecordings: vi.fn().mockResolvedValue([]),
  getRecordingsSummary: vi.fn().mockResolvedValue([]),
  getReviewsFiltered: vi.fn().mockResolvedValue({ reviews: [], nextCursor: null }),
  getStats: vi.fn().mockResolvedValue({}),
  getTimelineEntries: vi.fn().mockResolvedValue([]),
  searchEventsSemanticTyped: vi.fn().mockResolvedValue({ events: [] }),
  setEventRetention: vi.fn().mockResolvedValue(undefined),
  setReviewViewed: vi.fn().mockResolvedValue(undefined),
  subscribeCameraEvents: vi.fn().mockReturnValue(() => {}),
  isInitialized: vi.fn().mockReturnValue(true),
}));

// frigate.client — only the ops exercised by confirm's switch cases.
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(),
  fetchEventThumbnail: vi.fn(),
  fetchKnownFaces: vi.fn().mockResolvedValue([]),
  fetchKnownPlates: vi.fn().mockResolvedValue([]),
  fetchFaceImage: vi.fn(),
  deleteKnownFace: vi.fn().mockResolvedValue(undefined),
  deleteFaceImage: vi.fn().mockResolvedValue(undefined),
  deleteKnownPlate: vi.fn().mockResolvedValue(undefined),
  nameKnownPlate: vi.fn().mockResolvedValue(undefined),
  regenerateEventDescription: vi.fn().mockResolvedValue(undefined),
  tagEventAsFace: vi.fn().mockResolvedValue(undefined),
  openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(),
  enableDetection: vi.fn().mockResolvedValue(undefined),
  disableDetection: vi.fn().mockResolvedValue(undefined),
  deleteCamera: vi.fn().mockResolvedValue(undefined),
  addCamera: vi.fn().mockResolvedValue(true),
  syncCamerasFromDb: vi.fn().mockResolvedValue([]),
  fetchEvents: vi.fn().mockResolvedValue([]),
  buildRecordingClipUrl: vi.fn().mockReturnValue("http://frigate.test/clip.mp4"),
  buildVodMasterUrl: vi.fn().mockReturnValue("http://frigate.test/master.m3u8"),
  buildVodSegmentUrl: vi.fn().mockReturnValue("http://frigate.test/seg.ts"),
  fetchHlsPlaylist: vi.fn(),
  fetchPtzCapabilities: vi.fn().mockResolvedValue({}),
  ptzGoToPreset: vi.fn().mockResolvedValue(undefined),
  ptzMove: vi.fn().mockResolvedValue(undefined),
  restartFrigate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/camera-retention-purge.service.js", () => ({
  loadCameraRetentionPolicy: vi.fn().mockResolvedValue({ clipDays: 14, eventDays: null }),
}));

vi.mock("../lib/pipe-upstream.js", () => ({
  pipeUpstreamBody: vi.fn(),
}));

vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn().mockResolvedValue({ job_id: "j1" }),
  signShareUrl: vi.fn().mockReturnValue("tok"),
  verifyShareUrl: vi.fn(),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncDownloadFile: vi.fn(),
}));

vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: vi.fn().mockResolvedValue([]),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  addMembers: vi.fn(),
  removeMember: vi.fn(),
  isValidGroupName: vi.fn().mockReturnValue(true),
  isValidGroupIcon: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/camera-pins.service.js", () => ({
  listPins: vi.fn().mockResolvedValue([]),
  addPin: vi.fn().mockResolvedValue({ id: "p1" }),
  removePin: vi.fn().mockResolvedValue(undefined),
  reorderPins: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn().mockResolvedValue({}),
  updateCameraSettings: vi.fn().mockResolvedValue({}),
}));

const evalMock = vi.fn();
const confirmMock = vi.fn();
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: (...args: unknown[]) => evalMock(...args),
  confirmNetworkCommand: (...args: unknown[]) => confirmMock(...args),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import * as frigateClient from "../services/frigate.client.js";
import type { AuthUser } from "../middleware/auth.js";

// Minimal Prisma double — only the methods touched by confirm-handler cases.
const prismaMock = {
  camera: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  cameraNotificationPref: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
  },
};

function buildApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prismaMock as never));
  return app;
}

const owner: AuthUser = { id: "u-owner", role: "owner", username: "owner" } as AuthUser;
// A user whose JWT set no id field (id is undefined).
const noId: AuthUser = { id: undefined as unknown as string, role: "owner", username: "owner" } as AuthUser;

beforeEach(() => {
  vi.clearAllMocks();
  evalMock.mockResolvedValue({
    requiresConfirmation: true,
    confirmationToken: "tok-abc",
    reason: "requires confirmation",
    tier: 2,
  });
  confirmMock.mockResolvedValue({
    confirmed: true,
    operation: "delete_camera",
    params: { name: "front-door" },
  });
});

// ---------------------------------------------------------------------------
// F1 — userId undefined → 401 UNAUTHENTICATED
// ---------------------------------------------------------------------------

describe("F1 — missing userId → 401 before confirmNetworkCommand", () => {
  it("returns 401 UNAUTHENTICATED when req.user.id is undefined", async () => {
    const res = await request(buildApp(noId))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "delete_camera" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("UNAUTHENTICATED");
    // The ownership check must NOT have been called.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("passes through to confirmNetworkCommand when req.user.id is present", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "delete_camera" });

    expect(res.status).toBe(200);
    expect(confirmMock).toHaveBeenCalledWith(
      expect.anything(),
      "tok-abc",
      "u-owner",
      { operation: "delete_camera" },
    );
  });
});

// ---------------------------------------------------------------------------
// F3 — Tier-2 202 bodies include the `operation` field
// ---------------------------------------------------------------------------

describe("F3 — Tier-2 202 responses include the operation field", () => {
  it("POST /cameras/:name/disable 202 includes operation: disable_camera", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/front-door/disable");

    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("disable_camera");
    expect(res.body.confirmationToken).toBe("tok-abc");
  });

  it("DELETE /cameras/:name 202 includes operation: delete_camera", async () => {
    const res = await request(buildApp(owner))
      .delete("/api/cameras/front-door");

    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("delete_camera");
    expect(res.body.confirmationToken).toBe("tok-abc");
  });

  it("POST /cameras/subnet/setup 202 includes operation: camera_subnet_setup", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/subnet/setup")
      .send({ vlanId: 100 });

    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("camera_subnet_setup");
    expect(res.body.confirmationToken).toBe("tok-abc");
  });

  it("DELETE /cameras/subnet 202 includes operation: camera_subnet_teardown", async () => {
    const res = await request(buildApp(owner))
      .delete("/api/cameras/subnet");

    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("camera_subnet_teardown");
    expect(res.body.confirmationToken).toBe("tok-abc");
  });

  it("POST /cameras/system/restart 202 includes operation: restart_frigate", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/system/restart");

    expect(res.status).toBe(202);
    expect(res.body.operation).toBe("restart_frigate");
    expect(res.body.confirmationToken).toBe("tok-abc");
  });
});

// ---------------------------------------------------------------------------
// F4 — ?? coalescing: vlanId/dhcpStart/dhcpLimit = 0 must not fall back to defaults
// ---------------------------------------------------------------------------

describe("F4 — camera_subnet_setup confirm uses ?? not || for numeric DHCP params", () => {
  it("vlanId=0 passes 0 to the routing service, not the hardcoded default 100", async () => {
    // Arrange: confirmNetworkCommand resolves with stored params containing 0 values.
    confirmMock.mockResolvedValue({
      confirmed: true,
      operation: "camera_subnet_setup",
      params: {
        vlanId: 0,
        subnet: "192.168.100.1",
        netmask: "255.255.255.0",
        dhcpStart: 0,
        dhcpLimit: 0,
        leasetime: "12h",
      },
    });

    // Intercept the outbound fetch to the routing service.
    // Cast to the global fetch Response (not Express Response) via unknown.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) } as any);

    const res = await request(buildApp(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "camera_subnet_setup" });

    expect(res.status).toBe(200);

    // Inspect the body forwarded to the routing service.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [_url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const forwarded = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(forwarded.vlan_id).toBe(0);
    expect(forwarded.dhcp_start).toBe(0);
    expect(forwarded.dhcp_limit).toBe(0);

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Confirm executes the right downstream ops (smoke-tests)
// ---------------------------------------------------------------------------

describe("confirm executes the right camera operation", () => {
  it("delete_camera: calls frigateClient.deleteCamera + prisma.camera.deleteMany", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "delete_camera" });

    expect(res.status).toBe(200);
    expect(frigateClient.deleteCamera).toHaveBeenCalledWith("front-door");
    expect(prismaMock.camera.deleteMany).toHaveBeenCalledWith({ where: { name: "front-door" } });
  });

  it("disable_camera: calls frigateClient.disableDetection + prisma.camera.updateMany", async () => {
    confirmMock.mockResolvedValue({
      confirmed: true,
      operation: "disable_camera",
      params: { name: "backyard" },
    });

    const res = await request(buildApp(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "disable_camera" });

    expect(res.status).toBe(200);
    expect(frigateClient.disableDetection).toHaveBeenCalledWith("backyard");
    expect(prismaMock.camera.updateMany).toHaveBeenCalledWith({
      where: { name: "backyard" },
      data: { enabled: false },
    });
  });

  it("unknown operation → 400", async () => {
    confirmMock.mockResolvedValue({
      confirmed: true,
      operation: "noop_unknown",
      params: {},
    });

    const res = await request(buildApp(owner))
      .post("/api/cameras/command/confirm")
      .send({ confirmationToken: "tok-abc", operation: "noop_unknown" });

    expect(res.status).toBe(400);
  });
});

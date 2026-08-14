/**
 * POST /api/cameras/clips/share — Tier-2 confirmation gate.
 *
 * Sharing a clip mints a public "anyone with the link" signed URL to private
 * footage. The route must NOT sign a URL on the first call: it runs the
 * request through the REAL network-safety evaluator (kept un-mocked here) and
 * answers 202 `confirmation_required`. The signed URL is produced only after a
 * human echoes the token back as `confirmation_token`.
 *
 * Security invariant pinned here: the MCP service principal (the AI's
 * dispatch identity) can mint a 202 but can NEVER confirm — re-issuing with
 * the token as `_service:mcp` is 403. So the agent cannot share a clip in a
 * single (or any) unattended tool call.
 *
 * Completion invariant pinned here: the agent PROPOSES, a human DISPOSES.
 * When the MCP principal mints the 202, a DIFFERENT authorized human (owner)
 * must be able to confirm it and receive the signed URL. The pending-token
 * store is module-global, so a token minted by the MCP-principal app can be
 * confirmed by the owner app — exactly the cross-identity agent→human flow.
 *
 * We keep network-safety.service + clips.service REAL and mock only the
 * Frigate / Nextcloud / config dependencies the cameras router drags in, so
 * the assertions exercise the actual confirmation logic end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Heavy modules the cameras router imports — stubbed so import succeeds. None
// of their exports are exercised by the share route under test.
vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(), getEventsFiltered: vi.fn(), getRecentEvents: vi.fn(),
  getRecordings: vi.fn(), getRecordingsSummary: vi.fn(), getReviewsFiltered: vi.fn(),
  getStats: vi.fn(), getTimelineEntries: vi.fn(), searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(), setReviewViewed: vi.fn(), subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true),
}));
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: vi.fn(), fetchEventThumbnail: vi.fn(), fetchKnownFaces: vi.fn(),
  fetchKnownPlates: vi.fn(), fetchFaceImage: vi.fn(), deleteKnownFace: vi.fn(),
  deleteFaceImage: vi.fn(), deleteKnownPlate: vi.fn(), nameKnownPlate: vi.fn(),
  regenerateEventDescription: vi.fn(), tagEventAsFace: vi.fn(), openBirdseyeStream: vi.fn(),
  openMjpegStream: vi.fn(), enableDetection: vi.fn(), disableDetection: vi.fn(),
  deleteCamera: vi.fn(), addCamera: vi.fn(), syncCamerasFromDb: vi.fn().mockResolvedValue([]),
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
import type { AuthUser } from "../middleware/auth.js";

const ORIGINAL_SECRET = process.env.DEVICE_SECRET;

function createPrismaMock(): PrismaClient {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const owner: AuthUser = {
  id: "u-owner", username: "stefan", displayName: "stefan", role: "owner",
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
  app.use("/api", createCamerasRouter(createPrismaMock()));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEVICE_SECRET = "test-secret-do-not-use-in-prod";
});

describe("POST /api/cameras/clips/share — first (unconfirmed) call", () => {
  it("an owner gets a 202 confirmation_required with a token, NO signed URL", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", ttl_minutes: 60 });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      operation: "share_clip",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(res.body.url).toBeUndefined();
  });

  it("the MCP principal also gets only a 202 — it cannot sign a URL in one call", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/cameras/clips/share")
      .set("X-Nextcloud-User", "stefan")
      .send({ nc_path: "/Clips/front/x.mp4" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    expect(res.body.url).toBeUndefined();
  });

  it("a guest is 403 (RBAC unchanged)", async () => {
    const res = await request(buildApp(guest))
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4" });
    expect(res.status).toBe(403);
  });

  it("rejects a traversal nc_path before minting any token (400)", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/../../etc/passwd" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cameras/clips/share — confirmation re-issue", () => {
  it("an owner who confirms the minted token gets the signed URL", async () => {
    const app = buildApp(owner);
    const first = await request(app)
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", ttl_minutes: 60 });
    expect(first.status).toBe(202);
    const token = first.body.confirmationToken as string;

    const second = await request(app)
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", ttl_minutes: 60, confirmation_token: token });
    expect(second.status).toBe(200);
    expect(second.body.url).toContain("/api/cameras/clips/share/");
    expect(second.body.expires_at).toBeTruthy();
  });

  it("the REAL agent flow: MCP mints, a DIFFERENT human (owner) confirms → 200 + signed URL", async () => {
    // The agent dispatches share_clip through the MCP principal, which mints
    // the 202 under "_service:mcp" and forwards the originating human's NC
    // user in X-Nextcloud-User. Before the fix this confirmation dead-ended
    // at 400 TOKEN_USER_MISMATCH because the human owner's id != the minter's
    // "_service:mcp". The token store is module-global, so the owner app
    // confirms the MCP-minted token.
    const mcpApp = buildApp(mcpPrincipal);
    const first = await request(mcpApp)
      .post("/api/cameras/clips/share")
      .set("X-Nextcloud-User", "stefan")
      .send({ nc_path: "/Clips/front/x.mp4", ttl_minutes: 60 });
    expect(first.status).toBe(202);
    expect(first.body.url).toBeUndefined();
    const token = first.body.confirmationToken as string;
    expect(token).toBeTruthy();

    const ownerApp = buildApp(owner);
    const second = await request(ownerApp)
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", ttl_minutes: 60, confirmation_token: token });
    expect(second.status).toBe(200);
    expect(second.body.url).toContain("/api/cameras/clips/share/");
    expect(second.body.expires_at).toBeTruthy();
  });

  it("an UNAUTHORIZED user (guest) cannot confirm an agent-minted share (403)", async () => {
    // The route guard (requireRoleOrMcpService owner/admin/family) rejects a
    // guest before the handler runs, so a guest can never dispose of an
    // agent-proposed share even with a valid token.
    const mcpApp = buildApp(mcpPrincipal);
    const first = await request(mcpApp)
      .post("/api/cameras/clips/share")
      .set("X-Nextcloud-User", "stefan")
      .send({ nc_path: "/Clips/front/x.mp4" });
    expect(first.status).toBe(202);
    const token = first.body.confirmationToken as string;

    const second = await request(buildApp(guest))
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", confirmation_token: token });
    expect(second.status).toBe(403);
    expect(second.body.url).toBeUndefined();
  });

  it("the MCP principal CANNOT self-confirm even with a valid token (403)", async () => {
    // Mint a token as the MCP principal, then try to confirm it as the MCP
    // principal — the agent self-approving would defeat the whole gate.
    const app = buildApp(mcpPrincipal);
    const first = await request(app)
      .post("/api/cameras/clips/share")
      .set("X-Nextcloud-User", "stefan")
      .send({ nc_path: "/Clips/front/x.mp4" });
    expect(first.status).toBe(202);
    const token = first.body.confirmationToken as string;

    const second = await request(app)
      .post("/api/cameras/clips/share")
      .set("X-Nextcloud-User", "stefan")
      .send({ nc_path: "/Clips/front/x.mp4", confirmation_token: token });
    expect(second.status).toBe(403);
    expect(second.body.url).toBeUndefined();
  });

  it("a bad/unknown token is rejected (400 TOKEN_MISSING), no URL", async () => {
    const res = await request(buildApp(owner))
      .post("/api/cameras/clips/share")
      .send({ nc_path: "/Clips/front/x.mp4", confirmation_token: "no-such-token" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_MISSING");
    expect(res.body.url).toBeUndefined();
  });
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.DEVICE_SECRET;
  else process.env.DEVICE_SECRET = ORIGINAL_SECRET;
});

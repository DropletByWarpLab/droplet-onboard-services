/**
 * WARP-3927 — GET /api/cameras/:name/recordings/snapshot?at=<epoch seconds>
 *
 * One still FROM RECORDED FOOTAGE at an instant, for the chat's "show me the
 * front door at 6:40" (get_camera_recording) and for the assistant's own look
 * at it. Same guards as the live /snapshot — role set, `_service:mcp`
 * admission, per-camera ACL, `h` clamp, never cached — plus a clear 404 when no
 * recording covers the instant, and an audit row (it is past footage).
 *
 * Also pins the three MCP admissions the new chat tools need on routes that
 * were dashboard-only: GET /cameras/reviews and GET /cameras/:name/recordings.
 * (GET /cameras/motion is pinned in routes/camera-motion.test.ts.)
 *
 * Real router, real guards, real frigate client; only the network (`fetch`),
 * the activity recorder and the heavy sibling services are stubbed.
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

import { createCamerasRouter } from "../routes/cameras.js";
import { errorHandler } from "../middleware/error-handler.js";
import { recordActivity } from "../services/activity.singleton.js";
import { getRecordings, getReviewsFiltered } from "../services/camera.service.js";
import { resetCameraWatchDedupe } from "../services/camera-watch-audit.js";
import { userDirectory } from "./helpers/user-directory.js";
import type { AuthUser } from "../middleware/auth.js";

const mockRecord = vi.mocked(recordActivity);

const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
const member: AuthUser = { id: "u-member", username: "sam", displayName: "Sam", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "gus", displayName: "Gus", role: "guest" };

// `front` is granted to family members; `bedroom` is not.
const prismaShim = {
  user: userDirectory([
    { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "family" },
    { id: "u-romain", username: "romain", nextcloudUsername: "romain", role: "owner" },
  ]),
  cameraAccessGrant: { findMany: vi.fn(async () => [{ camera: { name: "front" } }]) },
  camera: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
} as unknown as PrismaClient;

function appAs(user: AuthUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prismaShim));
  app.use(errorHandler);
  return app;
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const AT = Math.floor(Date.now() / 1000) - 3600;
const PATH = (cam = "front", qs = `at=${AT}`) => `/api/cameras/${cam}/recordings/snapshot?${qs}`;

let fetchSpy: MockInstance<typeof fetch>;
const settle = () => new Promise((r) => setTimeout(r, 10));
const rows = () => mockRecord.mock.calls.map(([p]) => p);

function frigateAnswers(status: number, body: BodyInit | null = null, headers?: HeadersInit) {
  fetchSpy.mockImplementation(async () => new Response(body, { status, headers }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue({ id: 1n } as never);
  resetCameraWatchDedupe();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  frigateAnswers(200, JPEG, { "content-type": "image/jpeg" });
});
afterEach(() => fetchSpy.mockRestore());

describe("GET /api/cameras/:name/recordings/snapshot", () => {
  it("serves the recorded still, never cached, and asks Frigate for that second at the default height", async () => {
    const res = await request(appAs(member)).get(PATH());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(res.body as Buffer)).toEqual(Buffer.from(JPEG));
    expect(fetchSpy).toHaveBeenCalledWith(
      `http://frigate.test:5000/api/front/recordings/${AT}/snapshot.jpg?height=480`,
      expect.anything(),
    );
  });

  it("truncates a fractional instant to the second", async () => {
    await request(appAs(member)).get(PATH("front", `at=${AT}.9`));
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(`/recordings/${AT}/snapshot.jpg`);
  });

  it.each([
    ["5000", 1080],
    ["99999", 1080],
    ["10", 100],
    ["720", 720],
    ["abc", 480],
    ["0", 480],
  ])("clamps h=%s to a height of %i", async (h, expected) => {
    await request(appAs(member)).get(PATH("front", `at=${AT}&h=${h}`));
    expect(String(fetchSpy.mock.calls[0]![0])).toContain(`height=${expected}`);
  });

  describe("404 when no recording covers the instant", () => {
    it("answers a clear code and message, not a generic error", async () => {
      frigateAnswers(404);
      const res = await request(appAs(member)).get(PATH());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: "recording_snapshot_not_found",
        message: "No recording covers that moment.",
      });
      expect(res.headers["x-droplet-degraded"]).toBeUndefined();
    });

    it("is not audited (nothing was shown)", async () => {
      frigateAnswers(404);
      await request(appAs(member)).get(PATH());
      await settle();
      expect(rows()).toHaveLength(0);
    });

    it.each([500, 502, 503])("a Frigate %i is an outage (503 degraded), not 'no footage'", async (status) => {
      frigateAnswers(status);
      const res = await request(appAs(member)).get(PATH());
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: "frigate_unavailable" });
      expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
    });
  });

  describe("validation", () => {
    it.each([
      ["no at", ""],
      ["non-numeric at", "at=yesterday"],
      ["zero", "at=0"],
      ["negative", "at=-5"],
      ["empty", "at="],
    ])("400 for %s", async (_name, qs) => {
      const res = await request(appAs(member)).get(PATH("front", qs));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "at must be a Unix-second timestamp" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("400 for an instant in the future", async () => {
      const res = await request(appAs(member)).get(PATH("front", `at=${Math.floor(Date.now() / 1000) + 3600}`));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "at is in the future" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("400 for an invalid camera name", async () => {
      const res = await request(appAs(owner)).get(PATH("bad%20name"));
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("who may look", () => {
    it("a guest is refused (403) before anything is fetched", async () => {
      const res = await request(appAs(guest)).get(PATH());
      expect(res.status).toBe(403);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a member sees a camera they were granted, and the owner sees any", async () => {
      expect((await request(appAs(member)).get(PATH("front"))).status).toBe(200);
      expect((await request(appAs(owner)).get(PATH("bedroom"))).status).toBe(200);
    });

    it("a member is refused a camera they were NOT granted (per-camera ACL), with nothing fetched", async () => {
      const res = await request(appAs(member)).get(PATH("bedroom"));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Camera not found" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("the MCP principal is admitted, and scoped to the person it acts for", async () => {
      const asSam = await request(appAs(mcp)).get(PATH("front")).set("X-Nextcloud-User", "sam");
      expect(asSam.status).toBe(200);
      const denied = await request(appAs(mcp)).get(PATH("bedroom")).set("X-Nextcloud-User", "sam");
      expect(denied.status).toBe(404);
      const asOwner = await request(appAs(mcp)).get(PATH("bedroom")).set("X-Nextcloud-User", "romain");
      expect(asOwner.status).toBe(200);
    });

    it("the MCP principal with no asserted person gets nothing", async () => {
      const res = await request(appAs(mcp)).get(PATH("front"));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: "no_asserted_user" });
    });

    it("the MCP principal naming someone who does not exist gets nothing", async () => {
      const res = await request(appAs(mcp)).get(PATH("front")).set("X-Nextcloud-User", "nobody");
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("audit", () => {
    it("writes one signed-log row for the viewer: camera, kind recording", async () => {
      const res = await request(appAs(member)).get(PATH());
      expect(res.status).toBe(200);
      await settle();
      expect(rows()).toHaveLength(1);
      expect(rows()[0].actor).toEqual({ type: "user", id: "u-member" });
      expect(rows()[0].refs).toMatchObject({ camera: "front", watch: "recording" });
    });

    it("dedupes a burst of stills for the same viewer and camera", async () => {
      await request(appAs(member)).get(PATH());
      await request(appAs(member)).get(PATH("front", `at=${AT + 30}`));
      await settle();
      expect(rows()).toHaveLength(1);
    });
  });
});

describe("MCP admission for the routes the camera activity tools read (WARP-3927)", () => {
  it("GET /cameras/reviews admits the MCP principal, scoped to the person it acts for", async () => {
    vi.mocked(getReviewsFiltered).mockResolvedValue({ reviews: [], nextCursor: null });
    const res = await request(appAs(mcp)).get("/api/cameras/reviews").set("X-Nextcloud-User", "sam");
    expect(res.status).toBe(200);
    // the handler narrows with the acting person's scope (front only), not "all"
    const scope = vi.mocked(getReviewsFiltered).mock.calls[0]![1];
    expect([...(scope as unknown as Set<string>)]).toEqual(["front"]);
  });

  it("GET /cameras/reviews still refuses a guest and an MCP call with no person", async () => {
    expect((await request(appAs(guest)).get("/api/cameras/reviews")).status).toBe(403);
    expect((await request(appAs(mcp)).get("/api/cameras/reviews")).status).toBe(401);
  });

  it("GET /cameras/:name/recordings admits the MCP principal for a granted camera and hides an ungranted one", async () => {
    vi.mocked(getRecordings).mockResolvedValue([]);
    const ok = await request(appAs(mcp)).get("/api/cameras/front/recordings?after=1000&before=2000").set("X-Nextcloud-User", "sam");
    expect(ok.status).toBe(200);
    const hidden = await request(appAs(mcp)).get("/api/cameras/bedroom/recordings?after=1000&before=2000").set("X-Nextcloud-User", "sam");
    expect(hidden.status).toBe(404);
  });

  it("GET /cameras/:name/recordings still refuses a guest", async () => {
    expect((await request(appAs(guest)).get("/api/cameras/front/recordings?after=1000&before=2000")).status).toBe(403);
  });
});

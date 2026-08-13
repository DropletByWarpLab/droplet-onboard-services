/**
 * WARP-1961 — nobody unauthorised gets to look at the house.
 *
 * Before this, every route serving camera imagery, footage or event
 * metadata carried NO guard at all. 48 of ~70 camera routes were gated;
 * every one that shows you what is happening inside someone's home was in
 * the ungated remainder — live snapshots, full recorded history, the face
 * and plate rosters, birdseye, event thumbnails.
 *
 * Two kinds of test here, deliberately:
 *
 *  1. BEHAVIOURAL — drive real requests as `guest` and as `family` and
 *     assert the status. This is what actually protects the household.
 *  2. STANDING INVARIANT — walk the built router and assert that EVERY
 *     camera route carries a real role guard. This is what stops the next
 *     route from forgetting; a behavioural test only covers routes someone
 *     remembered to list.
 *
 * The invariant leans on `isRoleGuard`, a marker stamped by the middleware
 * factories. Counting handlers instead would pass for any route that
 * happens to have a validator in front of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Role } from "../services/jwt.service.js";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
    FRIGATE_URL: "http://frigate.test:5000",
    AUTH_ENABLED: true,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// Every service the router imports, stubbed. A handler that DOES run
// returns something harmless; what matters is whether it runs at all.
//
// `vi.hoisted` because vi.mock factories are lifted above ordinary
// top-level consts — a plain `const okAsync = …` is still in its temporal
// dead zone when the first factory runs.
const okAsync = vi.hoisted(() => () => vi.fn().mockResolvedValue([]));
vi.mock("../services/camera.service.js", () => ({
  getCameras: okAsync(),
  getEventsFiltered: okAsync(),
  getRecentEvents: okAsync(),
  getRecordings: okAsync(),
  getRecordingsSummary: okAsync(),
  getReviewsFiltered: okAsync(),
  getStats: vi.fn().mockResolvedValue({}),
  getTimelineEntries: okAsync(),
  searchEventsSemanticTyped: okAsync(),
  setEventRetention: okAsync(),
  setReviewViewed: okAsync(),
  subscribeCameraEvents: vi.fn().mockReturnValue(() => {}),
  isInitialized: vi.fn().mockReturnValue(true),
}));
// Explicit list, not a Proxy: a get-trap that hands back a fresh vi.fn()
// for every property also answers the interop probes the module system
// makes (`then`, Symbol.toStringTag…), which kills the vitest worker
// outright rather than failing a test.
vi.mock("../services/frigate.client.js", () => ({
  fetchSnapshot: okAsync(),
  fetchEventThumbnail: okAsync(),
  fetchEventSnapshot: okAsync(),
  fetchKnownFaces: okAsync(),
  fetchKnownPlates: okAsync(),
  fetchFaceImage: okAsync(),
  deleteKnownFace: okAsync(),
  deleteFaceImage: okAsync(),
  deleteKnownPlate: okAsync(),
  nameKnownPlate: okAsync(),
  regenerateEventDescription: okAsync(),
  tagEventAsFace: okAsync(),
  openBirdseyeStream: okAsync(),
  openMjpegStream: okAsync(),
  enableDetection: okAsync(),
  disableDetection: okAsync(),
  deleteCamera: okAsync(),
  deleteEvent: okAsync(),
  addCamera: okAsync(),
  syncCamerasFromDb: okAsync(),
  fetchEvents: okAsync(),
  fetchReviewPreview: okAsync(),
  fetchReviewThumbnail: okAsync(),
  buildRecordingClipUrl: vi.fn().mockReturnValue("http://frigate.test/clip.mp4"),
  buildVodMasterUrl: vi.fn().mockReturnValue("http://frigate.test/master.m3u8"),
  buildVodSegmentUrl: vi.fn().mockReturnValue("http://frigate.test/0.ts"),
  fetchHlsPlaylist: okAsync(),
  fetchPtzCapabilities: okAsync(),
  ptzGoToPreset: okAsync(),
  ptzMove: okAsync(),
  restartFrigate: okAsync(),
  // Real: the router calls this for validation, and a stub returning a
  // mock object would make the timezone branch behave nonsensically.
  isValidIanaTimezone: (tz: unknown) => typeof tz === "string" && tz.includes("/"),
  NoRecordingsInRangeError: class NoRecordingsInRangeError extends Error {},
}));
vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: vi.fn().mockResolvedValue({ storage: [] }),
}));
vi.mock("../services/camera-storage.service.js", () => ({
  getCameraStorage: vi.fn().mockResolvedValue({ cameras: [], volume: null }),
}));
vi.mock("../services/camera-candidates.service.js", () => ({
  discoveryAuthHeaders: vi.fn().mockReturnValue({}),
  getCameraCandidates: okAsync(),
  macFromCandidateId: vi.fn(),
  mutateLiveCandidate: okAsync(),
}));
vi.mock("../services/camera-budget.service.js", () => ({
  reconcileCameraBudgets: okAsync(),
  checkOverAllocation: vi.fn().mockReturnValue(null),
  parseCeiling: vi.fn().mockReturnValue(null),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: okAsync(),
  confirmNetworkCommand: okAsync(),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: okAsync(),
  signShareUrl: vi.fn().mockReturnValue("t"),
  verifyShareUrl: vi.fn().mockReturnValue(null),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: okAsync() }));
vi.mock("../services/nextcloud.client.js", () => ({ ncDownloadFile: okAsync() }));
vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: okAsync(),
  isValidGroupName: vi.fn().mockReturnValue(true),
  isValidGroupIcon: vi.fn().mockReturnValue(true),
}));
vi.mock("../services/camera-pins.service.js", () => ({ listPins: okAsync() }));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn().mockResolvedValue({}),
  updateCameraSettings: okAsync(),
}));

import { createCamerasRouter, createCameraSharePublicRouter } from "../routes/cameras.js";
import { isRoleGuard } from "../middleware/auth.js";

const prismaStub = {
  camera: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
} as never;

/** Mount the real router behind a fake session of the given role. */
function appAs(role: Role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${role}`, username: role, displayName: role, role };
    next();
  });
  app.use("/api", createCamerasRouter(prismaStub));
  return app;
}

/**
 * The surface a guest must not reach. Not exhaustive by design — the
 * invariant sweep below covers exhaustiveness; this pins the ones that
 * matter most, by name, so a regression reads clearly in CI.
 */
const IMAGERY_AND_FOOTAGE: Array<[string, string]> = [
  ["get", "/api/cameras"],
  ["get", "/api/cameras/front/snapshot"],
  ["get", "/api/cameras/front/live"],
  ["get", "/api/cameras/front/recordings/summary"],
  ["get", "/api/cameras/front/recordings?after=1&before=2"],
  ["get", "/api/cameras/front/timeline?after=1&before=2"],
  ["get", "/api/cameras/front/playback?after=1&before=2"],
  ["get", "/api/cameras/front/playback.m3u8?after=1&before=2"],
  ["get", "/api/cameras/front/playback.segment?after=1&before=2&seg=0.ts"],
  ["get", "/api/cameras/clips"],
  ["get", "/api/cameras/faces"],
  ["get", "/api/cameras/plates"],
  ["get", "/api/cameras/birdseye/live"],
  ["get", "/api/cameras/events"],
  ["get", "/api/cameras/events/recent"],
  ["get", "/api/cameras/events/abc/thumbnail"],
  ["get", "/api/cameras/events/abc/snapshot"],
  ["get", "/api/cameras/system"],
  ["get", "/api/cameras/storage"],
];

/**
 * `/cameras/events/sse` is a live detection stream — thumbnails and labels
 * of what the cameras are seeing, right now. It is gated like the rest, but
 * it cannot be driven through supertest: an SSE handler never ends the
 * response, so the request hangs forever. Its guard is covered by the
 * invariant sweep at the bottom of this file instead. Do NOT "fix" this by
 * adding it to the list above — the suite will simply stop terminating.
 */

/** Taking footage off the box, or destroying it. Family must not. */
const CUSTODY: Array<[string, string]> = [
  ["post", "/api/cameras/front/clips/export"],
  ["post", "/api/cameras/clips/share"],
  ["post", "/api/cameras/events/abc/retain"],
  ["delete", "/api/cameras/events/abc"],
  ["delete", "/api/cameras/faces/sam"],
  ["delete", "/api/cameras/plates/ABC123"],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a guest cannot look at the house", () => {
  it.each(IMAGERY_AND_FOOTAGE)("%s %s → 403 for guest", async (verb, path) => {
    const res = await (request(appAs("guest")) as never as Record<string, (p: string) => Promise<{ status: number }>>)[
      verb
    ](path);
    expect(res.status).toBe(403);
  });

  it.each(IMAGERY_AND_FOOTAGE)("%s %s is reachable for family", async (verb, path) => {
    const res = await (request(appAs("family")) as never as Record<string, (p: string) => Promise<{ status: number }>>)[
      verb
    ](path);
    // Anything but 403 — the handlers are stubbed, so a 400/404/500 from a
    // stub still proves the guard let the request through.
    expect(res.status).not.toBe(403);
  });
});

describe("taking footage off the box is owner/admin only", () => {
  it.each(CUSTODY)("%s %s → 403 for family", async (verb, path) => {
    const res = await (request(appAs("family")) as never as Record<string, (p: string) => Promise<{ status: number }>>)[
      verb
    ](path);
    expect(res.status).toBe(403);
  });

  it.each(CUSTODY)("%s %s is reachable for owner", async (verb, path) => {
    const res = await (request(appAs("owner")) as never as Record<string, (p: string) => Promise<{ status: number }>>)[
      verb
    ](path);
    expect(res.status).not.toBe(403);
  });
});

describe("the standing invariant: no camera route ships ungated", () => {
  function cameraRoutes() {
    const router = createCamerasRouter(prismaStub) as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
    };
    return router.stack
      .map((l) => l.route)
      .filter((r): r is { path: string; stack: Array<{ handle: unknown }> } =>
        Boolean(r) && r!.path.startsWith("/cameras"),
      );
  }

  it("inspects the whole camera surface (guards against a vacuous sweep)", () => {
    // Without this, an empty or mis-shaped router stack would make the
    // assertion below pass while checking nothing at all — the exact
    // failure mode this repo has shipped before.
    expect(cameraRoutes().length).toBeGreaterThan(60);
  });

  it("every camera route on the authenticated router carries a real role guard", () => {
    const ungated = cameraRoutes()
      .filter((r) => !r.stack.some((h) => isRoleGuard(h.handle)))
      .map((r) => r.path);

    // A failure names the offending route. If you are adding a camera route
    // and landed here: give it a guard. There is no allowlist on this
    // router by design — the one genuinely public camera endpoint lives in
    // its own factory (see below), which is what keeps that decision
    // explicit rather than a line in an exceptions array.
    expect(ungated).toEqual([]);
  });

  it("recognises a guard only when the middleware factory made it", () => {
    // Guards the invariant itself: if `isRoleGuard` ever degraded to
    // "is a function", the sweep above would pass for every route.
    expect(isRoleGuard(() => {})).toBe(false);
    expect(isRoleGuard(undefined)).toBe(false);
    expect(isRoleGuard("requireRole")).toBe(false);
  });

  it("keeps the signed share link in its own deliberately public router", () => {
    // `/cameras/clips/share/:filename` is the forwarded-link endpoint: a
    // signed, expiring token in the query IS the authorization, and it is
    // mounted BEFORE auth in app.ts so a recipient with no Droplet session
    // can open it. It must NOT gain a role guard, and it must NOT be on
    // the authenticated router.
    const pub = createCameraSharePublicRouter() as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
    };
    const share = pub.stack.find(
      (l) => l.route?.path === "/cameras/clips/share/:filename",
    );
    expect(share).toBeDefined();
    expect(share!.route!.stack.some((h) => isRoleGuard(h.handle))).toBe(false);

    // …and it is not smuggled onto the authenticated router.
    expect(cameraRoutes().map((r) => r.path)).not.toContain(
      "/cameras/clips/share/:filename",
    );
  });
});

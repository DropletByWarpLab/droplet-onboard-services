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
  // WARP-3103: resolves an event to its camera for the per-camera guard and
  // the watch audit; "front" is granted to family below.
  fetchEventCamera: vi.fn().mockResolvedValue("front"),
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

// WARP-1962: the per-camera guard resolves grants from the DB, so the stub
// has to answer. Without `cameraAccessGrant` the guard fails CLOSED with a
// 503 — and the `family` cases below assert `not.toBe(403)`, which a 503
// satisfies. They would have kept passing while proving nothing about the
// role gate, which is precisely the shape of test this repo has been bitten
// by. Grant `family` every camera these cases touch so a 403 can only come
// from the ROLE tier, which is what this file is about.
const GRANTED_TO_FAMILY = ["front", "front_door", "driveway", "bedroom"];

const prismaStub = {
  camera: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  cameraAccessGrant: {
    findMany: vi.fn(async () =>
      GRANTED_TO_FAMILY.map((name) => ({ camera: { name } })),
    ),
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
  // WARP-3103: playing an event clip inline stays open to members.
  ["get", "/api/cameras/clips/event/abc"],
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

/** WARP-3103 (R-C2): saving footage as a file, the attachment path. */
const SAVE_FOOTAGE: Array<[string, string]> = [
  ["get", "/api/cameras/clips/event/abc?download=1"],
  ["get", "/api/cameras/events/abc/snapshot?download=1"],
];

/** WARP-3104 (R-C1): turning a camera's detection on or off. */
const DETECTION: Array<[string, string]> = [
  ["post", "/api/cameras/front/enable"],
  ["post", "/api/cameras/front/disable"],
];

describe("saving footage and switching detection are owner/admin only (WARP-3103, WARP-3104)", () => {
  const call = (role: Role, verb: string, path: string) =>
    (request(appAs(role)) as never as Record<string, (p: string) => Promise<{ status: number }>>)[verb](path);

  it.each([...SAVE_FOOTAGE, ...DETECTION])("%s %s → 403 for family", async (verb, path) => {
    expect((await call("family", verb, path)).status).toBe(403);
  });

  it.each([...SAVE_FOOTAGE, ...DETECTION])("%s %s → 403 for guest", async (verb, path) => {
    expect((await call("guest", verb, path)).status).toBe(403);
  });

  it.each([...SAVE_FOOTAGE, ...DETECTION])("%s %s is reachable for owner", async (verb, path) => {
    expect((await call("owner", verb, path)).status).not.toBe(403);
  });

  it.each([...SAVE_FOOTAGE, ...DETECTION])("%s %s is reachable for admin", async (verb, path) => {
    expect((await call("admin", verb, path)).status).not.toBe(403);
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

describe("WARP-1962: every camera-scoped route is per-camera guarded too", () => {
  function nameRoutes() {
    const router = createCamerasRouter(prismaStub) as unknown as {
      stack: Array<{ route?: { path: string; stack: Array<{ handle: { name?: string } }> } }>;
    };
    return router.stack
      .map((l) => l.route)
      .filter((r): r is { path: string; stack: Array<{ handle: { name?: string } }> } =>
        Boolean(r) && r!.path.startsWith("/cameras/:name"),
      );
  }

  it("inspects a meaningful number of :name routes", () => {
    // Same anti-vacuity guard as the role sweep: an empty stack would make
    // the assertion below pass while checking nothing.
    expect(nameRoutes().length).toBeGreaterThan(15);
  });

  it("puts the per-camera access guard on every route naming a camera", () => {
    // Role tiers say "may you watch recordings"; this says "may you watch
    // THIS camera". A route with the first and not the second still leaks
    // the bedroom to someone granted only the front door.
    const missing = nameRoutes()
      .filter((r) => !r.stack.some((h) => h.handle?.name === "cameraAccessGuard"))
      .map((r) => r.path);
    expect(missing).toEqual([]);
  });

  it("orders the guards role-first, then scope", () => {
    // The role check is a pure in-memory set lookup; the scope check hits
    // the database. A guest must be rejected without costing a query.
    for (const r of nameRoutes()) {
      const roleIdx = r.stack.findIndex((h) => isRoleGuard(h.handle));
      const scopeIdx = r.stack.findIndex((h) => h.handle?.name === "cameraAccessGuard");
      expect(roleIdx).toBeGreaterThanOrEqual(0);
      expect(scopeIdx).toBeGreaterThan(roleIdx);
    }
  });
});

describe("WARP-2982: routes that name NO camera are per-camera guarded too", () => {
  // The WARP-1962 sweep above only walked `/cameras/:name*`, so every
  // cross-camera route (events, search, SSE, reviews, clips) and every route
  // addressed by event / review id shipped with the role check alone. This
  // sweep covers the WHOLE router: a route either carries the per-camera
  // guard, or it is listed here with the reason it returns nothing a
  // per-camera grant governs. A new route has to pick one.
  const EXEMPT: Record<string, string> = {
    "GET /cameras": "filters its own list via filterVisibleCameras",
    "POST /cameras": "adds a camera (owner/admin/family), returns no footage",
    "GET /cameras/groups": "group metadata — camera-name disclosure is a separate follow-up",
    "POST /cameras/groups": "group metadata",
    "PATCH /cameras/groups/:id": "group metadata",
    "DELETE /cameras/groups/:id": "group metadata",
    "POST /cameras/groups/:id/members": "group metadata",
    "DELETE /cameras/groups/:id/members/:cameraName": "group metadata",
    "GET /cameras/pins": "the caller's own pins",
    "POST /cameras/pins": "the caller's own pins",
    "PATCH /cameras/pins/reorder": "the caller's own pins",
    "DELETE /cameras/pins/:cameraName": "the caller's own pins",
    "POST /cameras/clips/share": "signs a Nextcloud path; governed by Nextcloud ACLs, custody roles only",
    "GET /cameras/plates": "household plate roster",
    "PUT /cameras/plates/:plate": "household plate roster",
    "DELETE /cameras/plates/:plate": "household plate roster",
    "GET /cameras/system": "appliance health — camera-name disclosure is a separate follow-up",
    "GET /cameras/storage": "appliance health — camera-name disclosure is a separate follow-up",
    "GET /cameras/stats": "appliance health — camera-name disclosure is a separate follow-up",
    "POST /cameras/system/restart": "owner-only appliance action",
    "POST /cameras/scan": "network discovery",
    "GET /cameras/discovered": "unadopted candidates, no grants can exist yet",
    "POST /cameras/discovered/:id/accept": "adoption",
    "POST /cameras/discovered/:id/reject": "adoption",
    "GET /cameras/drivers": "appliance health",
    "POST /cameras/drivers/fix": "owner/admin appliance action",
    "GET /cameras/subnet": "network config",
    "POST /cameras/subnet/setup": "owner/admin network config",
    "DELETE /cameras/subnet": "owner/admin network config",
    "POST /cameras/command/confirm": "confirms a pending token minted by a guarded route",
    "GET /cameras/retention/backfill": "custody roles only (owner/admin see every camera)",
    "POST /cameras/retention/backfill": "custody roles only (owner/admin see every camera)",
    "GET /cameras/access/:userId": "custody roles only — administers grants",
    "PUT /cameras/access/:userId": "custody roles only — administers grants",
  };

  function allRoutes() {
    const router = createCamerasRouter(prismaStub) as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: { name?: string } }>;
        };
      }>;
    };
    return router.stack
      .map((l) => l.route)
      .filter((r): r is NonNullable<typeof r> => Boolean(r) && r!.path.startsWith("/cameras"))
      .flatMap((r) =>
        Object.keys(r.methods).map((m) => ({
          key: `${m.toUpperCase()} ${r.path}`,
          guarded: r.stack.some((h) => h.handle?.name === "cameraAccessGuard"),
          faceFolderGuarded: r.stack.some((h) => h.handle?.name === "faceFolderAccess"),
        })),
      );
  }

  it("every camera route is per-camera guarded or explicitly exempt", () => {
    const routes = allRoutes();
    expect(routes.length).toBeGreaterThan(60);
    const unaccounted = routes.filter((r) => !r.guarded && !(r.key in EXEMPT)).map((r) => r.key);
    expect(unaccounted).toEqual([]);
  });

  it("the routes the ticket named are guarded, not exempt", () => {
    const guarded = new Set(allRoutes().filter((r) => r.guarded).map((r) => r.key));
    for (const key of [
      "GET /cameras/events",
      "GET /cameras/events/search",
      "GET /cameras/events/sse",
      "GET /cameras/events/recent",
      "GET /cameras/reviews",
      "GET /cameras/events/:eventId/thumbnail",
      "GET /cameras/events/:eventId/snapshot",
      "GET /cameras/clips",
      "GET /cameras/clips/event/:eventId",
      "GET /cameras/birdseye/live",
      "GET /cameras/reviews/:reviewId/preview",
      "GET /cameras/reviews/:reviewId/thumbnail",
    ]) {
      expect(guarded, key).toContain(key);
    }
  });

  it("WARP-3013: the face-library routes that can serve a camera's crops are guarded", () => {
    // Frigate's face library holds `train` — recent face crops from every
    // camera — next to the curated roster, so these are not "household
    // roster, not per-camera footage" after all.
    const guarded = new Set(allRoutes().filter((r) => r.guarded).map((r) => r.key));
    for (const key of [
      "GET /cameras/faces",
      "GET /cameras/faces/:name/images/:image",
      "DELETE /cameras/faces/:name",
      "DELETE /cameras/faces/:name/images/:image",
    ]) {
      expect(guarded, key).toContain(key);
    }
  });

  it("WARP-3013: every face route addressed by :name carries the `train`-folder check", () => {
    // One rule, not per-route judgement: whatever a route does with a face
    // folder (read, remove, write into), a scope that may not see `train`
    // does not reach it. Custody-only routes included — they are safe today
    // only because custody roles happen to see every camera.
    const faceRoutes = allRoutes().filter((r) => / \/cameras\/faces\/:name/.test(r.key));
    expect(faceRoutes.map((r) => r.key).sort()).toEqual([
      "DELETE /cameras/faces/:name",
      "DELETE /cameras/faces/:name/images/:image",
      "GET /cameras/faces/:name/images/:image",
      "POST /cameras/faces/:name/from-event/:eventId",
    ]);
    expect(faceRoutes.filter((r) => !r.faceFolderGuarded).map((r) => r.key)).toEqual([]);
  });

  it("the exemption list carries no stale entries", () => {
    // An exemption for a route that no longer exists (or has since gained
    // the guard) is dead weight that hides the next real gap.
    const unguarded = new Set(allRoutes().filter((r) => !r.guarded).map((r) => r.key));
    expect(Object.keys(EXEMPT).filter((k) => !unguarded.has(k))).toEqual([]);
  });
});

/**
 * WARP-3103 (part 1) / WARP-3097 — footage never lands in a cache. These
 * routes used to answer `public, max-age=…` (snapshots 5 s, event
 * thumbnails an hour), so a browser or HTTP cache could keep surveillance
 * footage on disk after sign-out and hand it to the next account. The
 * app-wide `/api` default is `no-store`; these handlers set it explicitly
 * because they are the ones that used to override it.
 */
describe("camera footage is private, no-store", () => {
  const jpeg = () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } });

  it.each([
    "/api/cameras/front/snapshot",
    "/api/cameras/events/abc/thumbnail",
    "/api/cameras/events/abc/snapshot",
    "/api/cameras/reviews/abc/thumbnail",
    "/api/cameras/front/playback?after=1&before=2",
    "/api/cameras/front/playback.segment?after=1&before=2&seg=0.ts",
  ])("GET %s → private, no-store", async (path) => {
    const frigate = await import("../services/frigate.client.js");
    vi.mocked(frigate.fetchSnapshot).mockResolvedValue(jpeg() as never);
    vi.mocked(frigate.fetchEventThumbnail).mockResolvedValue(jpeg() as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jpeg());
    try {
      const res = await request(appAs("owner")).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

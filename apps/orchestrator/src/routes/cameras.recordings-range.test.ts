/**
 * WARP-1958 — recording range + timezone guards on the recordings routes.
 *
 * Two failures this pins, both measured on the production box:
 *
 *   1. The page asked for hour buckets in the FUTURE (22:00 UTC requested
 *      at 15:34 UTC). Frigate answered with an empty segment list and a
 *      404 on the VOD manifest, which the orchestrator turned into a 502
 *      and the player rendered as "we couldn't load that recording" — an
 *      empty hour presented as a broken camera.
 *   2. The summary was fetched with no timezone, so Frigate bucketed in
 *      UTC while the browser built ranges in local time. Seven hours
 *      apart for a PDT operator.
 *
 * Harness mirrors cameras.degrade.test.ts: supertest + pass-through role
 * gate, every service cameras.ts imports mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
    FRIGATE_URL: "http://frigate.test:5000",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  requireRole:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  requireRoleOrMcpService:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));

const getRecordingsSummary = vi.fn();
const getRecordings = vi.fn();
const getTimelineEntries = vi.fn();
vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(),
  getEventsFiltered: vi.fn(),
  getRecentEvents: vi.fn(),
  getRecordings: (...a: unknown[]) => getRecordings(...a),
  getRecordingsSummary: (...a: unknown[]) => getRecordingsSummary(...a),
  getReviewsFiltered: vi.fn(),
  getStats: vi.fn(),
  getTimelineEntries: (...a: unknown[]) => getTimelineEntries(...a),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true),
}));

const fetchHlsPlaylist = vi.fn();
vi.mock("../services/frigate.client.js", async () => {
  // Keep the REAL isValidIanaTimezone and NoRecordingsInRangeError: they
  // are the units under test here, and a stubbed `instanceof` target
  // would make the 404-vs-502 assertion meaningless.
  const actual = await vi.importActual<typeof import("../services/frigate.client.js")>(
    "../services/frigate.client.js",
  );
  return {
    ...actual,
    fetchSnapshot: vi.fn(),
    fetchEventThumbnail: vi.fn(),
    fetchKnownFaces: vi.fn(),
    fetchKnownPlates: vi.fn(),
    fetchFaceImage: vi.fn(),
    deleteKnownFace: vi.fn(),
    deleteFaceImage: vi.fn(),
    deleteKnownPlate: vi.fn(),
    nameKnownPlate: vi.fn(),
    regenerateEventDescription: vi.fn(),
    tagEventAsFace: vi.fn(),
    openBirdseyeStream: vi.fn(),
    openMjpegStream: vi.fn(),
    enableDetection: vi.fn(),
    disableDetection: vi.fn(),
    deleteCamera: vi.fn(),
    deleteEvent: vi.fn(),
    addCamera: vi.fn(),
    syncCamerasFromDb: vi.fn(),
    fetchEvents: vi.fn(),
    buildRecordingClipUrl: vi.fn(),
    buildVodMasterUrl: vi.fn().mockReturnValue("http://frigate.test:5000/vod/x/master.m3u8"),
    buildVodSegmentUrl: vi.fn(),
    fetchHlsPlaylist: (...a: unknown[]) => fetchHlsPlaylist(...a),
    fetchPtzCapabilities: vi.fn(),
    ptzGoToPreset: vi.fn(),
    ptzMove: vi.fn(),
    restartFrigate: vi.fn(),
  };
});

vi.mock("../services/camera-system.service.js", () => ({
  getCameraSystemStatus: vi.fn(),
}));
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));
vi.mock("../services/clips.service.js", () => ({
  exportClip: vi.fn(),
  signShareUrl: vi.fn(),
  verifyShareUrl: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({ resolveNcToken: vi.fn() }));
vi.mock("../services/nextcloud.client.js", () => ({ ncDownloadFile: vi.fn() }));
vi.mock("../services/camera-groups.service.js", () => ({
  listGroups: vi.fn(),
  isValidGroupName: vi.fn(),
  isValidGroupIcon: vi.fn(),
}));
vi.mock("../services/camera-pins.service.js", () => ({}));
vi.mock("../services/camera-settings.service.js", () => ({
  getCameraSettings: vi.fn(),
  updateCameraSettings: vi.fn(),
}));

import { createCamerasRouter } from "./cameras.js";
import { NoRecordingsInRangeError } from "../services/frigate.client.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", createCamerasRouter({} as never));
  return app;
}

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recording ranges are clamped to the present", () => {
  it("rejects a window that starts in the future instead of querying Frigate", async () => {
    const start = nowSec() + 6 * 3600; // the measured 22:00-UTC-at-15:34 case
    const res = await request(makeApp())
      .get("/api/cameras/front/recordings")
      .query({ after: start, before: start + 3600 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
    // The point of the guard: Frigate is never asked for footage that
    // cannot exist. Reaching it is what produced the 404 → 502 → red banner.
    expect(getRecordings).not.toHaveBeenCalled();
  });

  it("truncates a window that starts in the past but runs past now", async () => {
    getRecordings.mockResolvedValue([]);
    const start = nowSec() - 1800; // half an hour ago
    const before = start + 3600; // ...ending half an hour from now

    const res = await request(makeApp())
      .get("/api/cameras/front/recordings")
      .query({ after: start, before });

    expect(res.status).toBe(200);
    const [, passedAfter, passedBefore] = getRecordings.mock.calls[0] as [
      string,
      number,
      number,
    ];
    expect(passedAfter).toBe(start);
    expect(passedBefore).toBeLessThan(before);
    expect(passedBefore).toBeLessThanOrEqual(nowSec() + 121);
  });

  it("still serves an ordinary past window untouched", async () => {
    getRecordings.mockResolvedValue([]);
    const before = nowSec() - 3600;
    const after = before - 3600;

    const res = await request(makeApp())
      .get("/api/cameras/front/recordings")
      .query({ after, before });

    expect(res.status).toBe(200);
    expect(getRecordings).toHaveBeenCalledWith("front", after, before);
  });

  it("applies the same clamp to the timeline route", async () => {
    const start = nowSec() + 3600;
    const res = await request(makeApp())
      .get("/api/cameras/front/timeline")
      .query({ after: start, before: start + 3600 });

    expect(res.status).toBe(400);
    expect(getTimelineEntries).not.toHaveBeenCalled();
  });
});

describe("an empty range is an answer, not an upstream failure", () => {
  it("maps Frigate's 404 on the VOD manifest to 404, not 502", async () => {
    fetchHlsPlaylist.mockRejectedValue(new NoRecordingsInRangeError());
    const before = nowSec() - 3600;

    const res = await request(makeApp())
      .get("/api/cameras/front/playback.m3u8")
      .query({ after: before - 3600, before });

    // 502 told the player the recorder was broken and painted a red
    // banner over a healthy camera.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_recordings_in_range");
  });

  it("still reports a genuine upstream failure as 502", async () => {
    fetchHlsPlaylist.mockRejectedValue(new Error("HLS playlist: 500"));
    const before = nowSec() - 3600;

    const res = await request(makeApp())
      .get("/api/cameras/front/playback.m3u8")
      .query({ after: before - 3600, before });

    expect(res.status).toBe(502);
  });
});

describe("the summary is bucketed in the caller's timezone", () => {
  it("forwards a valid IANA zone", async () => {
    getRecordingsSummary.mockResolvedValue([]);

    const res = await request(makeApp())
      .get("/api/cameras/front/recordings/summary")
      .query({ timezone: "America/Los_Angeles" });

    expect(res.status).toBe(200);
    expect(getRecordingsSummary).toHaveBeenCalledWith("front", "America/Los_Angeles");
  });

  it("rejects a bogus zone rather than silently bucketing in UTC", async () => {
    const res = await request(makeApp())
      .get("/api/cameras/front/recordings/summary")
      .query({ timezone: "Mars/Olympus_Mons" });

    // Falling back to UTC here would recreate the exact mismatch the
    // parameter exists to close, and do it invisibly.
    expect(res.status).toBe(400);
    expect(getRecordingsSummary).not.toHaveBeenCalled();
  });

  it("still works with no timezone at all", async () => {
    getRecordingsSummary.mockResolvedValue([]);

    const res = await request(makeApp()).get("/api/cameras/front/recordings/summary");

    expect(res.status).toBe(200);
    expect(getRecordingsSummary).toHaveBeenCalledWith("front", undefined);
  });
});

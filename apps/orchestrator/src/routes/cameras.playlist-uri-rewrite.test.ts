/**
 * WARP-3122 — recordings playlist rewrite must not leak the bearer token.
 *
 * Native clients (droplet-ios, DropletAgent) attach the bearer token as an
 * AVPlayer HTTP header, sent on every request the playlist causes — including
 * one to a third-party host if the playlist happened to contain an absolute
 * URL. Frigate never emits one in normal operation, so the box refuses the
 * whole playlist instead of forwarding it.
 *
 * Separately, `#EXT-X-MAP:URI=` (the fMP4 init segment) was never rewritten
 * at all, so it resolved to a route the orchestrator doesn't serve. It now
 * gets the same proxy rewrite as ordinary segment lines.
 *
 * Harness mirrors cameras.recordings-range.test.ts: supertest + pass-through
 * role gate, every service cameras.ts imports mocked.
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

vi.mock("../services/camera.service.js", () => ({
  getCameras: vi.fn(),
  getEventsFiltered: vi.fn(),
  getRecentEvents: vi.fn(),
  getRecordings: vi.fn(),
  getRecordingsSummary: vi.fn(),
  getReviewsFiltered: vi.fn(),
  getStats: vi.fn(),
  getTimelineEntries: vi.fn(),
  searchEventsSemanticTyped: vi.fn(),
  setEventRetention: vi.fn(),
  setReviewViewed: vi.fn(),
  subscribeCameraEvents: vi.fn(),
  isInitialized: vi.fn().mockReturnValue(true),
}));

const fetchHlsPlaylist = vi.fn();
vi.mock("../services/frigate.client.js", async () => {
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "u-test-owner", username: "owner", displayName: "Owner", role: "owner" };
    next();
  });
  app.use("/api", createCamerasRouter({} as never));
  return app;
}

const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

function fetchPlaylist(before: number, after: number) {
  return request(makeApp())
    .get("/api/cameras/front/playback.m3u8")
    .query({ after, before });
}

describe("WARP-3122: recordings playlist rewrite", () => {
  const before = () => nowSec() - 3600;
  const after = () => before() - 3600;

  it("refuses a playlist carrying an absolute segment URL instead of forwarding it", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        "#EXTINF:10.0,",
        "http://attacker.example.com/steal.ts",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/absolute segment URL/);
  });

  it("refuses a playlist carrying a protocol-relative segment URL", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      ["#EXTM3U", "#EXTINF:10.0,", "//attacker.example.com/steal.ts", "#EXT-X-ENDLIST"].join(
        "\n",
      ),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/absolute segment URL/);
  });

  it("refuses a playlist whose #EXT-X-MAP:URI is absolute", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        '#EXT-X-MAP:URI="http://attacker.example.com/init.mp4"',
        "#EXTINF:10.0,",
        "0.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/absolute URI attribute/);
  });

  it("rewrites a relative #EXT-X-MAP:URI to the segment proxy", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        '#EXT-X-MAP:URI="init-0.mp4"',
        "#EXTINF:10.0,",
        "0.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    const mapLine = lines.find((l) => l.startsWith("#EXT-X-MAP:"));
    expect(mapLine).toContain("/api/cameras/front/playback.segment");
    expect(mapLine).toContain(`seg=${encodeURIComponent("init-0.mp4")}`);
    // BYTERANGE / other attributes on the same tag survive untouched.
    expect(mapLine?.startsWith('#EXT-X-MAP:URI="')).toBe(true);
  });

  it("leaves ordinary tag lines with no URI attribute unchanged", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-TARGETDURATION:10",
        "#EXTINF:10.0,",
        "0.ts",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    expect(lines).toContain("#EXT-X-VERSION:7");
    expect(lines).toContain("#EXT-X-TARGETDURATION:10");
    expect(lines).toContain("#EXTINF:10.0,");
    expect(lines).toContain("#EXT-X-ENDLIST");
    // ...while the plain relative segment line still gets proxied.
    const segLine = lines.find((l) => l.includes("playback.segment"));
    expect(segLine).toContain(`seg=${encodeURIComponent("0.ts")}`);
  });

  // Fix-round-1 (review): `/URI="([^"]*)"/i` only matched the strict
  // double-quoted form. A single-quoted, unquoted, or otherwise-cased
  // attribute produced `!uriMatch` and forwarded the ORIGINAL line —
  // absolute URL included — unchanged. These four cases must now refuse
  // the playlist instead of silently letting the absolute URL through.

  it("refuses a single-quoted #EXT-X-MAP:URI instead of forwarding it", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        "#EXT-X-MAP:URI='http://attacker.example.com/init.mp4'",
        "#EXTINF:10.0,",
        "0.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/malformed URI attribute/);
  });

  it("refuses an unquoted #EXT-X-MAP:URI instead of forwarding it", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        "#EXT-X-MAP:URI=http://attacker.example.com/init.mp4",
        "#EXTINF:10.0,",
        "0.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/malformed URI attribute/);
  });

  it("refuses a lowercase uri= attribute instead of forwarding it", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        "#EXT-X-MAP:uri=http://attacker.example.com/init.mp4",
        "#EXTINF:10.0,",
        "0.m4s",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/malformed URI attribute/);
  });

  it("rewrites two strict URI= attributes on the same line", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin",IV=0x00,URI="key2.bin"',
        "#EXTINF:10.0,",
        "0.ts",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(200);
    const lines = res.text.split("\n");
    const keyLine = lines.find((l) => l.startsWith("#EXT-X-KEY:"));
    expect(keyLine).toContain(`seg=${encodeURIComponent("key1.bin")}`);
    expect(keyLine).toContain(`seg=${encodeURIComponent("key2.bin")}`);
    // Neither raw filename survives unrewritten.
    expect(keyLine).not.toContain('URI="key1.bin"');
    expect(keyLine).not.toContain('URI="key2.bin"');
  });

  it("refuses two URI= attributes on one line if either is absolute", async () => {
    fetchHlsPlaylist.mockResolvedValue(
      [
        "#EXTM3U",
        '#EXT-X-KEY:METHOD=AES-128,URI="key1.bin",IV=0x00,URI="http://attacker.example.com/key2.bin"',
        "#EXTINF:10.0,",
        "0.ts",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    );

    const res = await fetchPlaylist(before(), after());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/absolute URI attribute/);
  });
});

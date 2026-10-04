/**
 * WARP-3509 — an event's clip plays as HLS, over the window around the event.
 *
 * Frigate 0.17's `GET /api/events/<id>/clip.mp4` is a FRAGMENTED mp4 that
 * ffmpeg streams on the fly (`-movflags frag_keyframe+empty_moov` in
 * frigate/api/media.py recording_clip): duration 0 in the header, the index at
 * the END, no Content-Length, and `Range` ignored. A `<video src>` cannot read a
 * duration from it (a 12 s clip showed 6.1 s), cannot seek it, and stalls on a
 * long one. The dashboard now plays the same footage the way the Recordings page
 * does — HLS over Frigate's nginx-vod endpoint — through
 * `GET /api/cameras/events/:eventId/playback.m3u8`, which:
 *
 *   - looks the event up (GET /api/events/<id>) for its camera and times,
 *   - asks Frigate's VOD for  start − pre-capture … end + post-capture
 *     (an event still in progress: up to now), and
 *   - rewrites the playlist exactly as the recordings route does: segments and
 *     the fMP4 init map pointed at our segment proxy, signed for the caller
 *     (WARP-3122), an absolute URL refused.
 *
 * Real frigate client, real camera.service, real cameras router, real error
 * handler: only the network (`fetch`) and the infrastructure the services touch
 * (cache, MQTT, push, the activity recorder) are stubbed. The fake Frigate
 * serves the two shapes this route needs — the event row and nginx-vod's
 * master + media playlists — and answers anything else the way the real one
 * does, so a route that went back to `clip.mp4` would fail here.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { EventEmitter } from "node:events";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "svc",
    FRIGATE_URL: "http://frigate.test:5000",
    MQTT_BROKER: "mqtt://broker.test:1883",
    AUTH_ENABLED: true,
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      const c = new EventEmitter() as EventEmitter & { subscribe: () => void; end: () => void };
      c.subscribe = () => {};
      c.end = () => {};
      return c;
    }),
  },
}));

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "142.250.0.1", family: 4 }],
}));

vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue({ id: 1n }),
}));

import { createCamerasRouter } from "../routes/cameras.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { AuthUser } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { resetCameraWatchDedupe } from "../services/camera-watch-audit.js";
import { verifySegmentSignature } from "../services/segment-url-signing.service.js";

const FRIGATE = "http://frigate.test:5000";
/** The id shape a live 0.17.1 box produces for an event: `<start epoch>-<6 chars>`. */
const EVENT_ID = "1791059989.433851-abc123";
const CAMERA = "warp_lab_office";
const EVENT_START = 1791059989.433851;
const EVENT_END = 1791060001.2;
/** Hours after the event, so `now` clamps nothing unless a test sets it closer. */
const NOW = 1791070000;

const ROUTE = `/api/cameras/events/${EVENT_ID}/playback.m3u8`;

// The window the default padding (20 s each side) gives this event:
//   floor(start − 20) … ceil(end + 20)
const AFTER = 1791059969;
const BEFORE = 1791060022;

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const family: AuthUser = { id: "u-family", username: "sam", displayName: "sam", role: "family" };

function buildApp(user: AuthUser = owner, prisma: PrismaClient = {} as PrismaClient): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createCamerasRouter(prisma));
  app.use(errorHandler);
  return app;
}

/** A prisma stub that grants `family` exactly these cameras. */
function grantedPrisma(...cameras: string[]): PrismaClient {
  return {
    cameraAccessGrant: {
      findMany: vi.fn(async () => cameras.map((name) => ({ camera: { name } }))),
    },
  } as unknown as PrismaClient;
}

// --- a fake Frigate 0.17.1 ---------------------------------------------------

type Handler = (url: URL) => globalThis.Response | Promise<globalThis.Response>;
type Table = Record<string, Handler>;

let calls: string[];
let fetchSpy: MockInstance<typeof fetch>;

const json = (status: number, body: unknown) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const text = (status: number, body: string, type = "application/vnd.apple.mpegurl") =>
  new globalThis.Response(body, { status, headers: { "content-type": type } });

/** The event row exactly as `GET /api/events/<id>` returns it (model_to_dict). */
function eventRow(over: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    label: "person",
    sub_label: null,
    camera: CAMERA,
    start_time: EVENT_START,
    end_time: EVENT_END,
    false_positive: false,
    zones: [],
    thumbnail: null,
    has_clip: true,
    has_snapshot: true,
    retain_indefinitely: false,
    plus_id: null,
    model_hash: null,
    detector_type: null,
    model_type: null,
    data: { top_score: 0.91 },
    ...over,
  };
}

/** nginx-vod's master playlist: one variant, pointing at the media playlist. */
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2500000,RESOLUTION=3328x1872,CODECS="avc1.640033"
index-v1.m3u8
`;

/** nginx-vod's media playlist with `vod_hls_container_format fmp4`: an init map + .m4s segments. */
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init-v1.mp4"
#EXTINF:10.000,
seg-1-v1.m4s
#EXTINF:10.000,
seg-2-v1.m4s
#EXT-X-ENDLIST
`;

const vod = (after: number, before: number, file: string) =>
  `/vod/${CAMERA}/start/${after}/end/${before}/${file}`;

/** Every route this feature touches, answering what 0.17.1 answers, for the default window. */
function frigate0171(after = AFTER, before = BEFORE): Table {
  return {
    [`GET /api/events/${EVENT_ID}`]: () => json(200, eventRow()),
    [`GET ${vod(after, before, "master.m3u8")}`]: () => text(200, MASTER),
    [`GET ${vod(after, before, "index-v1.m3u8")}`]: () => text(200, MEDIA),
  };
}

/** Serve `table`; anything not in it is a 404, as an unknown route is on Frigate. */
function frigateServes(table: Table) {
  fetchSpy.mockImplementation(async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push(`GET ${url.pathname}`);
    const handler = table[`GET ${url.pathname}`];
    return handler ? handler(url) : json(404, { detail: "Not Found" });
  });
}

function expectDegraded(res: { status: number; body: unknown; headers: Record<string, string> }) {
  expect(res.status).toBe(503);
  expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  expect(res.body).toMatchObject({ error: "frigate_unavailable" });
}

const settle = () => new Promise((r) => setTimeout(r, 10));

const envKeys = ["NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC", "NVR_DEFAULT_EVENT_POST_CAPTURE_SEC", "DEVICE_SECRET"] as const;
const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
  calls = [];
  for (const k of envKeys) savedEnv[k] = process.env[k];
  delete process.env.NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC;
  delete process.env.NVR_DEFAULT_EVENT_POST_CAPTURE_SEC;
  process.env.DEVICE_SECRET = "event-playback-test-secret-0123456789abcdef";
  // Date only: timers must keep running for supertest and AbortSignal.timeout.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW * 1000));
  vi.mocked(recordActivity).mockClear();
  resetCameraWatchDedupe();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
  vi.useRealTimers();
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ============================================================================

describe("GET /api/cameras/events/:eventId/playback.m3u8 — the window (WARP-3509)", () => {
  it("asks Frigate's VOD for start − 20 s … end + 20 s of the event's camera, never the fragmented clip.mp4", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      `GET /api/events/${EVENT_ID}`,
      `GET ${vod(AFTER, BEFORE, "master.m3u8")}`,
      `GET ${vod(AFTER, BEFORE, "index-v1.m3u8")}`,
    ]);
    expect(calls.join("\n")).not.toContain("clip.mp4");
  });

  it("an event still in progress runs to now", async () => {
    const now = Math.floor(EVENT_START) + 90; // 90 s in, well inside the one-hour cap
    vi.setSystemTime(new Date(now * 1000));
    frigateServes({
      ...frigate0171(AFTER, now),
      [`GET /api/events/${EVENT_ID}`]: () => json(200, eventRow({ end_time: null })),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toContain(`GET ${vod(AFTER, now, "master.m3u8")}`);
  });

  it("an event that ended seconds ago stops at now, not at its post-capture", async () => {
    const now = Math.ceil(EVENT_END) + 5; // 15 s short of the 20 s post-capture
    vi.setSystemTime(new Date(now * 1000));
    frigateServes(frigate0171(AFTER, now));
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toContain(`GET ${vod(AFTER, now, "master.m3u8")}`);
  });

  it("an event that has run for hours plays its first hour", async () => {
    const before = AFTER + 3600;
    frigateServes({
      ...frigate0171(AFTER, before),
      [`GET /api/events/${EVENT_ID}`]: () => json(200, eventRow({ end_time: EVENT_START + 5 * 3600 })),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toContain(`GET ${vod(AFTER, before, "master.m3u8")}`);
  });

  it("takes the padding from the configured pre/post capture, the values the box gives its cameras", async () => {
    process.env.NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC = "5";
    process.env.NVR_DEFAULT_EVENT_POST_CAPTURE_SEC = "0";
    const after = Math.floor(EVENT_START - 5);
    const before = Math.ceil(EVENT_END);
    frigateServes(frigate0171(after, before));
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toContain(`GET ${vod(after, before, "master.m3u8")}`);
  });

  it("clamps the padding at what Frigate itself accepts (60 s)", async () => {
    process.env.NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC = "600";
    const after = Math.floor(EVENT_START - 60);
    frigateServes(frigate0171(after, BEFORE));
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(200);
    expect(calls).toContain(`GET ${vod(after, BEFORE, "master.m3u8")}`);
  });
});

// ============================================================================

describe("GET /api/cameras/events/:eventId/playback.m3u8 — the playlist (WARP-3509, WARP-3122)", () => {
  it("is an HLS playlist that is never cached", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(ROUTE);

    expect(res.headers["content-type"]).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text.startsWith("#EXTM3U")).toBe(true);
    expect(res.text).toContain("#EXT-X-ENDLIST");
  });

  it("points every segment and the fMP4 init map at the camera's segment proxy, over the EVENT's window", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(ROUTE);

    const prefix = `/api/cameras/${CAMERA}/playback.segment?after=${AFTER}&before=${BEFORE}&seg=`;
    const uris = res.text.split("\n").filter((l) => l.includes("playback.segment"));
    expect(uris).toHaveLength(3); // the init map, then two segments
    expect(res.text).toContain(`#EXT-X-MAP:URI="${prefix}init-v1.mp4&`);
    expect(res.text).toContain(`\n${prefix}seg-1-v1.m4s&`);
    expect(res.text).toContain(`\n${prefix}seg-2-v1.m4s&`);
    // Nothing is left pointing at Frigate.
    expect(res.text).not.toContain("frigate.test");
    expect(res.text).not.toMatch(/^seg-/m);
  });

  it("signs each segment for this caller, this camera and this window (WARP-3122)", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(ROUTE);

    const line = res.text.split("\n").find((l) => l.includes("seg=seg-1-v1.m4s"))!;
    const q = new URL(line, "http://box.test").searchParams;
    expect(q.get("u")).toBe(owner.id);
    expect(
      verifySegmentSignature(
        {
          camera: CAMERA,
          after: String(AFTER),
          before: String(BEFORE),
          seg: "seg-1-v1.m4s",
          userId: owner.id,
          exp: q.get("exp")!,
        },
        q.get("sig")!,
        NOW,
      ),
    ).toBe(true);
    // …and for no other window: a signature does not carry over.
    expect(
      verifySegmentSignature(
        { camera: CAMERA, after: String(AFTER), before: String(BEFORE + 1), seg: "seg-1-v1.m4s", userId: owner.id, exp: q.get("exp")! },
        q.get("sig")!,
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses a playlist that names an absolute segment URL, as the recordings route does", async () => {
    frigateServes({
      ...frigate0171(),
      [`GET ${vod(AFTER, BEFORE, "index-v1.m3u8")}`]: () =>
        text(200, `#EXTM3U\n#EXTINF:10,\nhttps://evil.test/seg-1.m4s\n#EXT-X-ENDLIST\n`),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(502);
    expect(res.text).not.toContain("evil.test/seg");
  });

  it("is audited once, as a clip watched on the event's camera, never per segment", async () => {
    frigateServes(frigate0171());
    await request(buildApp()).get(ROUTE);
    await settle();

    const rows = vi.mocked(recordActivity).mock.calls.map(([p]) => p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sub: CAMERA,
      refs: { camera: CAMERA, watch: "clip", saved: false, eventId: EVENT_ID },
    });
  });
});

// ============================================================================

describe("GET /api/cameras/events/:eventId/playback.m3u8 — failures (WARP-3509)", () => {
  it("404 event_not_found when Frigate has no such event, and no footage is asked for", async () => {
    frigateServes({
      ...frigate0171(),
      [`GET /api/events/${EVENT_ID}`]: () => json(404, "Event not found"),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "event_not_found" });
    expect(calls).toEqual([`GET /api/events/${EVENT_ID}`]);
  });

  it("404 no_recordings_in_range when nothing was kept for the window", async () => {
    // Frigate 404s an empty VOD range: an answer, not a broken camera (WARP-1958).
    frigateServes({
      ...frigate0171(),
      [`GET ${vod(AFTER, BEFORE, "master.m3u8")}`]: () => text(404, "not found", "text/plain"),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_recordings_in_range" });
  });

  it("502 when Frigate's VOD itself fails, as on the recordings route", async () => {
    frigateServes({
      ...frigate0171(),
      [`GET ${vod(AFTER, BEFORE, "master.m3u8")}`]: () => text(503, "down", "text/plain"),
    });
    const res = await request(buildApp()).get(ROUTE);

    expect(res.status).toBe(502);
  });

  it.each([405, 500, 502, 503, 401])(
    "a Frigate %i on the event lookup is the degraded 503, never an unhandled 500",
    async (status) => {
      frigateServes({
        ...frigate0171(),
        [`GET /api/events/${EVENT_ID}`]: () => json(status, { detail: "nope" }),
      });
      expectDegraded(await request(buildApp()).get(ROUTE));
    },
  );

  it("an unreachable Frigate is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expectDegraded(await request(buildApp()).get(ROUTE));
  });

  it("a Frigate that times out is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expectDegraded(await request(buildApp()).get(ROUTE));
  });

  it.each([
    ["an event row that is not JSON", () => text(200, "<html>welcome</html>", "text/html")],
    ["an event row with no camera", () => json(200, eventRow({ camera: undefined }))],
    ["an event row with no start time", () => json(200, eventRow({ start_time: "yesterday" }))],
    ["an event row with a camera name that is not a camera name", () => json(200, eventRow({ camera: "../etc" }))],
  ])("%s is the degraded 503, and no footage is asked for", async (_why, answer) => {
    frigateServes({ ...frigate0171(), [`GET /api/events/${EVENT_ID}`]: answer });
    expectDegraded(await request(buildApp()).get(ROUTE));
    expect(calls).toEqual([`GET /api/events/${EVENT_ID}`]);
  });

  it("400 on a malformed event id, without touching Frigate", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(`/api/cameras/events/${encodeURIComponent("not ok/../id")}/playback.m3u8`);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// ============================================================================

describe("the per-camera guard fronts event playback (WARP-2982)", () => {
  it("a member granted the event's camera gets the playlist", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp(family, grantedPrisma(CAMERA))).get(ROUTE);

    expect(res.status).toBe(200);
    // The guard's lookup, the handler's, then the footage.
    expect(calls.slice(0, 2)).toEqual([`GET /api/events/${EVENT_ID}`, `GET /api/events/${EVENT_ID}`]);
    expect(calls).toContain(`GET ${vod(AFTER, BEFORE, "master.m3u8")}`);
  });

  it("a member NOT granted the event's camera gets 404, and its footage is never asked for", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp(family, grantedPrisma("front_door"))).get(ROUTE);

    expect(res.status).toBe(404);
    expect(calls).toEqual([`GET /api/events/${EVENT_ID}`]);
  });

  it("a guest is refused outright", async () => {
    frigateServes(frigate0171());
    const guest: AuthUser = { id: "u-guest", username: "pat", displayName: "pat", role: "guest" };
    const res = await request(buildApp(guest)).get(ROUTE);

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

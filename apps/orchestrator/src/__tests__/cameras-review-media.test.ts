/**
 * WARP-3509 — review thumbnails, previews and "mark viewed" on Frigate 0.17.
 *
 * The Events page's Alerts / Detections tabs went dark on Frigate 0.17.1:
 * every thumbnail and preview 404'd and marking a review viewed answered 500.
 * The orchestrator was speaking a Frigate API that has never served these
 * paths (verified live against 0.17.1-416a9b7, and against the upstream
 * source at v0.17.1 — frigate/api/review.py, frigate/api/media.py):
 *
 *   GET  /api/review/<id>/thumbnail.jpg   → 404   (no such route)
 *   GET  /api/review/<id>/preview.mp4     → 404   (no such route)
 *   POST /api/review/<id>/viewed          → 405   (the path only accepts DELETE)
 *
 * What 0.17 does serve, and what these tests pin:
 *
 *   GET  /api/review/<id>                 the review row, with `thumb_path`
 *   GET  /clips/review/<file>             that thumbnail, as a static file
 *   GET  /api/review/<id>/preview?format= `gif` by DEFAULT (~10 MB), `mp4` (~1.4 MB)
 *   POST /api/reviews/viewed  {"ids":[…]} bulk mark-viewed
 *
 * The fake Frigate below serves ONLY those, and answers everything else the
 * way the real one does (404 for an unknown route, 405 for a known path with
 * the wrong method) — so a regression back to the legacy paths fails here the
 * way it fails on a box, instead of passing against a stub that never
 * disagreed with the code under test.
 *
 * Real frigate client, real camera.service, real cameras router, real error
 * handler: only the network (`fetch`) and the infrastructure the services
 * touch (cache, MQTT, push) are stubbed.
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

import { createCamerasRouter } from "../routes/cameras.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { AuthUser } from "../middleware/auth.js";
import * as frigateClient from "../services/frigate.client.js";
import { FrigateNotFoundError } from "../types/frigate-error.js";

const FRIGATE = "http://frigate.test:5000";
/** The id shape a live 0.17.1 box produces: `<start epoch>-<6 chars>`. */
const REVIEW_ID = "1791059989.433851-qrgete";
const CAMERA = "warp_lab_office";
const THUMB_FILE = `thumb-${CAMERA}-${REVIEW_ID}.webp`;
const THUMB_PATH = `/media/frigate/clips/review/${THUMB_FILE}`;

const THUMB_ROUTE = `/api/cameras/reviews/${REVIEW_ID}/thumbnail`;
const PREVIEW_ROUTE = `/api/cameras/reviews/${REVIEW_ID}/preview`;
const VIEWED_ROUTE = `/api/cameras/reviews/${REVIEW_ID}/viewed`;

// "RIFF....WEBPVP8 " / "....ftypmp42" — enough of each container header that a
// byte-for-byte comparison is a real check, not an empty-body tautology.
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a-the-10MB-default");

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

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: Call[];
let fetchSpy: MockInstance<typeof fetch>;

const json = (status: number, body: unknown) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The review row exactly as `GET /api/review/<id>` returns it (model_to_dict). */
function reviewRow(over: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    camera: CAMERA,
    start_time: 1791059989.433851,
    end_time: 1791060012.8,
    severity: "alert",
    thumb_path: THUMB_PATH,
    has_been_reviewed: false,
    data: {
      detections: ["1791059989.433851-abc123"],
      objects: ["person"],
      sub_labels: [],
      zones: [],
      audio: [],
    },
    ...over,
  };
}

/**
 * Every route this feature touches, answering what 0.17.1 answers. nginx
 * labels `.webp` under /clips/ `application/octet-stream` (the location's own
 * `types {}` block replaces the mime map and only names mp4 and jpg).
 */
function frigate0171(): Table {
  return {
    [`GET /api/review/${REVIEW_ID}`]: () => json(200, reviewRow()),
    [`GET /clips/review/${THUMB_FILE}`]: () =>
      new globalThis.Response(WEBP, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    [`GET /api/review/${REVIEW_ID}/preview`]: (url) => {
      // `format` DEFAULTS to gif — a client that forgets it pulls ~10 MB.
      const format = url.searchParams.get("format") ?? "gif";
      if (format === "mp4") {
        return new globalThis.Response(MP4, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(MP4.length) },
        });
      }
      if (format === "gif") {
        return new globalThis.Response(GIF, { status: 200, headers: { "content-type": "image/gif" } });
      }
      return json(422, { detail: "format must be gif or mp4" });
    },
    [`POST /api/reviews/viewed`]: () => json(200, { success: true, message: "Marked multiple items as reviewed" }),
    // The only verb the per-review path takes on 0.17: "mark NOT viewed".
    [`DELETE /api/review/${REVIEW_ID}/viewed`]: () =>
      json(200, { success: true, message: `Set Review ${REVIEW_ID} as not viewed` }),
  };
}

/** Serve `table`; anything not in it is a 405 (path known, wrong verb) or a 404. */
function frigateServes(table: Table) {
  fetchSpy.mockImplementation(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url: url.href,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const handler = table[`${method} ${url.pathname}`];
    if (handler) return handler(url);
    const pathKnown = Object.keys(table).some((k) => k.slice(k.indexOf(" ") + 1) === url.pathname);
    return pathKnown ? json(405, { detail: "Method Not Allowed" }) : json(404, { detail: "Not Found" });
  });
}

/** `"GET http://…"` per upstream call, in order. */
const callLog = () => calls.map((c) => `${c.method} ${c.url}`);

function expectDegraded(res: { status: number; body: unknown; headers: Record<string, string> }) {
  expect(res.status).toBe(503);
  expect(res.headers["x-droplet-degraded"]).toBe("frigate-unavailable");
  expect(res.body).toMatchObject({ error: "frigate_unavailable" });
}

beforeEach(() => {
  calls = [];
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

// ============================================================================

describe("GET /api/cameras/reviews/:reviewId/thumbnail (WARP-3509)", () => {
  it("resolves the review, then serves its thumb_path file from /clips/review/ as image/webp", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/webp");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(res.body as Buffer).equals(Buffer.from(WEBP))).toBe(true);
    // Exactly the 0.17 sequence: the row, then the static file it names. Never
    // the /api/review/<id>/thumbnail.jpg that 404s there.
    expect(callLog()).toEqual([
      `GET ${FRIGATE}/api/review/${REVIEW_ID}`,
      `GET ${FRIGATE}/clips/review/${THUMB_FILE}`,
    ]);
  });

  it("serves image/webp whatever Frigate labels the file (nginx says application/octet-stream)", async () => {
    // The default fake already answers octet-stream; here Frigate is wrong in
    // the other direction. The type comes from the validated extension.
    frigateServes({
      ...frigate0171(),
      [`GET /clips/review/${THUMB_FILE}`]: () =>
        new globalThis.Response(WEBP, { status: 200, headers: { "content-type": "text/html" } }),
    });
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
  });

  it("serves a .jpg thumb_path (older Frigate) as image/jpeg", async () => {
    const jpgFile = `thumb-${CAMERA}-${REVIEW_ID}.jpg`;
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}`]: () =>
        json(200, reviewRow({ thumb_path: `/media/frigate/clips/review/${jpgFile}` })),
      [`GET /clips/review/${jpgFile}`]: () =>
        new globalThis.Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 }),
    });
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it.each([
    ["traversal out of the review directory", "/media/frigate/clips/review/../../config/config.yml"],
    ["a sibling directory", "/media/frigate/clips/exports/thumb.webp"],
    ["a different root entirely", "/etc/passwd"],
    ["a nested path", "/media/frigate/clips/review/sub/thumb.webp"],
    ["null", null],
    ["a non-string", 42],
    ["a missing field", undefined],
  ])("rejects a thumb_path that is %s: 404 thumbnail_not_found, and no file is fetched", async (_why, thumbPath) => {
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}`]: () => json(200, reviewRow({ thumb_path: thumbPath })),
    });
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "thumbnail_not_found" });
    // The lookup, and nothing after it: a rejected path is never dialled.
    expect(callLog()).toEqual([`GET ${FRIGATE}/api/review/${REVIEW_ID}`]);
  });

  it("404 review_not_found when Frigate has no such review", async () => {
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}`]: () => json(404, { success: false, message: "Review item not found" }),
    });
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "review_not_found" });
    expect(callLog()).toEqual([`GET ${FRIGATE}/api/review/${REVIEW_ID}`]);
  });

  it("404 thumbnail_not_found when the review exists but its file is gone", async () => {
    // An in-progress review has no thumbnail until its first object frame, and
    // a finished one outlives its file once Frigate prunes /clips/review/.
    frigateServes({
      ...frigate0171(),
      [`GET /clips/review/${THUMB_FILE}`]: () => new globalThis.Response("404 Not Found", { status: 404 }),
    });
    const res = await request(buildApp()).get(THUMB_ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "thumbnail_not_found" });
  });

  it.each([405, 500, 502, 503, 401])(
    "a Frigate %i on the review lookup is the degraded 503, never an unhandled 500",
    async (status) => {
      frigateServes({
        ...frigate0171(),
        [`GET /api/review/${REVIEW_ID}`]: () => json(status, { detail: "nope" }),
      });
      expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
    },
  );

  it.each([405, 500, 502, 503])("a Frigate %i serving the thumbnail file is the degraded 503", async (status) => {
    frigateServes({
      ...frigate0171(),
      [`GET /clips/review/${THUMB_FILE}`]: () => new globalThis.Response("nope", { status }),
    });
    expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
  });

  it("an unreachable Frigate is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
  });

  it("a Frigate that times out is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
  });

  it("a thumbnail whose body dies mid-transfer is the degraded 503", async () => {
    // `TypeError: terminated` is what undici throws for a reset mid-body; it
    // must not fall through to the error handler as a 500.
    frigateServes({
      ...frigate0171(),
      [`GET /clips/review/${THUMB_FILE}`]: () =>
        new globalThis.Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    });
    expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
  });

  it("a not-found code these routes never raise is a wiring bug for the error handler, not a 404", async () => {
    // Only review_not_found / thumbnail_not_found / preview_not_found are this
    // route's to answer. An event's not-found arriving here must not be dressed
    // up as "this review has no thumbnail".
    const spy = vi
      .spyOn(frigateClient, "fetchReviewThumbnail")
      .mockRejectedValue(new FrigateNotFoundError("event_not_found"));
    try {
      const res = await request(buildApp()).get(THUMB_ROUTE);

      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it("a lookup answered with something that is not JSON is the degraded 503", async () => {
    // A proxy error page with a 200 is not Frigate answering. It must not
    // become a 500 from `res.json()` throwing inside the handler.
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}`]: () =>
        new globalThis.Response("<html>welcome</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expectDegraded(await request(buildApp()).get(THUMB_ROUTE));
  });

  it("400 on a malformed review id, without touching Frigate", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(
      `/api/cameras/reviews/${encodeURIComponent("not ok/../id")}/thumbnail`,
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// ============================================================================

describe("GET /api/cameras/reviews/:reviewId/preview (WARP-3509)", () => {
  it("asks Frigate for preview?format=mp4 and streams video/mp4", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(PREVIEW_ROUTE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.from(res.body as Buffer).equals(Buffer.from(MP4))).toBe(true);
    // One call, `?format=mp4`: not the legacy `/preview.mp4` (404 on 0.17) and
    // not the bare `/preview`, which Frigate answers with the ~10 MB gif.
    expect(callLog()).toEqual([`GET ${FRIGATE}/api/review/${REVIEW_ID}/preview?format=mp4`]);
  });

  it("404 preview_not_found while Frigate has no preview yet (an in-progress review)", async () => {
    // preview_mp4 answers 404 "Preview not found" until the hour's preview
    // frames or the finished segment exist — the normal state of a review
    // that is still open.
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}/preview`]: () => json(404, { success: false, message: "Preview not found" }),
    });
    const res = await request(buildApp()).get(PREVIEW_ROUTE);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "preview_not_found" });
  });

  it.each([405, 500, 502, 503])("a Frigate %i on the preview is the degraded 503", async (status) => {
    frigateServes({
      ...frigate0171(),
      [`GET /api/review/${REVIEW_ID}/preview`]: () => json(status, { detail: "nope" }),
    });
    expectDegraded(await request(buildApp()).get(PREVIEW_ROUTE));
  });

  it("an unreachable Frigate is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    expectDegraded(await request(buildApp()).get(PREVIEW_ROUTE));
  });

  it("400 on a malformed review id, without touching Frigate", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).get(`/api/cameras/reviews/${encodeURIComponent("a b")}/preview`);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// ============================================================================

describe("POST /api/cameras/reviews/:reviewId/viewed (WARP-3509)", () => {
  it("marks the review through POST /api/reviews/viewed {ids:[id]} and answers 204", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).post(VIEWED_ROUTE);

    expect(res.status).toBe(204);
    // One call. Not POST /api/review/<id>/viewed — on 0.17 that path takes
    // DELETE only, so the POST was a 405 → "Unhandled error" → the reported 500.
    expect(callLog()).toEqual([`POST ${FRIGATE}/api/reviews/viewed`]);
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body ?? "null")).toEqual({ ids: [REVIEW_ID] });
  });

  it("a Frigate 405 is the degraded 503, not the unhandled 500 WARP-3509 reported", async () => {
    frigateServes({
      ...frigate0171(),
      [`POST /api/reviews/viewed`]: () => json(405, { detail: "Method Not Allowed" }),
    });
    const res = await request(buildApp()).post(VIEWED_ROUTE);

    expectDegraded(res);
  });

  it.each([500, 502, 503])("a Frigate %i is the degraded 503", async (status) => {
    frigateServes({
      ...frigate0171(),
      [`POST /api/reviews/viewed`]: () => json(status, { detail: "nope" }),
    });
    expectDegraded(await request(buildApp()).post(VIEWED_ROUTE));
  });

  it("an unreachable Frigate is the degraded 503", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    expectDegraded(await request(buildApp()).post(VIEWED_ROUTE));
  });

  it("400 on a malformed review id, without touching Frigate", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp()).post(`/api/cameras/reviews/${encodeURIComponent("a b")}/viewed`);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

// ============================================================================

describe("the per-camera guard still fronts the review media routes (WARP-2982)", () => {
  // The guard resolves the review's camera through Frigate for a scoped user,
  // then the handler resolves the review again for its thumb_path — two lookups
  // before the file. What must never happen is the file being fetched for a
  // camera the caller was not granted.

  it("a member granted the review's camera gets the thumbnail", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp(family, grantedPrisma(CAMERA))).get(THUMB_ROUTE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(callLog()).toEqual([
      `GET ${FRIGATE}/api/review/${REVIEW_ID}`,
      `GET ${FRIGATE}/api/review/${REVIEW_ID}`,
      `GET ${FRIGATE}/clips/review/${THUMB_FILE}`,
    ]);
  });

  it("a member NOT granted the review's camera gets 404, and the file is never fetched", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp(family, grantedPrisma("front_door"))).get(THUMB_ROUTE);

    expect(res.status).toBe(404);
    expect(callLog()).toEqual([`GET ${FRIGATE}/api/review/${REVIEW_ID}`]);
  });

  it("a member NOT granted the review's camera cannot mark it viewed either", async () => {
    frigateServes(frigate0171());
    const res = await request(buildApp(family, grantedPrisma("front_door"))).post(VIEWED_ROUTE);

    expect(res.status).toBe(404);
    expect(callLog()).toEqual([`GET ${FRIGATE}/api/review/${REVIEW_ID}`]);
  });
});

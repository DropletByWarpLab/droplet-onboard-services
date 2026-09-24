/**
 * WARP-2982 — per-camera access (WARP-1962) holds on every route that does
 * NOT name a camera.
 *
 * Before this, `cameraAccessGuard` only read `:name`. The cross-camera
 * routes (event list, search, recent, reviews, clips, the live SSE stream)
 * and everything addressed by event / review id sailed straight past it:
 * a family member granted only the front door could read the bedroom's
 * events, thumbnails, clips and live detections.
 *
 * The setup is the household the feature exists for: Sam (`family`) is
 * granted `front_door` and NOT `bedroom`. Frigate holds data for both, and
 * the Frigate stub deliberately IGNORES the `cameras` filter it is sent, so
 * these tests also prove the post-query check, not just the narrowed query.
 *
 * The real camera.service and camera-access.service run; only Frigate,
 * the cache, MQTT and web-push are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Role } from "../services/jwt.service.js";

vi.mock("../config.js", () => ({
  config: {
    SERVICE_SECRET: "",
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

const mqttClient = vi.hoisted(() => ({ current: null as null | import("node:events").EventEmitter }));
vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      const c = new EventEmitter() as EventEmitter & { subscribe: () => void; end: () => void };
      c.subscribe = () => {};
      c.end = () => {};
      mqttClient.current = c;
      return c;
    }),
  },
}));

// WARP-2904: the dial-time DNS check resolves the push host; keep it offline.
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

// Frigate: one event / review / clip on each camera. The list fetchers
// ignore the camera filter on purpose (see header).
const FRONT_EVENT = { id: "ev-front", camera: "front_door", label: "person", has_clip: true, has_snapshot: true, start_time: 2 };
const BED_EVENT = { id: "ev-bed", camera: "bedroom", label: "person", has_clip: true, has_snapshot: true, start_time: 1 };
const FRONT_REVIEW = { id: "rv-front", camera: "front_door", severity: "alert", start_time: 2, data: {} };
const BED_REVIEW = { id: "rv-bed", camera: "bedroom", severity: "alert", start_time: 1, data: {} };
const EVENT_CAMERA: Record<string, string> = { "ev-front": "front_door", "ev-bed": "bedroom" };
const REVIEW_CAMERA: Record<string, string> = { "rv-front": "front_door", "rv-bed": "bedroom" };

vi.mock("../services/frigate.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/frigate.client.js")>();
  return {
    ...actual,
    healthCheck: vi.fn().mockResolvedValue(true),
    fetchEvents: vi.fn(async () => [FRONT_EVENT, BED_EVENT]),
    fetchEventsFiltered: vi.fn(async () => [FRONT_EVENT, BED_EVENT]),
    searchEventsSemantic: vi.fn(async () => [FRONT_EVENT, BED_EVENT]),
    fetchReviews: vi.fn(async () => [FRONT_REVIEW, BED_REVIEW]),
    fetchEventCamera: vi.fn(async (id: string) => EVENT_CAMERA[id] ?? null),
    fetchReviewCamera: vi.fn(async (id: string) => REVIEW_CAMERA[id] ?? null),
    fetchEventThumbnail: vi.fn(async () => new Response("jpg")),
    markReviewViewed: vi.fn().mockResolvedValue(undefined),
    regenerateEventDescription: vi.fn().mockResolvedValue(undefined),
    tagEventAsFace: vi.fn().mockResolvedValue(undefined),
    openBirdseyeStream: vi.fn(async () => new Response("mjpeg")),
    // Frigate's /api/faces lists every folder under its faces dir: the
    // curated roster AND `train`, its recent recognition attempts — crops
    // named `{event_id}-{timestamp}-{sub_label}-{score}.webp`, from any camera.
    fetchKnownFaces: vi.fn(async () => [
      { name: "Alice", images: [{ name: "alice-1.webp", imageUrl: "" }] },
      {
        name: "train",
        images: [{ name: "1790000000.1-abc123-1790000001.2-unknown-0.81.webp", imageUrl: "" }],
      },
    ]),
    fetchFaceImage: vi.fn(async () => new Response("webp")),
    deleteFaceImage: vi.fn().mockResolvedValue(undefined),
  };
});

import { createCamerasRouter } from "../routes/cameras.js";
import * as frigate from "../services/frigate.client.js";
import {
  initCameraService,
  shutdownCameraService,
  subscribeCameraEvents,
} from "../services/camera.service.js";
import { resetCameraEventGateForTests } from "../services/camera-event-gate.js";
import { dispatchDetectionEvent } from "../services/push-dispatch.service.js";
import webpush from "web-push";
import type { CameraSSEEvent } from "../types/camera.js";

const GRANTS: Record<string, string[]> = { "u-family": ["front_door"] };
const grantFindMany = vi.fn(async ({ where }: { where: { userId: string } }) =>
  (GRANTS[where.userId] ?? []).map((name) => ({ camera: { name } })),
);

const prisma = {
  camera: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn(async ({ where }: { where: { name: string } }) => ({
      id: `id-${where.name}`,
      name: where.name,
      displayName: null,
    })),
  },
  cameraAccessGrant: {
    findMany: grantFindMany,
  },
  user: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, role: id.slice(2) })),
    ),
  },
  cameraNotificationPref: {
    // Both people asked to be told about the bedroom.
    findMany: vi.fn(async () => [
      { userId: "u-family", cameraId: "id-bedroom" },
      { userId: "u-owner", cameraId: "id-bedroom" },
    ]),
  },
  pushSubscription: {
    findMany: vi.fn(async ({ where }: { where: { username: string } }) => [
      // WARP-2904: only a real push-service host is dialled.
      { endpoint: `https://fcm.googleapis.com/fcm/send/${where.username}`, p256dhKey: "k", authKey: "a" },
    ]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  // WARP-2904: dispatchToUser reads the web_push off-LAN gate first; open it
  // so this suite exercises the per-camera grant filter, not the gate.
  offLanAllowlistChannel: {
    findUnique: vi.fn().mockResolvedValue({ key: "web_push", enabled: true }),
  },
} as never;

function appAs(role: Role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: `u-${role}`, username: role, displayName: role, role };
    next();
  });
  app.use("/api", createCamerasRouter(prisma));
  return app;
}

const sam = () => request(appAs("family"));
const owner = () => request(appAs("owner"));

/** Every camera name that appears anywhere in a JSON body. */
function camerasIn(body: unknown): string[] {
  return [...JSON.stringify(body).matchAll(/"camera":"([^"]+)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("media")));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cross-camera lists show a scoped user only their cameras", () => {
  const LISTS = [
    "/api/cameras/events",
    "/api/cameras/events/search?query=person",
    "/api/cameras/events/recent",
    "/api/cameras/reviews",
    "/api/cameras/clips",
  ];

  it.each(LISTS)("GET %s → nothing from the bedroom", async (path) => {
    const res = await sam().get(path);
    expect(res.status).toBe(200);
    const cams = camerasIn(res.body);
    expect(cams.length).toBeGreaterThan(0); // non-vacuous: front_door is there
    expect(cams).not.toContain("bedroom");
    expect(new Set(cams)).toEqual(new Set(["front_door"]));
  });

  it.each(LISTS)("GET %s → an owner still sees every camera", async (path) => {
    const res = await owner().get(path);
    expect(res.status).toBe(200);
    expect(new Set(camerasIn(res.body))).toEqual(new Set(["front_door", "bedroom"]));
  });

  it("narrows the Frigate query itself, before the limit applies", async () => {
    await sam().get("/api/cameras/events?limit=10");
    expect(vi.mocked(frigate.fetchEventsFiltered)).toHaveBeenCalledWith(
      expect.objectContaining({ cameras: ["front_door"], limit: 10 }),
    );
    await sam().get("/api/cameras/reviews");
    expect(vi.mocked(frigate.fetchReviews)).toHaveBeenCalledWith(
      expect.objectContaining({ cameras: ["front_door"] }),
    );
    await sam().get("/api/cameras/events/search?query=x");
    expect(vi.mocked(frigate.searchEventsSemantic)).toHaveBeenCalledWith(
      expect.objectContaining({ cameras: ["front_door"] }),
    );
    await sam().get("/api/cameras/events/recent");
    expect(vi.mocked(frigate.fetchEvents)).toHaveBeenCalledWith(20, ["front_door"]);
  });

  it("asking for the bedroom by name returns nothing, not the bedroom", async () => {
    const res = await sam().get("/api/cameras/events?cameras=bedroom");
    expect(res.status).toBe(200);
    expect(camerasIn(res.body)).not.toContain("bedroom");
    // The request is narrowed to NO cameras; the real client answers that
    // with [] (pinned at the bottom of this file).
    expect(vi.mocked(frigate.fetchEventsFiltered)).toHaveBeenCalledWith(
      expect.objectContaining({ cameras: [] }),
    );
  });

  it("a user with no grants at all gets empty lists", async () => {
    GRANTS["u-family"] = [];
    try {
      expect((await sam().get("/api/cameras/events/recent")).body.events).toEqual([]);
      expect((await sam().get("/api/cameras/events")).body.events).toEqual([]);
      expect((await sam().get("/api/cameras/reviews")).body.reviews).toEqual([]);
    } finally {
      GRANTS["u-family"] = ["front_door"];
    }
  });
});

describe("routes addressed by event / review id check the owning camera", () => {
  const BY_ID: Array<[string, string, string]> = [
    ["get", "/api/cameras/events/ev-bed/thumbnail", "/api/cameras/events/ev-front/thumbnail"],
    ["get", "/api/cameras/events/ev-bed/snapshot", "/api/cameras/events/ev-front/snapshot"],
    ["get", "/api/cameras/clips/event/ev-bed", "/api/cameras/clips/event/ev-front"],
    ["post", "/api/cameras/events/ev-bed/regenerate-description", "/api/cameras/events/ev-front/regenerate-description"],
    ["post", "/api/cameras/faces/sam/from-event/ev-bed", "/api/cameras/faces/sam/from-event/ev-front"],
    ["get", "/api/cameras/reviews/rv-bed/preview", "/api/cameras/reviews/rv-front/preview"],
    ["get", "/api/cameras/reviews/rv-bed/thumbnail", "/api/cameras/reviews/rv-front/thumbnail"],
    ["post", "/api/cameras/reviews/rv-bed/viewed", "/api/cameras/reviews/rv-front/viewed"],
  ];

  it.each(BY_ID)("%s %s → 404, and Frigate media is never fetched", async (verb, denied) => {
    const res = await (sam() as never as Record<string, (p: string) => Promise<{ status: number }>>)[verb](denied);
    expect(res.status).toBe(404);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(frigate.fetchEventThumbnail)).not.toHaveBeenCalled();
  });

  it.each(BY_ID)("%s (granted twin of %s) %s → allowed", async (verb, _denied, allowed) => {
    const res = await (sam() as never as Record<string, (p: string) => Promise<{ status: number }>>)[verb](allowed);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("an owner deletes a bedroom event without a lookup hop", async () => {
    vi.spyOn(frigate, "deleteEvent").mockResolvedValue(undefined);
    const res = await owner().delete("/api/cameras/events/ev-bed");
    expect(res.status).toBe(200);
    expect(vi.mocked(frigate.fetchEventCamera)).not.toHaveBeenCalled();
  });
});

describe("WARP-3013: Frigate's `train` face crops are for all-camera viewers only", () => {
  const CROP = "1790000000.1-abc123-1790000001.2-unknown-0.81.webp";
  const faceNames = (body: { faces: Array<{ name: string }> }) => body.faces.map((f) => f.name);

  it("the face list hides `train` from a scoped user and keeps the roster", async () => {
    const res = await sam().get("/api/cameras/faces");
    expect(res.status).toBe(200);
    expect(faceNames(res.body)).toEqual(["Alice"]);
  });

  it("an owner still sees `train`", async () => {
    const res = await owner().get("/api/cameras/faces");
    expect(res.status).toBe(200);
    expect(faceNames(res.body)).toEqual(["Alice", "train"]);
  });

  it("a grant on every current camera is still not 'all': a new camera would be ungranted", async () => {
    GRANTS["u-family"] = ["front_door", "bedroom"];
    try {
      expect(faceNames((await sam().get("/api/cameras/faces")).body)).toEqual(["Alice"]);
    } finally {
      GRANTS["u-family"] = ["front_door"];
    }
  });

  it("a scoped user gets 404 for a `train` crop, and Frigate is never asked", async () => {
    const res = await sam().get(`/api/cameras/faces/train/images/${CROP}`);
    expect(res.status).toBe(404);
    expect(vi.mocked(frigate.fetchFaceImage)).not.toHaveBeenCalled();
  });

  it("a scoped user still opens a roster image; an owner opens a `train` crop", async () => {
    expect((await sam().get("/api/cameras/faces/Alice/images/alice-1.webp")).status).toBe(200);
    expect(vi.mocked(frigate.fetchFaceImage)).toHaveBeenLastCalledWith("Alice", "alice-1.webp");
    expect((await owner().get(`/api/cameras/faces/train/images/${CROP}`)).status).toBe(200);
    expect(vi.mocked(frigate.fetchFaceImage)).toHaveBeenLastCalledWith("train", CROP);
  });

  it("a scoped user cannot delete a `train` crop", async () => {
    const res = await sam().delete(`/api/cameras/faces/train/images/${CROP}`);
    expect(res.status).toBe(404);
    expect(vi.mocked(frigate.deleteFaceImage)).not.toHaveBeenCalled();
  });

  it("a scoped user still removes a roster image; an owner removes a `train` crop", async () => {
    expect((await sam().delete("/api/cameras/faces/Alice/images/alice-1.webp")).status).toBe(204);
    expect((await owner().delete(`/api/cameras/faces/train/images/${CROP}`)).status).toBe(204);
    expect(vi.mocked(frigate.deleteFaceImage).mock.calls).toEqual([
      ["Alice", "alice-1.webp"],
      ["train", CROP],
    ]);
  });

  it("a scoped user cannot tag an event's face into `train`, even from their own camera", async () => {
    // ev-front is Sam's camera, so the event guard passes; the folder is
    // still the all-camera one, and Sam may not write into what they cannot see.
    const res = await sam().post("/api/cameras/faces/train/from-event/ev-front");
    expect(res.status).toBe(404);
    expect(vi.mocked(frigate.tagEventAsFace)).not.toHaveBeenCalled();
  });

  it("an owner can still clear the whole `train` folder", async () => {
    const res = await owner().delete("/api/cameras/faces/train");
    expect(res.status).toBe(204);
  });
});

describe("birdseye composites every camera, so only an all-camera viewer gets it", () => {
  it("404s a scoped user without opening the stream", async () => {
    const res = await sam().get("/api/cameras/birdseye/live");
    expect(res.status).toBe(404);
    expect(vi.mocked(frigate.openBirdseyeStream)).not.toHaveBeenCalled();
  });

  it("still serves an owner", async () => {
    await owner().get("/api/cameras/birdseye/live");
    expect(vi.mocked(frigate.openBirdseyeStream)).toHaveBeenCalled();
  });
});

/**
 * A Frigate tracked-object message, as MQTT delivers it. Detections are the
 * live stream this ticket is about, and they broadcast synchronously. They
 * carry no label: an unlabelled detection skips push fan-out, so nothing
 * async outlives the test.
 */
function frigateEvent(type: "new" | "update", id: string, camera: string) {
  mqttClient.current!.emit(
    "message",
    "frigate/events",
    Buffer.from(JSON.stringify({ type, after: { id, camera } })),
  );
}

/** Let pending promise callbacks (the scope refresh) run. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("the live SSE stream is filtered per subscriber", () => {
  beforeEach(async () => {
    resetCameraEventGateForTests();
    await initCameraService(prisma);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownCameraService();
  });

  it("a scoped subscriber never receives another camera's events", () => {
    const samSaw: CameraSSEEvent[] = [];
    const ownerSaw: CameraSSEEvent[] = [];
    let samScope: Set<string> = new Set(["front_door"]);
    subscribeCameraEvents((e) => samSaw.push(e), () => samScope);
    subscribeCameraEvents((e) => ownerSaw.push(e), () => "all");

    frigateEvent("new", "ev-f1", "front_door");
    frigateEvent("new", "ev-b1", "bedroom");

    expect(samSaw.map((e) => e.camera)).toEqual(["front_door"]);
    expect(ownerSaw.map((e) => e.camera)).toEqual(["front_door", "bedroom"]);

    // Scope is read per event: a revoked grant takes effect on the next one.
    samScope = new Set();
    frigateEvent("update", "ev-f1", "front_door");
    expect(ownerSaw).toHaveLength(3); // non-vacuous: the update WAS broadcast
    expect(samSaw).toHaveLength(1);
  });

  // The tests above prove the service filters by whatever scope it is
  // handed. These prove the ROUTE hands it the caller's scope and keeps it
  // current: each opens the real `/api/cameras/events/sse` over HTTP.

  /** Open the SSE route as `role`; collect what it streams. */
  async function openStream(role: Role) {
    const server = appAs(role).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    let body = "";
    const req = http.get({ host: "127.0.0.1", port, path: "/api/cameras/events/sse" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
    });
    req.on("error", () => {}); // destroyed by close()
    await vi.waitFor(() => expect(body).toContain('"connected"'));
    return {
      text: () => body,
      cameras: () => [...body.matchAll(/"camera":"([^"]+)"/g)].map((m) => m[1]),
      heartbeats: () => body.split(": heartbeat").length - 1,
      close: async () => {
        req.destroy();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  /** Fire every open stream's 30 s heartbeat and wait until `stream` has it. */
  async function heartbeat(stream: { heartbeats: () => number }) {
    const before = stream.heartbeats();
    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(stream.heartbeats()).toBe(before + 1));
    await tick();
    await tick();
  }

  it("the route streams a scoped user only their cameras", async () => {
    const samStream = await openStream("family");
    const ownerStream = await openStream("owner");
    try {
      frigateEvent("new", "ev-f1", "front_door");
      frigateEvent("new", "ev-b1", "bedroom");
      // Sentinel on Sam's own camera. A stream is ordered, so anything
      // leaked before it has arrived by the time it does.
      frigateEvent("update", "ev-f1", "front_door");
      await vi.waitFor(() => expect(samStream.text()).toContain("detection_update"));
      expect(samStream.cameras()).toEqual(["front_door", "front_door"]);

      await vi.waitFor(() => expect(ownerStream.cameras()).toContain("bedroom")); // it was broadcast
    } finally {
      await samStream.close();
      await ownerStream.close();
    }
  });

  it("a grant revoked mid-stream stops the stream at the next heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const samStream = await openStream("family");
    const ownerStream = await openStream("owner");
    try {
      frigateEvent("new", "ev-f1", "front_door");
      await vi.waitFor(() => expect(samStream.cameras()).toEqual(["front_door"]));

      GRANTS["u-family"] = [];
      await heartbeat(samStream);

      frigateEvent("update", "ev-f1", "front_door");
      await vi.waitFor(() => expect(ownerStream.text()).toContain("detection_update"));
      await heartbeat(samStream); // sentinel: arrives after anything leaked
      expect(samStream.text()).not.toContain("detection_update");
    } finally {
      GRANTS["u-family"] = ["front_door"];
      await samStream.close();
      await ownerStream.close();
    }
  });

  it("a failed scope refresh narrows the stream to nothing, not the old answer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const samStream = await openStream("family");
    const ownerStream = await openStream("owner");
    try {
      frigateEvent("new", "ev-f1", "front_door");
      await vi.waitFor(() => expect(samStream.cameras()).toEqual(["front_door"]));

      // Only Sam's refresh reads grants (an owner's scope is "all").
      grantFindMany.mockRejectedValueOnce(new Error("db down"));
      await heartbeat(samStream);

      frigateEvent("update", "ev-f1", "front_door");
      await vi.waitFor(() => expect(ownerStream.text()).toContain("detection_update"));
      await heartbeat(samStream);
      expect(samStream.text()).not.toContain("detection_update");
    } finally {
      await samStream.close();
      await ownerStream.close();
    }
  });
});

describe("push notifications follow grants, not just prefs", () => {
  it("only people who may see the camera are notified", async () => {
    await dispatchDetectionEvent(prisma, {
      eventId: "ev-bed",
      cameraName: "bedroom",
      label: "person",
      score: 0.9,
    });
    await vi.waitFor(() => expect(vi.mocked(webpush.sendNotification)).toHaveBeenCalled());
    const endpoints = vi
      .mocked(webpush.sendNotification)
      .mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint);
    expect(endpoints).toEqual(["https://fcm.googleapis.com/fcm/send/u-owner"]);
  });
});

describe("the Frigate client reads an empty camera filter as 'nothing'", () => {
  it.each([
    ["fetchEventsFiltered", (m: typeof frigate) => m.fetchEventsFiltered({ cameras: [] })],
    ["fetchReviews", (m: typeof frigate) => m.fetchReviews({ cameras: [] })],
    ["searchEventsSemantic", (m: typeof frigate) => m.searchEventsSemantic({ query: "x", cameras: [] })],
    ["fetchEvents", (m: typeof frigate) => m.fetchEvents(20, [])],
  ])("%s([]) → [] without querying Frigate for every camera", async (_name, call) => {
    const actual = await vi.importActual<typeof frigate>("../services/frigate.client.js");
    expect(await call(actual)).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

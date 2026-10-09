/**
 * WARP-3927 — `summarize_camera_activity`: one bounded summary over events,
 * review items and recorded motion, that never reads as an all-clear when the
 * data is partial.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatMedia } from "@droplet/shared-types";
import summarizeCameraActivity from "../../../src/handlers/cameras/summarize-camera-activity.js";
import { cameraCtx, json, NOW_EPOCH, NOW_ISO, type RouteFn } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;

/** Mirrors MODEL_TOOL_RESULT_CAP_CHARS in the orchestrator's tool-result-bounding.ts (8000). */
const MODEL_RESULT_CAP = 8000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

const AFTER = epoch("2026-10-08T00:00:00Z"); // 17:00 PDT on the 7th
const BEFORE = NOW_EPOCH; // 12 h
const WINDOW_SECONDS = BEFORE - AFTER;

const event = (id: string, camera: string, label: string, atIso: string, extra: Record<string, unknown> = {}) => ({
  id,
  camera,
  label,
  score: 0.7,
  startTime: epoch(atIso),
  endTime: epoch(atIso) + 20,
  hasClip: true,
  hasSnapshot: true,
  description: null,
  ...extra,
});

const review = (camera: string, severity: string, atIso: string, extra: Record<string, unknown> = {}) => ({
  id: `r-${camera}-${atIso}`,
  camera,
  severity,
  startTime: epoch(atIso),
  endTime: epoch(atIso) + 60,
  hasBeenReviewed: false,
  objects: ["person"],
  zones: ["porch"],
  detectionIds: [],
  ...extra,
});

const fullCoverage = (cameras = ["front_door"]) => ({
  after: AFTER,
  before: BEFORE,
  partial: false,
  cameras: cameras.map((camera) => ({ camera, recordedSeconds: WINDOW_SECONDS, hasGaps: false, available: true })),
});

interface Fixture {
  events?: RouteFn;
  reviews?: RouteFn;
  motion?: RouteFn;
}
function setup(f: Fixture = {}, timezone: string | null = "America/Los_Angeles") {
  return cameraCtx(
    {
      "/api/cameras/events": f.events ?? (() => json(200, { events: [], nextCursor: null, scanLimitReached: false })),
      "/api/cameras/reviews": f.reviews ?? (() => json(200, { reviews: [], nextCursor: null })),
      "/api/cameras/motion":
        f.motion ?? (() => json(200, { activity: [], nextCursor: null, scanLimitReached: false, coverage: fullCoverage() })),
    },
    timezone,
  );
}

function data(r: Awaited<ReturnType<typeof summarizeCameraActivity.handler>>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("summarize_camera_activity — what it reads", () => {
  it("reads events, reviews and motion for the same window and camera, with epoch seconds", async () => {
    const { ctx, calls } = setup();
    await summarizeCameraActivity.handler({ camera: "front_door", after: "2026-10-07 17:00" }, ctx);
    const byPath = Object.fromEntries(calls.map((c) => [c.path, c.params]));
    expect(Object.keys(byPath).sort()).toEqual(["/api/cameras/events", "/api/cameras/motion", "/api/cameras/reviews"]);
    expect(byPath["/api/cameras/events"]).toEqual({ cameras: "front_door", after: AFTER, before: BEFORE, limit: 200 });
    expect(byPath["/api/cameras/reviews"]).toEqual({ cameras: "front_door", after: AFTER, before: BEFORE, limit: 200 });
    expect(byPath["/api/cameras/motion"]).toEqual({ cameras: "front_door", after: AFTER, before: BEFORE, limit: 200 });
  });

  it("omits the camera filter when none is given", async () => {
    const { ctx, calls } = setup();
    await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx);
    for (const c of calls) expect(c.params).not.toHaveProperty("cameras");
  });

  it("pages events newest-first with the route's cursor, up to 3 pages", async () => {
    let page = 0;
    const events: RouteFn = (params) => {
      page++;
      const start = epoch("2026-10-08T10:00:00Z") - page * 600;
      return json(200, {
        events: [event(`p${page}`, "front_door", "person", new Date(start * 1000).toISOString())],
        nextCursor: start,
      });
    };
    const { ctx, calls } = setup({ events });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    const eventCalls = calls.filter((c) => c.path === "/api/cameras/events");
    expect(eventCalls).toHaveLength(3);
    expect(eventCalls[0].params.before).toBe(BEFORE);
    expect(eventCalls[1].params.before).toBe(epoch("2026-10-08T10:00:00Z") - 600);
    expect(d.detections.total).toBe(3);
    // a third page that still had a cursor means events were left unread
    expect(d.incomplete).toBe(true);
    expect(d.incompleteReasons.join(" ")).toMatch(/most recent detections/);
  });

  it("stops paging when the route reports no more events", async () => {
    const { ctx, calls } = setup({ events: () => json(200, { events: [event("e1", "front_door", "person", "2026-10-08T03:00:00Z")], nextCursor: null }) });
    await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx);
    expect(calls.filter((c) => c.path === "/api/cameras/events")).toHaveLength(1);
  });
});

describe("summarize_camera_activity — the summary", () => {
  it("counts per label and per local hour, alerts first with local times, motion and coverage", async () => {
    const events = [
      event("e1", "front_door", "person", "2026-10-08T01:10:00Z"), // 18:10 PDT
      event("e2", "front_door", "person", "2026-10-08T01:40:00Z"), // 18:40
      event("e3", "driveway", "car", "2026-10-08T03:05:00Z"), // 20:05
    ];
    const reviews = [
      review("front_door", "detection", "2026-10-08T01:00:00Z"),
      review("front_door", "alert", "2026-10-08T01:40:00Z", { detectionIds: ["e2"] }),
      review("driveway", "significant_motion", "2026-10-08T03:00:00Z"),
    ];
    const activity = [
      { id: "m1", camera: "front_door", startTime: epoch("2026-10-08T01:00:00Z"), endTime: epoch("2026-10-08T01:30:00Z"), motion: 900, outsideBusinessHours: null, playbackUrl: "/x" },
      { id: "m2", camera: "driveway", startTime: epoch("2026-10-08T03:00:00Z"), endTime: epoch("2026-10-08T03:10:00Z"), motion: 40, outsideBusinessHours: null, playbackUrl: "/x" },
    ];
    const { ctx } = setup({
      events: () => json(200, { events, nextCursor: null }),
      reviews: () => json(200, { reviews, nextCursor: null }),
      motion: () => json(200, { activity, nextCursor: null, coverage: fullCoverage(["front_door", "driveway"]) }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));

    expect(d.timezone).toBe("America/Los_Angeles");
    expect(d.period).toMatchObject({ start: "2026-10-07T17:00:00-07:00", end: "2026-10-08T05:00:00-07:00", length: "12h 00m" });
    expect(d.detections.total).toBe(3);
    expect(d.detections.byLabel).toEqual({ person: 2, car: 1 });
    expect(d.detections.byCamera).toEqual({ front_door: 2, driveway: 1 });
    expect(d.detections.perHour).toEqual([
      { hour: "2026-10-07 18:00", detections: 2 },
      { hour: "2026-10-07 20:00", detections: 1 },
    ]);
    expect(d.reviews).toMatchObject({ alert: 1, detection: 1, significant_motion: 1 });
    expect(d.reviews.alerts).toEqual([
      { camera: "front_door", start: "2026-10-07T18:40:00-07:00", end: "2026-10-07T18:41:00-07:00", objects: ["person"], zones: ["porch"], reviewed: false },
    ]);
    expect(d.motion.spanCount).toBe(2);
    expect(d.motion.mostActive[0]).toEqual({ camera: "front_door", start: "2026-10-07T18:00:00-07:00", end: "2026-10-07T18:30:00-07:00", motion: 900 });
    expect(d.incomplete).toBe(false);
    expect(d.incompleteReasons).toBeUndefined();
    expect(d.coverageNote).toBe("Footage covers 24h 00m of the 24h 00m asked for across 2 cameras; there are no gaps.");
    expect(d.headline).toBe("3 detections (person 2, car 1); 1 alert; motion in 2 spans.");
  });

  it("includes GenAI descriptions for the strongest events, trimmed", async () => {
    const long = "A person in a red jacket walks up to the door and leaves a parcel. ".repeat(10);
    const events = [
      event("e1", "front_door", "person", "2026-10-08T01:10:00Z", { score: 0.95, description: long }),
      event("e2", "front_door", "car", "2026-10-08T01:20:00Z", { score: 0.5, description: "A van pulls up." }),
      event("e3", "front_door", "dog", "2026-10-08T01:30:00Z", { score: 0.99 }),
    ];
    const { ctx } = setup({ events: () => json(200, { events, nextCursor: null }) });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.notable.map((n: { label: string }) => n.label)).toEqual(["person", "car"]);
    expect(d.notable[0].description.length).toBe(200);
    expect(d.notable[0]).toMatchObject({ camera: "front_door", time: "2026-10-07T18:10:00-07:00", score: 0.95 });
  });

  it("a quiet period with FULL coverage can say nothing happened, plainly", async () => {
    const { ctx } = setup();
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(false);
    expect(d.headline).toBe("No detections were recorded; no alerts; no motion in the footage that exists.");
    expect(d.media).toBeUndefined();
  });
});

describe("summarize_camera_activity — never an all-clear on partial data", () => {
  it("footage gaps make it incomplete and the headline says it is not an all-clear", async () => {
    const { ctx } = setup({
      motion: () =>
        json(200, {
          activity: [],
          nextCursor: null,
          coverage: { after: AFTER, before: BEFORE, partial: false, cameras: [{ camera: "front_door", recordedSeconds: WINDOW_SECONDS - 3 * 3600, hasGaps: true, available: true }] },
        }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(true);
    expect(d.coverageNote).toBe(
      "Footage covers 9h 00m of the 12h 00m asked for; 180 minutes have no recording. Activity during the missing stretches is unknown; do not treat it as quiet.",
    );
    expect(d.incompleteReasons).toEqual(["no recording for part of the period (front_door)"]);
    expect(d.headline).toMatch(/THIS IS NOT AN ALL-CLEAR/);
  });

  it("a failed source is named and the rest still comes back", async () => {
    const { ctx } = setup({
      events: () => json(503, {}),
      reviews: () => json(200, { reviews: [review("front_door", "alert", "2026-10-08T01:40:00Z")], nextCursor: null }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(true);
    expect(d.incompleteReasons).toContain("detections unavailable (orchestrator returned 503)");
    expect(d.reviews.alert).toBe(1);
    expect(d.headline).toMatch(/1 alert/);
    expect(d.headline).not.toMatch(/No detections/);
  });

  it("a thrown transport error is treated like a failed source", async () => {
    const { ctx } = setup({
      motion: () => {
        throw new Error("socket hang up");
      },
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(true);
    expect(d.incompleteReasons).toContain("motion unavailable (orchestrator not reachable)");
    expect(d.coverageNote).toMatch(/not an all-clear/);
    expect(d.motion).toBeNull();
  });

  it("fails with SUMMARY_FAILED only when every source failed", async () => {
    const { ctx } = setup({ events: () => json(500, {}), reviews: () => json(500, {}), motion: () => json(500, {}) });
    const r = await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SUMMARY_FAILED");
      expect(r.error.message).toMatch(/detections unavailable.*review items unavailable.*motion unavailable/);
    }
  });

  it("flags a scan limit, extra review items and extra motion spans", async () => {
    const { ctx } = setup({
      events: () => json(200, { events: [], nextCursor: null, scanLimitReached: true }),
      reviews: () => json(200, { reviews: [], nextCursor: 123 }),
      motion: () => json(200, { activity: [], nextCursor: 5, coverage: fullCoverage() }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(true);
    expect(d.incompleteReasons).toEqual([
      "the detection scan limit was reached; older matches may exist",
      "more review items exist than were read",
      "more motion spans exist than were read",
    ]);
  });

  it("an unreadable camera in the motion coverage is incomplete", async () => {
    const { ctx } = setup({
      motion: () =>
        json(200, {
          activity: [],
          nextCursor: null,
          coverage: { after: AFTER, before: BEFORE, partial: true, cameras: [{ camera: "yard", recordedSeconds: null, hasGaps: true, available: false }] },
        }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.incomplete).toBe(true);
    expect(d.coverageNote).toContain("could not be read for yard");
  });
});

describe("summarize_camera_activity — stills for the vision injection", () => {
  const events = [
    event("1791450000.1-low", "front_door", "person", "2026-10-08T01:00:00Z", { score: 0.4 }),
    event("1791450100.1-high", "driveway", "car", "2026-10-08T01:10:00Z", { score: 0.95 }),
    event("1791450200.1-alert", "front_door", "person", "2026-10-08T01:20:00Z", { score: 0.6 }),
    event("1791450300.1-mid", "garage", "dog", "2026-10-08T01:30:00Z", { score: 0.8 }),
    event("1791450400.1-fifth", "garage", "cat", "2026-10-08T01:40:00Z", { score: 0.7 }),
    event("1791450500.1-nosnap", "garage", "cat", "2026-10-08T01:50:00Z", { score: 1, hasSnapshot: false }),
  ];

  it("returns at most 4 event stills, alert-linked first then highest score, each with its eventId", async () => {
    const { ctx } = setup({
      events: () => json(200, { events, nextCursor: null }),
      reviews: () => json(200, { reviews: [review("front_door", "alert", "2026-10-08T01:20:00Z", { detectionIds: ["1791450200.1-alert"] })], nextCursor: null }),
    });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    const media = parseChatMedia(d);
    expect(media).toHaveLength(4);
    expect(media.every((m) => m.kind === "camera_snapshot")).toBe(true);
    expect(media.map((m) => (m as { eventId: string }).eventId)).toEqual([
      "1791450200.1-alert",
      "1791450100.1-high",
      "1791450300.1-mid",
      "1791450400.1-fifth",
    ]);
    expect(media[0]).toMatchObject({
      camera: "front_door",
      snapshotUrl: "/api/cameras/events/1791450200.1-alert/snapshot",
      label: "person 18:20",
    });
    // an eventId (not a bare camera snapshot) is what makes tool-vision fetch the saved still, not the live frame
    expect(media.every((m) => "eventId" in m)).toBe(true);
  });

  it("returns no stills when no event has a snapshot", async () => {
    const { ctx } = setup({ events: () => json(200, { events: [event("e1", "a", "person", "2026-10-08T01:00:00Z", { hasSnapshot: false })], nextCursor: null }) });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.media).toBeUndefined();
  });

  it("skips an event id that cannot be a safe id", async () => {
    const { ctx } = setup({ events: () => json(200, { events: [event("../../etc/passwd", "a", "person", "2026-10-08T01:00:00Z")], nextCursor: null }) });
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.media).toBeUndefined();
    expect(d.detections.total).toBe(1);
  });
});

describe("summarize_camera_activity — bounds and validation", () => {
  it("stays under the model's per-call result cap on a busy night", async () => {
    const labels = ["person", "car", "dog", "cat", "bicycle", "truck", "bird", "package"];
    const events = Array.from({ length: 200 }, (_, i) =>
      event(`${1791450000 + i}.1-ev${i}`, `cam_${i % 12}`, labels[i % labels.length], new Date((AFTER + 60 + i * 200) * 1000).toISOString(), {
        score: 0.5 + (i % 50) / 100,
        description: `Description number ${i}: ${"someone walks across the frame and pauses ".repeat(8)}`,
      }),
    );
    const reviews = Array.from({ length: 40 }, (_, i) => review(`cam_${i % 12}`, i % 3 === 0 ? "alert" : "detection", new Date((AFTER + 120 + i * 900) * 1000).toISOString()));
    const activity = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      camera: `cam_${i % 12}`,
      startTime: AFTER + i * 600,
      endTime: AFTER + i * 600 + 300,
      motion: i,
      outsideBusinessHours: null,
      playbackUrl: "/x",
    }));
    const { ctx } = setup({
      events: () => json(200, { events, nextCursor: null }),
      reviews: () => json(200, { reviews, nextCursor: null }),
      motion: () =>
        json(200, {
          activity,
          nextCursor: null,
          coverage: fullCoverage(Array.from({ length: 12 }, (_, i) => `cam_${i}`)),
        }),
    });
    const r = await summarizeCameraActivity.handler({ after: "2026-10-07 17:00" }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    expect(JSON.stringify(r.data).length).toBeLessThan(MODEL_RESULT_CAP);
  });

  it.each([
    [{}, /after is required/],
    [{ after: "2026-10-07 17:00", before: "2026-10-07 16:00" }, /later than after/],
    [{ after: "2026-10-06 00:00", before: "2026-10-08 00:00" }, /26 hours/],
    [{ after: "2026-10-09 17:00" }, /future/],
    [{ after: "last night" }, /after/],
    [{ after: "2026-10-07 17:00", camera: "front door" }, /camera/],
  ])("rejects %j without calling the orchestrator", async (args, message) => {
    const { ctx, get } = setup();
    const r = await summarizeCameraActivity.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });

  it("clamps an end in the future to now and reports it", async () => {
    const { ctx, calls } = setup();
    const d = data(await summarizeCameraActivity.handler({ after: "2026-10-07 17:00", before: "2026-10-09 08:00" }, ctx));
    expect(calls.every((c) => c.params.before === BEFORE || c.path === "/api/cameras/events")).toBe(true);
    expect(d.period.endClampedToNow).toBe(true);
  });

  it("is a Tier-1 read", () => {
    expect(summarizeCameraActivity.name).toBe("summarize_camera_activity");
    expect(summarizeCameraActivity.requiresWrite).toBe(false);
    expect(summarizeCameraActivity.requiresConfirmation).toBe(false);
  });
});

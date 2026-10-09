/**
 * WARP-3927 — `list_camera_reviews`: Frigate review items, alerts first, local
 * times, thumbnails only through the route that exists for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatMedia } from "@droplet/shared-types";
import listCameraReviews from "../../../src/handlers/cameras/list-camera-reviews.js";
import { cameraCtx, json, NOW_ISO } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

const review = (id: string, severity: string, startIso: string, minutes: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  camera: "front_door",
  startTime: epoch(startIso),
  endTime: minutes === null ? null : epoch(startIso) + minutes * 60,
  severity,
  hasBeenReviewed: false,
  objects: ["person"],
  audio: [],
  zones: ["porch"],
  detectionIds: [],
  outsideBusinessHours: null,
  previewUrl: `/api/cameras/reviews/${id}/preview`,
  thumbnailUrl: `/api/cameras/reviews/${id}/thumbnail`,
  ...extra,
});

function data(r: Awaited<ReturnType<typeof listCameraReviews.handler>>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("list_camera_reviews", () => {
  it("calls GET /api/cameras/reviews with csv filters and epoch seconds", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [], nextCursor: null }) }, "America/Los_Angeles");
    await listCameraReviews.handler(
      { cameras: ["front_door", "garage"], severity: "alert,detection", after: "2026-10-07 18:00", before: "2026-10-07 22:00", business_hours: "inside" },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/cameras/reviews");
    expect(calls[0].params).toEqual({
      after: epoch("2026-10-08T01:00:00Z"),
      before: epoch("2026-10-08T05:00:00Z"),
      limit: 100,
      cameras: "front_door,garage",
      severity: "alert,detection",
      businessHours: "inside",
    });
  });

  it("puts alerts first, then detections, then significant motion; newest first within a severity", async () => {
    const reviews = [
      review("m1", "significant_motion", "2026-10-08T04:00:00Z", 3),
      review("d1", "detection", "2026-10-08T03:00:00Z", 3),
      review("a1", "alert", "2026-10-08T01:00:00Z", 3),
      review("a2", "alert", "2026-10-08T02:00:00Z", 3),
      review("d2", "detection", "2026-10-08T03:30:00Z", 3),
    ];
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews, nextCursor: null }) });
    const d = data(await listCameraReviews.handler({}, ctx));
    expect(d.reviews.map((r: { id: string }) => r.id)).toEqual(["a2", "a1", "d2", "d1", "m1"]);
    expect(d.counts).toEqual({ alert: 2, detection: 2, significant_motion: 1 });
  });

  it("returns local ISO times, objects and zones, with null for an item still in progress", async () => {
    const reviews = [review("a1", "alert", "2026-10-08T01:30:00Z", 2), review("a2", "alert", "2026-10-08T02:30:00Z", null, { hasBeenReviewed: true })];
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews }) }, "America/Los_Angeles");
    const d = data(await listCameraReviews.handler({}, ctx));
    expect(d.timezone).toBe("America/Los_Angeles");
    expect(d.reviews[0]).toEqual({
      id: "a2",
      camera: "front_door",
      severity: "alert",
      start: "2026-10-07T19:30:00-07:00",
      end: null,
      objects: ["person"],
      zones: ["porch"],
      reviewed: true,
    });
    expect(d.reviews[1].end).toBe("2026-10-07T18:32:00-07:00");
  });

  it("respects the limit, and says more exist", async () => {
    const reviews = Array.from({ length: 8 }, (_, i) => review(`d${i}`, "detection", `2026-10-08T0${i}:00:00Z`, 1));
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews, nextCursor: null }) });
    const d = data(await listCameraReviews.handler({ limit: 3 }, ctx));
    expect(d.reviews).toHaveLength(3);
    expect(d.count).toBe(3);
    expect(d.moreAvailable).toBe(true);
    expect(d.note).toMatch(/More review items/);
  });

  it("treats a route cursor or a scan limit as more available", async () => {
    const a = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [review("d1", "detection", "2026-10-08T01:00:00Z", 1)], nextCursor: 5 }) });
    expect(data(await listCameraReviews.handler({}, a.ctx)).moreAvailable).toBe(true);
    const b = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [], nextCursor: null, scanLimitReached: true }) });
    expect(data(await listCameraReviews.handler({}, b.ctx)).moreAvailable).toBe(true);
    const c = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [], nextCursor: null }) });
    expect(data(await listCameraReviews.handler({}, c.ctx)).moreAvailable).toBe(false);
  });

  it("emits thumbnail media only through /api/cameras/reviews/:id/thumbnail, for finished items, max 4", async () => {
    const reviews = [
      ...Array.from({ length: 5 }, (_, i) => review(`a${i}`, "alert", `2026-10-08T0${i + 1}:00:00Z`, 4)),
      review("live", "alert", "2026-10-08T09:00:00Z", null),
    ];
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews }) });
    const d = data(await listCameraReviews.handler({}, ctx));
    const media = parseChatMedia(d);
    expect(media).toHaveLength(4);
    for (const m of media) {
      expect(m.kind).toBe("camera_clip");
      const clip = m as { thumbnailUrl: string; playbackUrl: string; camera: string };
      expect(clip.thumbnailUrl).toMatch(/^\/api\/cameras\/reviews\/[a-z0-9]+\/thumbnail$/);
      expect(clip.playbackUrl).toMatch(/^\/api\/cameras\/front_door\/playback\.m3u8\?after=\d+&before=\d+$/);
    }
    // the in-progress item ("live") has no end, so no playable card
    expect(JSON.stringify(media)).not.toContain("/live/");
  });

  it("drops an id that cannot be a safe review id from the media", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [review("../../x", "alert", "2026-10-08T01:00:00Z", 2)] }) });
    const d = data(await listCameraReviews.handler({}, ctx));
    expect(d.media).toBeUndefined();
    expect(d.reviews).toHaveLength(1);
  });

  it("skips rows that lack the fields it needs rather than inventing them", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/reviews": () => json(200, { reviews: [{ id: "x" }, null, review("ok", "alert", "2026-10-08T01:00:00Z", 2)] }) });
    const d = data(await listCameraReviews.handler({}, ctx));
    expect(d.reviews.map((r: { id: string }) => r.id)).toEqual(["ok"]);
  });

  it.each([
    [{ severity: "critical" }, /severity/],
    [{ cameras: "front door" }, /cameras/],
    [{ cameras: 5 }, /cameras/],
    [{ business_hours: "maybe" }, /business_hours/],
    [{ after: "2026-10-07 22:00", before: "2026-10-07 18:00" }, /later than after/],
    [{ after: "2026-08-01", before: "2026-10-01" }, /31 days/],
    [{ after: "whenever" }, /after/],
  ])("rejects %j", async (args, message) => {
    const { ctx, get } = cameraCtx({});
    const r = await listCameraReviews.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });

  it("maps route failures", async () => {
    const denied = cameraCtx({ "/api/cameras/reviews": () => json(403, {}) });
    const r1 = await listCameraReviews.handler({}, denied.ctx);
    expect(!r1.ok && r1.error.code).toBe("CAMERA_ACCESS_DENIED");
    const down = cameraCtx({ "/api/cameras/reviews": () => json(500, {}) });
    const r2 = await listCameraReviews.handler({}, down.ctx);
    expect(!r2.ok && r2.error.code).toBe("REVIEWS_FAILED");
  });

  it("is a Tier-1 read", () => {
    expect(listCameraReviews.name).toBe("list_camera_reviews");
    expect(listCameraReviews.requiresWrite).toBe(false);
    expect(listCameraReviews.requiresConfirmation).toBe(false);
  });
});

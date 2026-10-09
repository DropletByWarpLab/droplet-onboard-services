/**
 * WARP-3747 — `list_camera_events` and `search_camera_events` take a period
 * (`after` / `before`), `labels` and `min_score`; every event comes back with
 * local ISO times next to the epoch fields.
 *
 * "What did the front door see between 6 and 8 yesterday evening?" could not
 * be asked before: the model got the newest N events and epoch numbers to
 * convert by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import listCameraEvents from "../../../src/handlers/cameras/list-camera-events.js";
import searchCameraEvents from "../../../src/handlers/cameras/search-camera-events.js";
import { cameraCtx, json, NOW_ISO } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;

const EVENT = {
  id: "1791421800.1-abc",
  camera: "front_door",
  label: "person",
  score: 0.83,
  startTime: epoch("2026-10-08T01:30:00Z") + 0.25,
  endTime: epoch("2026-10-08T01:30:40Z"),
  hasClip: true,
  hasSnapshot: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

describe("list_camera_events with a period (WARP-3747)", () => {
  it("routes a filtered question to GET /api/cameras/events with epoch seconds from workspace wall time", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/events": () => json(200, { events: [EVENT], nextCursor: null }) }, "America/Los_Angeles");
    const r = await listCameraEvents.handler(
      { camera_name: "front_door", after: "2026-10-07 18:00", before: "2026-10-07 20:00", labels: "person,car", min_score: 0.6, limit: 30 },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/cameras/events");
    expect(calls[0].params).toEqual({
      after: epoch("2026-10-08T01:00:00Z"),
      before: epoch("2026-10-08T03:00:00Z"),
      labels: "person,car",
      min_score: 0.6,
      limit: 30,
      cameras: "front_door",
    });
  });

  it("returns startTimeIso / endTimeIso in the workspace zone and KEEPS the epoch fields", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/events": () => json(200, { events: [EVENT], nextCursor: null }) }, "America/Los_Angeles");
    const r = await listCameraEvents.handler({ after: "2026-10-07 18:00" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    const d = r.data as { events: Array<Record<string, unknown>>; timezone: string; afterIso: string };
    expect(d.timezone).toBe("America/Los_Angeles");
    expect(d.afterIso).toBe("2026-10-07T18:00:00-07:00");
    expect(d.events[0]).toMatchObject({
      id: EVENT.id,
      startTime: EVENT.startTime,
      endTime: EVENT.endTime,
      startTimeIso: "2026-10-07T18:30:00-07:00",
      endTimeIso: "2026-10-07T18:30:40-07:00",
    });
  });

  it("uses the workspace zone for the ISO times even across a DST change", async () => {
    // 2026-11-01 05:30Z is 01:30 EDT; 06:30Z is 01:30 EST.
    const events = [
      { ...EVENT, id: "a", startTime: epoch("2026-11-01T05:30:00Z"), endTime: null },
      { ...EVENT, id: "b", startTime: epoch("2026-11-01T06:30:00Z"), endTime: null },
    ];
    const { ctx } = cameraCtx({ "/api/cameras/events": () => json(200, { events }) }, "America/New_York");
    const r = await listCameraEvents.handler({ labels: "person" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    const out = (r.data as { events: Array<{ startTimeIso: string; endTimeIso: null }> }).events;
    expect(out.map((e) => e.startTimeIso)).toEqual(["2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00"]);
    expect(out[0].endTimeIso).toBeNull();
  });

  it("keeps the cached recent-events routes when no filter is given, but still adds ISO times", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/events/recent": () => json(200, { events: [EVENT] }) }, "UTC");
    const r = await listCameraEvents.handler({}, ctx);
    expect(calls[0].path).toBe("/api/cameras/events/recent?limit=20");
    if (!r.ok) throw new Error("expected ok");
    expect((r.data as { events: Array<{ startTimeIso: string }> }).events[0].startTimeIso).toBe("2026-10-08T01:30:00+00:00");
  });

  it("accepts labels as an array", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/events": () => json(200, { events: [] }) });
    await listCameraEvents.handler({ labels: ["Dog", "cat"] }, ctx);
    expect(calls[0].params.labels).toBe("dog,cat");
  });

  it("flags a scan limit instead of implying the list is complete", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/events": () => json(200, { events: [], nextCursor: 5, scanLimitReached: true }) });
    const r = await listCameraEvents.handler({ labels: "person" }, ctx);
    if (!r.ok) throw new Error("expected ok");
    expect((r.data as { note: string }).note).toMatch(/Scan limit reached/);
  });

  it.each([
    [{ after: "2026-10-07 20:00", before: "2026-10-07 18:00" }, /later than after/],
    [{ after: "not a time" }, /after/],
    [{ before: "2026-13-45" }, /before/],
    [{ after: "2026-08-01", before: "2026-10-01" }, /31 days/],
    [{ after: "2026-10-12 09:00" }, /future/],
    [{ min_score: 3 }, /min_score/],
    [{ labels: "bad label!" }, /not a valid label/],
    [{ camera_name: "../etc" }, /camera_name/],
  ])("rejects %j before calling the orchestrator", async (args, message) => {
    const { ctx, get } = cameraCtx({});
    const r = await listCameraEvents.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });

  it("still maps a failing route to EVENTS_FAILED", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/events": () => json(502, {}) });
    const r = await listCameraEvents.handler({ labels: "person" }, ctx);
    expect(!r.ok && r.error.code).toBe("EVENTS_FAILED");
  });
});

describe("search_camera_events with a period (WARP-3747)", () => {
  it("forwards after/before as epoch seconds and returns ISO times", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/events/search": () => json(200, { events: [EVENT] }) }, "America/Los_Angeles");
    const r = await searchCameraEvents.handler({ query: "delivery truck", after: "2026-10-07 18:00", before: "2026-10-07 20:00" }, ctx);
    expect(calls[0].params).toEqual({
      query: "delivery truck",
      after: epoch("2026-10-08T01:00:00Z"),
      before: epoch("2026-10-08T03:00:00Z"),
    });
    if (!r.ok) throw new Error("expected ok");
    const d = r.data as { events: Array<Record<string, unknown>>; timezone: string; beforeIso: string };
    expect(d.events[0]).toMatchObject({ startTime: EVENT.startTime, startTimeIso: "2026-10-07T18:30:00-07:00" });
    expect(d.beforeIso).toBe("2026-10-07T20:00:00-07:00");
    expect(d.timezone).toBe("America/Los_Angeles");
  });

  it("sends no time params when none were given", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/events/search": () => json(200, { events: [] }) });
    await searchCameraEvents.handler({ query: "cat" }, ctx);
    expect(calls[0].params).toEqual({ query: "cat" });
  });

  it.each([
    [{ query: "x", after: "2026-10-07 20:00", before: "2026-10-07 18:00" }, /later than after/],
    [{ query: "x", after: "soon" }, /after/],
    [{ query: "x", after: "2026-10-12 09:00" }, /future/],
  ])("rejects %j", async (args, message) => {
    const { ctx, get } = cameraCtx({});
    const r = await searchCameraEvents.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });
});

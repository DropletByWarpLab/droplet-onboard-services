/**
 * WARP-3927 — `get_camera_recording`: footage for a moment or a range, checked
 * against the camera's real recording segments first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatMedia } from "@droplet/shared-types";
import getCameraRecording from "../../../src/handlers/cameras/get-camera-recording.js";
import { cameraCtx, json, NOW_EPOCH, NOW_ISO } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

/** Contiguous 10 s segments covering [fromIso, toIso). */
function segments(fromIso: string, toIso: string) {
  const out = [];
  for (let t = epoch(fromIso); t < epoch(toIso); t += 10) {
    out.push({ id: `s${t}`, startTime: t, endTime: t + 10, duration: 10, motion: 0, objects: 0 });
  }
  return out;
}

function data(r: Awaited<ReturnType<typeof getCameraRecording.handler>>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const RECORDINGS = "/api/cameras/front_door/recordings";
// 18:40 PDT on the 7th = 01:40Z on the 8th.
const AT = epoch("2026-10-08T01:40:00Z");

describe("get_camera_recording — a single moment", () => {
  it("looks up the 2-minute window around the instant, then returns a clip and a still from the recording", async () => {
    const { ctx, calls } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T01:38:00Z", "2026-10-08T01:42:00Z") }) }, "America/Los_Angeles");
    const d = data(await getCameraRecording.handler({ camera: "front_door", at: "2026-10-07 18:40" }, ctx));

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(RECORDINGS);
    expect(calls[0].params).toEqual({ after: AT - 60, before: AT + 60 });

    expect(d.footageAvailable).toBe(true);
    expect(d.snapshotAvailable).toBe(true);
    expect(d.at).toBe("2026-10-07T18:40:00-07:00");
    expect(d.period).toEqual({ start: "2026-10-07T18:39:00-07:00", end: "2026-10-07T18:41:00-07:00" });
    expect(d.coverageNote).toBe("Footage covers the whole 2m shown.");

    const media = parseChatMedia(d);
    expect(media.map((m) => m.kind)).toEqual(["camera_clip", "camera_snapshot"]);
    expect(media[0]).toMatchObject({
      camera: "front_door",
      clipUrl: `/api/cameras/front_door/playback?after=${AT - 60}&before=${AT + 60}`,
      playbackUrl: `/api/cameras/front_door/playback.m3u8?after=${AT - 60}&before=${AT + 60}`,
      startTime: AT - 60,
      endTime: AT + 60,
    });
    expect(media[1]).toMatchObject({
      camera: "front_door",
      snapshotUrl: `/api/cameras/front_door/recordings/snapshot?at=${AT}`,
    });
    // a past moment must never be offered a refresh or "go live", nor be tied to an event
    expect(media[1]).not.toHaveProperty("liveUrl");
    expect(media[1]).not.toHaveProperty("eventId");
  });

  it("says there is no footage, with the reason to give, and returns NO media", async () => {
    const { ctx } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: [] }) }, "America/Los_Angeles");
    const d = data(await getCameraRecording.handler({ camera: "front_door", at: "2026-10-07 18:40" }, ctx));
    expect(d.footageAvailable).toBe(false);
    expect(d.media).toBeUndefined();
    expect(d.coverageNote).toMatch(/No footage was recorded for front_door between 2026-10-07T18:39:00-07:00 and 2026-10-07T18:41:00-07:00/);
    expect(d.coverageNote).toMatch(/offline|only saves/);
  });

  it("gives the clip but no still when the instant itself falls in a gap", async () => {
    // footage 18:39:00-18:39:30 and 18:40:20-18:41:00; the instant 18:40:00 is in between
    const segs = [...segments("2026-10-08T01:39:00Z", "2026-10-08T01:39:30Z"), ...segments("2026-10-08T01:40:20Z", "2026-10-08T01:41:00Z")];
    const { ctx } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segs }) }, "America/Los_Angeles");
    const d = data(await getCameraRecording.handler({ camera: "front_door", at: "2026-10-07 18:40" }, ctx));
    expect(d.footageAvailable).toBe(true);
    expect(d.snapshotAvailable).toBe(false);
    expect(d.snapshotNote).toMatch(/No recording covers exactly 2026-10-07T18:40:00-07:00/);
    expect(parseChatMedia(d).map((m) => m.kind)).toEqual(["camera_clip"]);
    expect(d.coverageNote).toMatch(/minutes have no recording|Footage covers/);
  });

  it("states partial coverage in minutes", async () => {
    const { ctx } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T01:39:00Z", "2026-10-08T01:40:00Z") }) });
    const d = data(await getCameraRecording.handler({ camera: "front_door", at: "2026-10-07T18:40:00-07:00" }, ctx));
    expect(d.coverageNote).toBe("Footage covers 1m of the 2m shown; 1 minutes have no recording.");
  });

  it("an instant moments ago is cut back to now, not sent into the future", async () => {
    const { ctx, calls } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T11:58:00Z", "2026-10-08T12:00:00Z") }) });
    await getCameraRecording.handler({ camera: "front_door", at: "2026-10-08T11:59:30Z" }, ctx);
    expect(calls[0].params.before).toBe(NOW_EPOCH);
  });

  it("rejects an instant in the future", async () => {
    const { ctx, get } = cameraCtx({});
    const r = await getCameraRecording.handler({ camera: "front_door", at: "2026-10-09 09:00" }, ctx);
    expect(!r.ok && r.error.message).toMatch(/future/);
    expect(get).not.toHaveBeenCalled();
  });

  it("honours the workspace zone across a DST change", async () => {
    // 01:30 on 2026-11-01 in New York is ambiguous; the first occurrence is 05:30Z.
    const { ctx, calls } = cameraCtx({ "/api/cameras/front_door/recordings": () => json(200, { segments: [] }) }, "America/New_York");
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    await getCameraRecording.handler({ camera: "front_door", at: "2026-11-01 01:30" }, ctx);
    expect(calls[0].params).toEqual({ after: epoch("2026-11-01T05:29:00Z"), before: epoch("2026-11-01T05:31:00Z") });
  });
});

describe("get_camera_recording — a range", () => {
  it("returns a clip for the range and no still", async () => {
    const { ctx, calls } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T01:00:00Z", "2026-10-08T01:10:00Z") }) }, "America/Los_Angeles");
    const d = data(await getCameraRecording.handler({ camera: "front_door", starts_at: "2026-10-07 18:00", ends_at: "2026-10-07 18:10" }, ctx));
    expect(calls[0].params).toEqual({ after: epoch("2026-10-08T01:00:00Z"), before: epoch("2026-10-08T01:10:00Z") });
    expect(d.snapshotAvailable).toBeUndefined();
    expect(parseChatMedia(d).map((m) => m.kind)).toEqual(["camera_clip"]);
    expect(d.notes).toBeUndefined();
  });

  it("clamps a range over 30 minutes and says so", async () => {
    const { ctx, calls } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T01:00:00Z", "2026-10-08T01:30:00Z") }) }, "America/Los_Angeles");
    const d = data(await getCameraRecording.handler({ camera: "front_door", starts_at: "2026-10-07 18:00", ends_at: "2026-10-07 20:00" }, ctx));
    expect(calls[0].params).toEqual({ after: epoch("2026-10-08T01:00:00Z"), before: epoch("2026-10-08T01:30:00Z") });
    expect(d.period.end).toBe("2026-10-07T18:30:00-07:00");
    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]).toMatch(/limited to 30 minutes/);
  });

  it("cuts a range that ends in the future back to now and says so", async () => {
    const { ctx, calls } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: segments("2026-10-08T11:50:00Z", "2026-10-08T12:00:00Z") }) });
    const d = data(await getCameraRecording.handler({ camera: "front_door", starts_at: "2026-10-08T11:50:00Z", ends_at: "2026-10-08T13:00:00Z" }, ctx));
    expect(calls[0].params.before).toBe(NOW_EPOCH);
    expect(d.notes[0]).toMatch(/future/);
  });

  it("reports no footage for a range with none", async () => {
    const { ctx } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: [] }) });
    const d = data(await getCameraRecording.handler({ camera: "front_door", starts_at: "2026-10-08T01:00:00Z", ends_at: "2026-10-08T01:10:00Z" }, ctx));
    expect(d.footageAvailable).toBe(false);
    expect(d.media).toBeUndefined();
  });
});

describe("get_camera_recording — validation and errors", () => {
  it.each([
    [{}, /camera/],
    [{ camera: "bad name!", at: "2026-10-07 18:40" }, /camera/],
    [{ camera: "front_door" }, /either `at`/],
    [{ camera: "front_door", at: "2026-10-07 18:40", starts_at: "2026-10-07 18:00", ends_at: "2026-10-07 18:10" }, /either `at`/],
    [{ camera: "front_door", starts_at: "2026-10-07 18:00" }, /both starts_at and ends_at/],
    [{ camera: "front_door", ends_at: "2026-10-07 18:00" }, /both starts_at and ends_at/],
    [{ camera: "front_door", starts_at: "2026-10-07 18:10", ends_at: "2026-10-07 18:00" }, /later than starts_at/],
    [{ camera: "front_door", starts_at: "2026-10-09 18:00", ends_at: "2026-10-09 18:10" }, /future/],
    [{ camera: "front_door", at: "half past six" }, /at/],
    [{ camera: "front_door", at: "2026-03-08 02:30" }, /does not exist/],
  ])("rejects %j", async (args, message) => {
    // a zone where 2026-03-08 02:30 is skipped
    const { ctx, get } = cameraCtx({}, "America/New_York");
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const r = await getCameraRecording.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });

  it("maps 404 -> CAMERA_NOT_FOUND, 403 -> CAMERA_ACCESS_DENIED, other -> RECORDINGS_FAILED", async () => {
    const a = cameraCtx({ [RECORDINGS]: () => json(404, {}) });
    const r1 = await getCameraRecording.handler({ camera: "front_door", at: "2026-10-08T01:40:00Z" }, a.ctx);
    expect(!r1.ok && r1.error.code).toBe("CAMERA_NOT_FOUND");
    const b = cameraCtx({ [RECORDINGS]: () => json(403, {}) });
    const r2 = await getCameraRecording.handler({ camera: "front_door", at: "2026-10-08T01:40:00Z" }, b.ctx);
    expect(!r2.ok && r2.error.code).toBe("CAMERA_ACCESS_DENIED");
    const c = cameraCtx({ [RECORDINGS]: () => json(503, {}) });
    const r3 = await getCameraRecording.handler({ camera: "front_door", at: "2026-10-08T01:40:00Z" }, c.ctx);
    expect(!r3.ok && r3.error.code).toBe("RECORDINGS_FAILED");
  });

  it("ignores malformed segment rows instead of counting them as footage", async () => {
    const { ctx } = cameraCtx({ [RECORDINGS]: () => json(200, { segments: [{ startTime: "x" }, null, { startTime: 5, endTime: 4 }] }) });
    const d = data(await getCameraRecording.handler({ camera: "front_door", at: "2026-10-08T01:40:00Z" }, ctx));
    expect(d.footageAvailable).toBe(false);
  });

  it("is a Tier-1 read", () => {
    expect(getCameraRecording.name).toBe("get_camera_recording");
    expect(getCameraRecording.requiresWrite).toBe(false);
    expect(getCameraRecording.requiresConfirmation).toBe(false);
  });
});

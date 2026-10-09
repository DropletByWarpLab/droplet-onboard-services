/**
 * WARP-3927 — `get_camera_motion`: motion spans with local times, and the
 * coverage that keeps "no motion" from reading as "all clear".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseChatMedia } from "@droplet/shared-types";
import getCameraMotion from "../../../src/handlers/cameras/get-camera-motion.js";
import { describeCoverage } from "../../../src/handlers/cameras/_activity.js";
import { cameraCtx, json, NOW_EPOCH, NOW_ISO } from "../../helpers/camera-ctx.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
const H = 3600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

const span = (camera: string, startIso: string, minutes: number, motion: number, extra: Record<string, unknown> = {}) => {
  const startTime = epoch(startIso);
  const endTime = startTime + minutes * 60;
  return {
    id: `motion-${camera}-${startTime}`,
    camera,
    startTime,
    endTime,
    motion,
    outsideBusinessHours: null,
    playbackUrl: `/api/cameras/${camera}/playback.m3u8?after=${startTime}&before=${endTime}`,
    ...extra,
  };
};

const coverage = (after: number, before: number, cameras: Array<Record<string, unknown>>) => ({
  after,
  before,
  partial: cameras.some((c) => c.available === false),
  cameras,
});

const AFTER = epoch("2026-10-08T00:00:00Z"); // 17:00 PDT on the 7th
const BEFORE = NOW_EPOCH; // 12h later
const WINDOW_SECONDS = BEFORE - AFTER;

function data(r: Awaited<ReturnType<typeof getCameraMotion.handler>>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("get_camera_motion", () => {
  it("calls GET /api/cameras/motion with epoch seconds, the camera and business-hours filter", async () => {
    const { ctx, calls } = cameraCtx(
      { "/api/cameras/motion": () => json(200, { activity: [], nextCursor: null, coverage: coverage(AFTER, BEFORE, []) }) },
      "America/Los_Angeles",
    );
    await getCameraMotion.handler({ camera: "dock", after: "2026-10-07 17:00", business_hours: "outside" }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/cameras/motion");
    expect(calls[0].params).toMatchObject({ after: AFTER, before: BEFORE, cameras: "dock", businessHours: "outside" });
  });

  it("returns spans with local ISO times, and ALWAYS the coverage object and a coverageNote", async () => {
    const cov = coverage(AFTER, BEFORE, [{ camera: "dock", recordedSeconds: WINDOW_SECONDS - 90 * 60, hasGaps: true, available: true }]);
    const { ctx } = cameraCtx(
      {
        "/api/cameras/motion": () =>
          json(200, {
            activity: [span("dock", "2026-10-08T03:10:00Z", 12, 400, { outsideBusinessHours: true })],
            nextCursor: null,
            coverage: cov,
          }),
      },
      "America/Los_Angeles",
    );
    const d = data(await getCameraMotion.handler({ camera: "dock", after: "2026-10-07 17:00" }, ctx));
    expect(d.timezone).toBe("America/Los_Angeles");
    expect(d.spans).toEqual([
      {
        camera: "dock",
        start: "2026-10-07T20:10:00-07:00",
        end: "2026-10-07T20:22:00-07:00",
        minutes: 12,
        motion: 400,
        outsideBusinessHours: true,
      },
    ]);
    expect(d.coverage).toEqual(cov);
    expect(d.coverageNote).toBe(
      "Footage covers 10h 30m of the 12h 00m asked for; 90 minutes have no recording. Activity during the missing stretches is unknown; do not treat it as quiet.",
    );
    expect(d.incomplete).toBe(true);
    expect(d.period).toMatchObject({ start: "2026-10-07T17:00:00-07:00", end: "2026-10-08T05:00:00-07:00", length: "12h 00m", endClampedToNow: true });
  });

  it("full coverage is stated plainly and is not incomplete", async () => {
    const { ctx } = cameraCtx({
      "/api/cameras/motion": () =>
        json(200, { activity: [], nextCursor: null, coverage: coverage(AFTER, BEFORE, [{ camera: "dock", recordedSeconds: WINDOW_SECONDS, hasGaps: false, available: true }]) }),
    });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.coverageNote).toBe("Footage covers 12h 00m of the 12h 00m asked for; there are no gaps.");
    expect(d.incomplete).toBe(false);
    expect(d.spans).toEqual([]);
    expect(d.media).toBeUndefined();
  });

  it("an unreadable camera is called out and makes the result incomplete", async () => {
    const { ctx } = cameraCtx({
      "/api/cameras/motion": () =>
        json(200, {
          activity: [],
          nextCursor: null,
          coverage: coverage(AFTER, BEFORE, [
            { camera: "dock", recordedSeconds: WINDOW_SECONDS, hasGaps: false, available: true },
            { camera: "yard", recordedSeconds: null, hasGaps: true, available: false },
          ]),
        }),
    });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.coverageNote).toContain("could not be read for yard");
    expect(d.coverageNote).toContain("do not treat it as quiet");
    expect(d.incomplete).toBe(true);
  });

  it("missing coverage in the response is treated as unknown, never as complete", async () => {
    const { ctx } = cameraCtx({ "/api/cameras/motion": () => json(200, { activity: [], nextCursor: null }) });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.coverage).toBeNull();
    expect(d.incomplete).toBe(true);
    expect(d.coverageNote).toMatch(/not an all-clear/);
  });

  it("emits camera_clip media for at most the 3 most active spans, validated by parseChatMedia", async () => {
    const activity = [
      span("dock", "2026-10-08T01:00:00Z", 5, 10),
      span("dock", "2026-10-08T02:00:00Z", 5, 900),
      span("dock", "2026-10-08T03:00:00Z", 5, 300),
      span("yard", "2026-10-08T04:00:00Z", 5, 700),
      span("yard", "2026-10-08T05:00:00Z", 5, 50),
    ];
    const { ctx } = cameraCtx({
      "/api/cameras/motion": () => json(200, { activity, nextCursor: null, coverage: coverage(AFTER, BEFORE, [{ camera: "dock", recordedSeconds: WINDOW_SECONDS, hasGaps: false, available: true }]) }),
    });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    const media = parseChatMedia(d);
    expect(media).toHaveLength(3);
    expect(media.map((m) => m.kind)).toEqual(["camera_clip", "camera_clip", "camera_clip"]);
    expect(media.map((m) => (m as { startTime: number }).startTime)).toEqual([
      epoch("2026-10-08T02:00:00Z"),
      epoch("2026-10-08T04:00:00Z"),
      epoch("2026-10-08T03:00:00Z"),
    ]);
    expect(media[0]).toMatchObject({
      camera: "dock",
      playbackUrl: `/api/cameras/dock/playback.m3u8?after=${epoch("2026-10-08T02:00:00Z")}&before=${epoch("2026-10-08T02:05:00Z")}`,
    });
    // every span is still listed even though only 3 become cards
    expect(d.spanCount).toBe(5);
  });

  it("drops a span whose playbackUrl is not a same-origin /api path", async () => {
    const { ctx } = cameraCtx({
      "/api/cameras/motion": () =>
        json(200, {
          activity: [span("dock", "2026-10-08T02:00:00Z", 5, 900, { playbackUrl: "https://evil.example/x.m3u8" })],
          nextCursor: null,
          coverage: coverage(AFTER, BEFORE, []),
        }),
    });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.media).toBeUndefined();
    expect(d.spanCount).toBe(1);
  });

  it("says when spans were cut off and marks the result incomplete", async () => {
    const { ctx } = cameraCtx({
      "/api/cameras/motion": () =>
        json(200, {
          activity: [span("dock", "2026-10-08T02:00:00Z", 5, 9)],
          nextCursor: epoch("2026-10-08T02:00:00Z"),
          coverage: coverage(AFTER, BEFORE, [{ camera: "dock", recordedSeconds: WINDOW_SECONDS, hasGaps: false, available: true }]),
        }),
    });
    const d = data(await getCameraMotion.handler({ after: "2026-10-07 17:00" }, ctx));
    expect(d.moreSpans).toBe(true);
    expect(d.incomplete).toBe(true);
  });

  it("clamps a future end to now", async () => {
    const { ctx, calls } = cameraCtx({ "/api/cameras/motion": () => json(200, { activity: [], nextCursor: null, coverage: coverage(AFTER, BEFORE, []) }) });
    await getCameraMotion.handler({ after: "2026-10-07 17:00", before: "2026-10-09 09:00" }, ctx);
    expect(calls[0].params.before).toBe(NOW_EPOCH);
  });

  it.each([
    [{}, /after is required/],
    [{ after: "2026-10-07 17:00", before: "2026-10-07 16:00" }, /later than after/],
    [{ after: "2026-10-06 00:00", before: "2026-10-08 00:00" }, /26 hours/],
    [{ after: "2026-10-09 17:00" }, /future/],
    [{ after: "overnight" }, /after/],
    [{ after: "2026-10-07 17:00", camera: "bad name" }, /camera/],
    [{ after: "2026-10-07 17:00", business_hours: "sometimes" }, /business_hours/],
  ])("rejects %j without calling the orchestrator", async (args, message) => {
    const { ctx, get } = cameraCtx({});
    const r = await getCameraMotion.handler(args, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ARGS");
    expect(r.error.message).toMatch(message);
    expect(get).not.toHaveBeenCalled();
  });

  it("maps route failures: 403 -> CAMERA_ACCESS_DENIED, other -> MOTION_FAILED", async () => {
    const denied = cameraCtx({ "/api/cameras/motion": () => json(403, {}) });
    const r1 = await getCameraMotion.handler({ after: "2026-10-07 17:00" }, denied.ctx);
    expect(!r1.ok && r1.error.code).toBe("CAMERA_ACCESS_DENIED");
    const down = cameraCtx({ "/api/cameras/motion": () => json(503, {}) });
    const r2 = await getCameraMotion.handler({ after: "2026-10-07 17:00" }, down.ctx);
    expect(!r2.ok && r2.error.code).toBe("MOTION_FAILED");
  });

  it("is a Tier-1 read", () => {
    expect(getCameraMotion.name).toBe("get_camera_motion");
    expect(getCameraMotion.requiresWrite).toBe(false);
    expect(getCameraMotion.requiresConfirmation).toBe(false);
  });
});

describe("describeCoverage", () => {
  it("never reports complete for an empty camera list or a malformed object", () => {
    expect(describeCoverage({ after: 0, before: 100, partial: false, cameras: [] }).complete).toBe(false);
    expect(describeCoverage(null).complete).toBe(false);
    expect(describeCoverage({ after: 100, before: 50, cameras: [{}] }).complete).toBe(false);
    expect(describeCoverage("full").complete).toBe(false);
  });

  it("tolerates a minute of segment rounding but no more", () => {
    const base = { after: 0, before: 3600 };
    expect(describeCoverage({ ...base, cameras: [{ camera: "a", recordedSeconds: 3545, available: true }] }).complete).toBe(true);
    expect(describeCoverage({ ...base, cameras: [{ camera: "a", recordedSeconds: 3500, available: true }] }).complete).toBe(false);
  });

  it("sums several cameras into one sentence", () => {
    const c = describeCoverage({
      after: 0,
      before: H,
      cameras: [
        { camera: "a", recordedSeconds: H, available: true },
        { camera: "b", recordedSeconds: H / 2, available: true },
      ],
    });
    expect(c.note).toContain("Footage covers 1h 30m of the 2h 00m asked for across 2 cameras; 30 minutes have no recording.");
    expect(c.reasons).toEqual(["no recording for part of the period (b)"]);
  });
});

/**
 * WARP-1974 — "Recording" must mean footage is being kept.
 *
 * The old rule was `camera_fps > 0`, i.e. "frames are arriving". A camera
 * with every retention window at zero decodes, detects and stores nothing,
 * and the badge told the household their footage was safe. That is half of
 * why "cams aren't recording right" was reported about working hardware.
 */
import { describe, it, expect } from "vitest";
import { retentionFromFrigateConfig } from "./camera.service.js";
import { retainsFootage } from "./camera-retention-defaults.js";

/** Verbatim shape from Frigate 0.17's resolved /api/config. */
const RESOLVED_KEEPING = {
  record: {
    enabled: true,
    continuous: { days: 3 },
    motion: { days: 30 },
    alerts: { retain: { days: 14 }, pre_capture: 20, post_capture: 20 },
    detections: { retain: { days: 14 }, pre_capture: 20, post_capture: 20 },
  },
};

/** A camera adopted before WARP-1957 — enabled, every window inherited 0. */
const RESOLVED_KEEPING_NOTHING = {
  record: {
    enabled: true,
    continuous: { days: 0 },
    motion: { days: 0 },
    alerts: { retain: { days: 0 } },
    detections: { retain: { days: 0 } },
  },
};

describe("retentionFromFrigateConfig", () => {
  it("reads the four windows at their real depths", () => {
    // continuous/motion carry `days` directly; alerts/detections nest it
    // under `retain`. Reading the wrong depth yields undefined -> 0, which
    // would put every healthy camera in the warning state.
    expect(retentionFromFrigateConfig(RESOLVED_KEEPING)).toEqual({
      enabled: true,
      continuousDays: 3,
      motionDays: 30,
      alertsRetainDays: 14,
      detectionsRetainDays: 14,
    });
  });

  it("survives a camera with no record block at all", () => {
    expect(retentionFromFrigateConfig({}).continuousDays).toBe(0);
    expect(retentionFromFrigateConfig(undefined).motionDays).toBe(0);
  });
});

describe("what the badge is allowed to claim", () => {
  it("a live stream that keeps NOTHING does not count as recording", () => {
    // THE regression, stated as the predicate the status derivation uses.
    expect(retainsFootage(retentionFromFrigateConfig(RESOLVED_KEEPING_NOTHING))).toBe(false);
  });

  it("a camera keeping footage does", () => {
    expect(retainsFootage(retentionFromFrigateConfig(RESOLVED_KEEPING))).toBe(true);
  });

  it("ONE open window is enough — Frigate keeps a segment if any covers it", () => {
    const onlyAlerts = {
      record: {
        enabled: true,
        continuous: { days: 0 },
        motion: { days: 0 },
        alerts: { retain: { days: 14 } },
        detections: { retain: { days: 0 } },
      },
    };
    expect(retainsFootage(retentionFromFrigateConfig(onlyAlerts))).toBe(true);
  });

  it("recording switched off outright keeps nothing, whatever the windows say", () => {
    const off = { record: { ...RESOLVED_KEEPING.record, enabled: false } };
    expect(retainsFootage(retentionFromFrigateConfig(off))).toBe(false);
  });
});

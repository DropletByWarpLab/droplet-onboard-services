/**
 * WARP-1957 — a newly adopted camera must actually keep footage.
 *
 * The block asserted here is not invented: it was emitted by
 * `buildRecordBlock()` and then validated against the RUNNING Frigate
 * 0.17.1 container's own pydantic models on the production box —
 * `RecordConfig(**block)` and `SnapshotsConfig(**block)` both accepted it.
 * The mirrored Python builder in `services/camera-discovery` emits a
 * byte-identical payload.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_CAPTURE_PADDING_SEC,
  MAX_RETENTION_DAYS,
  SHIPPED_RETENTION_DEFAULTS,
  buildRecordBlock,
  buildSnapshotsBlock,
  resolveRetentionDefaults,
  retainsFootage,
} from "./camera-retention-defaults.js";

describe("adoption defaults keep footage", () => {
  it("gives a new camera non-zero continuous AND motion retention", () => {
    const d = resolveRetentionDefaults({});

    // THE regression. Both of these inherited 0 from Frigate's schema,
    // so an adopted camera kept only alert/detection clips while the UI
    // reported "Recording".
    expect(d.continuousDays).toBeGreaterThan(0);
    expect(d.motionDays).toBeGreaterThan(0);
  });

  it("emits the record block Frigate 0.17 accepted on the box", () => {
    expect(buildRecordBlock(resolveRetentionDefaults({}))).toEqual({
      enabled: true,
      continuous: { days: 3 },
      motion: { days: 30 },
      alerts: {
        retain: { days: 14 },
        pre_capture: 20,
        post_capture: 20,
      },
      detections: {
        retain: { days: 14 },
        pre_capture: 20,
        post_capture: 20,
      },
    });
  });

  it("nests days under `retain` for alerts/detections but not for continuous/motion", () => {
    const block = buildRecordBlock(resolveRetentionDefaults({})) as Record<
      string,
      Record<string, unknown>
    >;

    // Frigate's model is extra="forbid": putting `days` at the wrong
    // depth fails the WHOLE config save, taking the camera's detection,
    // zones and masks down with it.
    expect(block.continuous).toEqual({ days: 3 });
    expect(block.alerts.retain).toEqual({ days: 14 });
    expect(block.alerts).not.toHaveProperty("days");
    expect(block.continuous).not.toHaveProperty("retain");
  });

  it("puts 20 seconds of padding on each side of an event", () => {
    const block = buildRecordBlock(resolveRetentionDefaults({})) as Record<
      string,
      Record<string, unknown>
    >;
    expect(block.alerts.pre_capture).toBe(20);
    expect(block.alerts.post_capture).toBe(20);
    expect(block.detections.pre_capture).toBe(20);
    expect(block.detections.post_capture).toBe(20);
  });

  it("emits a snapshots block with an explicit retention", () => {
    expect(buildSnapshotsBlock(resolveRetentionDefaults({}))).toEqual({
      enabled: true,
      retain: { default: 14 },
    });
  });
});

describe("defaults are configurable", () => {
  it("honours environment overrides", () => {
    const d = resolveRetentionDefaults({
      NVR_DEFAULT_CONTINUOUS_DAYS: "7",
      NVR_DEFAULT_MOTION_DAYS: "45",
      NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC: "10",
      NVR_DEFAULT_EVENT_POST_CAPTURE_SEC: "15",
    });

    expect(d.continuousDays).toBe(7);
    expect(d.motionDays).toBe(45);
    expect(d.preCaptureSec).toBe(10);
    expect(d.postCaptureSec).toBe(15);
  });

  it("lets an operator deliberately switch 24/7 off", () => {
    // 0 is a legitimate choice — it must be respected, unlike the
    // accidental 0 that came from never setting the key at all.
    expect(resolveRetentionDefaults({ NVR_DEFAULT_CONTINUOUS_DAYS: "0" }).continuousDays).toBe(0);
  });

  it("treats an EMPTY value as unset, not as zero", () => {
    // Compose writes `FOO=` for an unset variable. Number("") is 0, which
    // would silently mean "keep nothing" — the same class of footgun as
    // `${VAR:-}` defeating a zod .default() elsewhere in this repo.
    const d = resolveRetentionDefaults({
      NVR_DEFAULT_CONTINUOUS_DAYS: "",
      NVR_DEFAULT_MOTION_DAYS: "   ",
    });

    expect(d.continuousDays).toBe(SHIPPED_RETENTION_DEFAULTS.continuousDays);
    expect(d.motionDays).toBe(SHIPPED_RETENTION_DEFAULTS.motionDays);
  });

  it("falls back on garbage rather than writing a broken config", () => {
    const d = resolveRetentionDefaults({
      NVR_DEFAULT_CONTINUOUS_DAYS: "three",
      NVR_DEFAULT_MOTION_DAYS: "-4",
    });

    expect(d.continuousDays).toBe(SHIPPED_RETENTION_DEFAULTS.continuousDays);
    expect(d.motionDays).toBe(SHIPPED_RETENTION_DEFAULTS.motionDays);
  });

  it("clamps capture padding to Frigate's le=60 bound", () => {
    // Measured against the container's model: pre_capture=120 raises
    // "Input should be less than or equal to 60", and that failure takes
    // the entire config save with it.
    const d = resolveRetentionDefaults({
      NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC: "120",
      NVR_DEFAULT_EVENT_POST_CAPTURE_SEC: "999",
    });

    expect(d.preCaptureSec).toBe(MAX_CAPTURE_PADDING_SEC);
    expect(d.postCaptureSec).toBe(MAX_CAPTURE_PADDING_SEC);
    expect(d.preCaptureSec).toBeLessThanOrEqual(60);
  });

  it("clamps retention days to the supported maximum", () => {
    expect(
      resolveRetentionDefaults({ NVR_DEFAULT_MOTION_DAYS: "9999" }).motionDays,
    ).toBe(MAX_RETENTION_DAYS);
  });
});

describe("retainsFootage — what 'recording' actually means", () => {
  it("is false when every window is zero, however live the camera is", () => {
    // The exact state the box was in: frames arriving at 5 fps, detection
    // running, nothing kept. `camera_fps > 0` called this "Recording".
    expect(
      retainsFootage({
        enabled: true,
        continuousDays: 0,
        motionDays: 0,
        alertsRetainDays: 0,
        detectionsRetainDays: 0,
      }),
    ).toBe(false);
  });

  it("is true when ANY single window is open", () => {
    // Frigate keeps a segment if ANY of the four windows still covers it.
    expect(retainsFootage({ enabled: true, continuousDays: 3 })).toBe(true);
    expect(retainsFootage({ enabled: true, motionDays: 30 })).toBe(true);
    expect(retainsFootage({ enabled: true, alertsRetainDays: 14 })).toBe(true);
    expect(retainsFootage({ enabled: true, detectionsRetainDays: 14 })).toBe(true);
  });

  it("is false when recording is switched off outright", () => {
    expect(retainsFootage({ enabled: false, continuousDays: 30 })).toBe(false);
  });

  it("agrees with the shipped defaults", () => {
    const d = SHIPPED_RETENTION_DEFAULTS;
    expect(
      retainsFootage({
        enabled: true,
        continuousDays: d.continuousDays,
        motionDays: d.motionDays,
        alertsRetainDays: d.alertsRetainDays,
        detectionsRetainDays: d.detectionsRetainDays,
      }),
    ).toBe(true);
  });
});

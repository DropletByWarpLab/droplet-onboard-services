/**
 * WARP-3511 — the `recording` block on a camera: what it keeps, how much, and
 * since when. Pure derivation, so every rule is pinned here without Frigate.
 *
 * The retention shape in these fixtures is what `retentionFromFrigateConfig`
 * returns for Frigate 0.17's resolved config (see camera.status-retention.test.ts).
 */
import { describe, it, expect } from "vitest";
import {
  buildRecordingState,
  degradedRecordingState,
  indexStorageByCamera,
  recordingModeOf,
  storageKeysFromConfig,
  toStorageBytes,
  type FrigateRetention,
} from "./camera-recording-state.js";

const MIB = 1024 * 1024;

const retention = (over: Partial<FrigateRetention> = {}): FrigateRetention => ({
  enabled: true,
  continuousDays: 0,
  motionDays: 0,
  alertsRetainDays: 0,
  detectionsRetainDays: 0,
  ...over,
});

describe("recordingModeOf — named for the broadest window that is open", () => {
  it("continuous: a 24/7 window keeps everything, whatever else is set", () => {
    expect(recordingModeOf(retention({ continuousDays: 3, motionDays: 30, alertsRetainDays: 14 }))).toBe(
      "continuous",
    );
  });

  it("continuous even when it is the only window", () => {
    expect(recordingModeOf(retention({ continuousDays: 1 }))).toBe("continuous");
  });

  it("motion: no 24/7 window, but segments with motion are kept", () => {
    expect(recordingModeOf(retention({ motionDays: 30, alertsRetainDays: 14, detectionsRetainDays: 14 }))).toBe(
      "motion",
    );
  });

  it("events: only the alert / detection windows are open", () => {
    expect(recordingModeOf(retention({ alertsRetainDays: 14, detectionsRetainDays: 14 }))).toBe("events");
  });

  it("events: ONE review window is enough — Frigate keeps a segment if any window covers it", () => {
    expect(recordingModeOf(retention({ detectionsRetainDays: 5 }))).toBe("events");
  });

  it("off: every window at zero is a camera that decodes and keeps nothing", () => {
    expect(recordingModeOf(retention())).toBe("off");
  });

  it("off: record switched off outright, whatever the windows say", () => {
    expect(recordingModeOf(retention({ enabled: false, continuousDays: 3, motionDays: 30 }))).toBe("off");
  });

  it("an unset `enabled` is not 'off' — only an explicit false is", () => {
    expect(recordingModeOf(retention({ enabled: undefined, continuousDays: 3 }))).toBe("continuous");
  });
});

describe("toStorageBytes — Frigate reports MiB; null is not zero", () => {
  it("converts usage and the hourly rate to bytes once, here", () => {
    expect(toStorageBytes({ usage: 2, bandwidth: 1 })).toEqual({
      usedBytes: 2 * MIB,
      bytesPerHour: 1 * MIB,
    });
  });

  it("usage null (no segments yet) stays null — it is NOT 'zero bytes'", () => {
    expect(toStorageBytes({ usage: null, bandwidth: 5 }).usedBytes).toBeNull();
  });

  it("a rate of 0 means 'not measured yet', not 'uses no space'", () => {
    expect(toStorageBytes({ usage: 10, bandwidth: 0 }).bytesPerHour).toBeNull();
  });

  it("a missing row is entirely unknown", () => {
    expect(toStorageBytes(undefined)).toEqual({ usedBytes: null, bytesPerHour: null });
  });

  it("garbage (NaN) is unknown rather than propagated", () => {
    expect(toStorageBytes({ usage: Number.NaN, bandwidth: Number.NaN })).toEqual({
      usedBytes: null,
      bytesPerHour: null,
    });
  });
});

describe("storage keys — Frigate keys by friendly_name when a camera has one", () => {
  it("maps a friendly name back to the real camera name", () => {
    const keys = storageKeysFromConfig({
      front_door: { friendly_name: "Front Door" },
      garage: {},
    });
    expect(keys.get("Front Door")).toBe("front_door");
    expect(keys.get("garage")).toBe("garage");
  });

  it("indexStorageByCamera resolves friendly-keyed rows so those cameras are not dropped", () => {
    const byCamera = indexStorageByCamera(
      {
        "Front Door": { usage: 100, bandwidth: 2 },
        garage: { usage: null, bandwidth: 0 },
      },
      { front_door: { friendly_name: "Front Door" }, garage: {} },
    );
    expect(byCamera.get("front_door")).toEqual({ usedBytes: 100 * MIB, bytesPerHour: 2 * MIB });
    expect(byCamera.get("garage")).toEqual({ usedBytes: null, bytesPerHour: null });
  });

  it("falls back to the key as given when the config does not know it", () => {
    const byCamera = indexStorageByCamera({ orphan: { usage: 1, bandwidth: 1 } }, {});
    expect(byCamera.has("orphan")).toBe(true);
  });
});

describe("buildRecordingState", () => {
  it("assembles the block: mode, per-window days, last write, usage, daily rate", () => {
    const state = buildRecordingState({
      retention: retention({ continuousDays: 3, motionDays: 30, alertsRetainDays: 14, detectionsRetainDays: 7 }),
      storage: { usedBytes: 46 * 1024 * MIB, bytesPerHour: 1000 * MIB },
      lastSegmentEnd: 1_791_000_000,
    });
    expect(state).toEqual({
      degraded: false,
      mode: "continuous",
      retentionDays: { continuous: 3, motion: 30, alerts: 14, detections: 7 },
      lastSegmentAt: new Date(1_791_000_000 * 1000).toISOString(),
      usedBytes: 46 * 1024 * MIB,
      bytesPerDay: 24 * 1000 * MIB,
    });
  });

  it("reports the windows as configured even when recording is off, so the page can say what would be kept", () => {
    const state = buildRecordingState({
      retention: retention({ enabled: false, continuousDays: 3 }),
      lastSegmentEnd: null,
    });
    expect(state.mode).toBe("off");
    expect(state.retentionDays?.continuous).toBe(3);
  });

  it("no recent segment → lastSegmentAt null (unknown), never an epoch-zero date", () => {
    const state = buildRecordingState({ retention: retention({ motionDays: 5 }), lastSegmentEnd: null });
    expect(state.lastSegmentAt).toBeNull();
  });

  it("no storage row → usage and rate are null, and the block is still NOT degraded", () => {
    const state = buildRecordingState({ retention: retention({ motionDays: 5 }), lastSegmentEnd: null });
    expect(state.usedBytes).toBeNull();
    expect(state.bytesPerDay).toBeNull();
    expect(state.degraded).toBe(false);
  });

  it("an unmeasured rate gives no daily rate rather than 0 B/day", () => {
    const state = buildRecordingState({
      retention: retention({ continuousDays: 1 }),
      storage: { usedBytes: 5 * MIB, bytesPerHour: null },
      lastSegmentEnd: null,
    });
    expect(state.bytesPerDay).toBeNull();
    expect(state.usedBytes).toBe(5 * MIB);
  });

  it("rounds the daily rate to whole bytes", () => {
    const state = buildRecordingState({
      retention: retention({ continuousDays: 1 }),
      storage: { usedBytes: null, bytesPerHour: 10.4 },
      lastSegmentEnd: null,
    });
    expect(Number.isInteger(state.bytesPerDay)).toBe(true);
  });

  it("ignores a non-finite or non-positive segment time", () => {
    for (const bad of [Number.NaN, 0, -5, 1e100]) {
      const state = buildRecordingState({ retention: retention({ continuousDays: 1 }), lastSegmentEnd: bad });
      expect(state.lastSegmentAt).toBeNull();
    }
  });
});

describe("degradedRecordingState — Frigate could not be read", () => {
  it("claims nothing: no mode, no windows, no numbers, and says so", () => {
    expect(degradedRecordingState()).toEqual({
      degraded: true,
      mode: null,
      retentionDays: null,
      lastSegmentAt: null,
      usedBytes: null,
      bytesPerDay: null,
    });
  });

  it("is frozen, so one shared object can never be mutated into another camera's state", () => {
    const state = degradedRecordingState();
    expect(Object.isFrozen(state)).toBe(true);
  });
});

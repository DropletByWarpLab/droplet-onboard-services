/**
 * WARP-3511 — what the camera surfaces say about a camera's recording, as pure
 * functions. The wording rules live here so the tile, the detail rail and the
 * settings header can never describe the same camera two ways.
 *
 * Two rules recur: `null` is "not known", never zero; and a degraded camera
 * (the camera service could not be read) is never described as recording or
 * as not saving.
 */
import { describe, it, expect } from "vitest";
import type { CameraInfo, CameraRecordingState, RecordingDay } from "@/lib/types";
import {
  MODE_CHIP_LABEL,
  MODE_SENTENCE,
  STALE_CONTINUOUS_SAVE_SEC,
  describeLastSaved,
  describeRetention,
  formatBytesPerDay,
  formatDays,
  formatSavedAgo,
  formatStorageBytes,
  formatStoredDays,
  isRecordingDegraded,
  isServiceDegraded,
  maxRetentionDays,
  modeTooltip,
  describeRepairWindows,
  statusLabel,
  summarizeStoredFootage,
} from "./camera-recording";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

function rec(over: Partial<CameraRecordingState> = {}): CameraRecordingState {
  return {
    degraded: false,
    mode: "continuous",
    retentionDays: { continuous: 3, motion: 30, alerts: 14, detections: 14 },
    lastSegmentAt: ago(12),
    usedBytes: 46 * 1024 ** 3,
    bytesPerDay: 24 * 1024 ** 3,
    ...over,
  };
}

function cam(over: Partial<CameraInfo> = {}): CameraInfo {
  return {
    name: "front_door",
    displayName: "Front door",
    manufacturer: null,
    model: null,
    ipAddress: "192.168.20.10",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    status: "recording",
    lastSeen: ago(1),
    lastDetection: null,
    recording: rec(),
    ...over,
  };
}

describe("degraded detection", () => {
  it("a camera is degraded only when its block says so", () => {
    expect(isRecordingDegraded(cam())).toBe(false);
    expect(isRecordingDegraded(cam({ recording: rec({ degraded: true, mode: null }) }))).toBe(true);
  });

  it("a payload with no recording block is not degraded — it is an older box", () => {
    expect(isRecordingDegraded(cam({ recording: undefined }))).toBe(false);
  });

  it("the service is degraded when any camera is", () => {
    expect(isServiceDegraded([cam(), cam({ recording: rec({ degraded: true }) })])).toBe(true);
    expect(isServiceDegraded([cam()])).toBe(false);
    expect(isServiceDegraded([])).toBe(false);
  });
});

describe("mode copy", () => {
  it("has a short chip label and a sentence for every mode", () => {
    for (const mode of ["continuous", "motion", "events", "off"] as const) {
      expect(MODE_CHIP_LABEL[mode].length).toBeGreaterThan(0);
      expect(MODE_SENTENCE[mode].length).toBeGreaterThan(0);
    }
  });

  it("is plain sentence-case copy: no exclamation marks, no emoji", () => {
    for (const text of [...Object.values(MODE_CHIP_LABEL), ...Object.values(MODE_SENTENCE)]) {
      expect(text).not.toMatch(/!/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("statusLabel", () => {
  it("names each state for what it is", () => {
    expect(statusLabel(cam({ status: "recording" }))).toBe("Recording");
    expect(statusLabel(cam({ status: "detecting" }))).toBe("Detecting");
    expect(statusLabel(cam({ status: "live" }))).toBe("Live · not saving");
    expect(statusLabel(cam({ status: "idle" }))).toBe("Idle");
    expect(statusLabel(cam({ status: "offline" }))).toBe("Offline");
  });

  it("a degraded camera is 'status unavailable' — never Offline, never Recording", () => {
    expect(statusLabel(cam({ status: "offline", recording: rec({ degraded: true, mode: null }) }))).toBe(
      "Status unavailable",
    );
    expect(statusLabel(cam({ status: "recording", recording: rec({ degraded: true, mode: null }) }))).toBe(
      "Status unavailable",
    );
  });
});

describe("retention", () => {
  it("lists only the windows that are open, in a fixed order, with the camera's own numbers", () => {
    const lines = describeRetention(rec({ retentionDays: { continuous: 0, motion: 21, alerts: 10, detections: 0 } }));
    expect(lines).toEqual([
      { key: "motion", label: "Motion footage", days: 21 },
      { key: "alerts", label: "Alert clips", days: 10 },
    ]);
  });

  it("lists nothing when recording is off, even if windows are configured", () => {
    expect(describeRetention(rec({ mode: "off" }))).toEqual([]);
  });

  it("lists nothing for a degraded block", () => {
    expect(describeRetention(rec({ degraded: true, mode: null, retentionDays: null }))).toEqual([]);
  });

  it("maxRetentionDays is the longest open window — how far back anything might be", () => {
    expect(maxRetentionDays(rec())).toBe(30);
    expect(maxRetentionDays(rec({ retentionDays: { continuous: 7, motion: 0, alerts: 0, detections: 0 } }))).toBe(7);
  });

  it("maxRetentionDays is 0 when nothing is kept or nothing is known", () => {
    expect(maxRetentionDays(rec({ mode: "off" }))).toBe(0);
    expect(maxRetentionDays(rec({ degraded: true, mode: null, retentionDays: null }))).toBe(0);
    expect(maxRetentionDays(undefined)).toBe(0);
  });

  it("formats days with a correct plural and keeps a fraction Frigate may report", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(3)).toBe("3 days");
    expect(formatDays(0.5)).toBe("0.5 days");
  });
});

describe("describeRepairWindows — what the repair would keep, from the box's own figures", () => {
  it("names each open window with the days the box reported", () => {
    expect(
      describeRepairWindows({ continuousDays: 13, motionDays: 17, alertsRetainDays: 23, detectionsRetainDays: 29 }),
    ).toBe("24/7 footage: 13 days · Motion footage: 17 days · Alert clips: 23 days · Other detections: 29 days");
  });

  it("leaves a closed window out", () => {
    expect(
      describeRepairWindows({ continuousDays: 0, motionDays: 7, alertsRetainDays: 0, detectionsRetainDays: 0 }),
    ).toBe("Motion footage: 7 days");
  });

  it("is empty when the box reported no figures, or all windows are closed", () => {
    expect(describeRepairWindows(undefined)).toBe("");
    expect(
      describeRepairWindows({ continuousDays: 0, motionDays: 0, alertsRetainDays: 0, detectionsRetainDays: 0 }),
    ).toBe("");
  });
});

describe("modeTooltip — the tile chip's hover text", () => {
  it("says the mode and then what each open window keeps, from the camera's own numbers", () => {
    expect(modeTooltip(rec())).toBe(
      "Saves everything, around the clock. Keeps 24/7 footage: 3 days · Motion footage: 30 days · Alert clips: 14 days · Other detections: 14 days.",
    );
  });

  it("is only the sentence when nothing is kept", () => {
    expect(modeTooltip(rec({ mode: "off" }))).toBe("Not saving footage.");
  });

  it("is empty for a degraded or missing block — there is nothing to say", () => {
    expect(modeTooltip(rec({ degraded: true, mode: null, retentionDays: null }))).toBe("");
    expect(modeTooltip(undefined)).toBe("");
  });
});

describe("formatSavedAgo", () => {
  it("is 'just now' inside a few seconds", () => {
    expect(formatSavedAgo(ago(2), NOW)).toBe("just now");
  });

  it("counts seconds under a minute", () => {
    expect(formatSavedAgo(ago(12), NOW)).toBe("12s ago");
    expect(formatSavedAgo(ago(59), NOW)).toBe("59s ago");
  });

  it("then minutes, hours and days", () => {
    expect(formatSavedAgo(ago(60), NOW)).toBe("1 min ago");
    expect(formatSavedAgo(ago(5 * 60 + 20), NOW)).toBe("5 min ago");
    expect(formatSavedAgo(ago(3 * 3600), NOW)).toBe("3 h ago");
    expect(formatSavedAgo(ago(2 * 86400 + 100), NOW)).toBe("2 d ago");
  });

  it("clamps a time slightly in the future (clock skew) to 'just now'", () => {
    expect(formatSavedAgo(ago(-30), NOW)).toBe("just now");
  });
});

describe("describeLastSaved — what the tile says about the newest write", () => {
  it("says how long ago, calmly, for a camera that is writing", () => {
    expect(describeLastSaved(cam(), NOW)).toEqual({ text: "Saved 12s ago", tone: "ok" });
  });

  it("flags a 24/7 camera whose last write is stale — that writer has stalled", () => {
    const stale = cam({ recording: rec({ lastSegmentAt: ago(STALE_CONTINUOUS_SAVE_SEC + 60) }) });
    expect(describeLastSaved(stale, NOW)?.tone).toBe("warn");
  });

  it("an old write is NOT a fault for a camera that only saves on motion or events", () => {
    for (const mode of ["motion", "events"] as const) {
      const quiet = cam({ recording: rec({ mode, lastSegmentAt: ago(3600) }) });
      expect(describeLastSaved(quiet, NOW)).toEqual({ text: "Saved 1 h ago", tone: "ok" });
    }
  });

  it("a 24/7 camera with nothing saved recently is a warning", () => {
    expect(describeLastSaved(cam({ recording: rec({ lastSegmentAt: null }) }), NOW)).toEqual({
      text: "Nothing saved recently",
      tone: "warn",
    });
  });

  it("a motion or events camera with nothing recent is just quiet", () => {
    expect(describeLastSaved(cam({ recording: rec({ mode: "motion", lastSegmentAt: null }) }), NOW)).toEqual({
      text: "No recent footage",
      tone: "muted",
    });
  });

  it("a failed last-save read is unavailable, rather than claiming no footage was saved", () => {
    for (const mode of ["continuous", "motion", "events"] as const) {
      expect(describeLastSaved(cam({ recording: rec({ mode, lastSegmentAt: null, lastSegmentReadFailed: true }) }), NOW)).toEqual({
        text: "Last save unavailable",
        tone: "muted",
      });
    }
  });

  it("says nothing when the camera is not saving, is offline, is degraded, or has no block", () => {
    expect(describeLastSaved(cam({ recording: rec({ mode: "off" }) }), NOW)).toBeNull();
    expect(describeLastSaved(cam({ status: "offline" }), NOW)).toBeNull();
    expect(describeLastSaved(cam({ recording: rec({ degraded: true, mode: null }) }), NOW)).toBeNull();
    expect(describeLastSaved(cam({ recording: undefined }), NOW)).toBeNull();
  });
});

describe("storage figures", () => {
  it("uses binary maths with binary labels, as the Camera system page does (WARP-1960)", () => {
    expect(formatStorageBytes(1024)).toBe("1.00 KiB");
    expect(formatStorageBytes(46 * 1024 ** 3)).toBe("46.0 GiB");
    expect(formatStorageBytes(512 * 1024 ** 2)).toBe("512 MiB");
  });

  it("renders a nonsense figure as a dash rather than NaN", () => {
    expect(formatStorageBytes(Number.NaN)).toBe("—");
    expect(formatStorageBytes(-1)).toBe("—");
  });

  it("states a daily rate as approximate", () => {
    expect(formatBytesPerDay(24 * 1024 ** 3)).toBe("≈ 24.0 GiB/day");
  });
});

describe("days stored", () => {
  const day = (iso: string, hours: Array<[number, number]>): RecordingDay => ({
    day: iso,
    events: 0,
    duration: 0,
    hours: hours.map(([hour, duration]) => ({ hour, events: 0, duration, motion: 0, objects: 0 })),
  });

  it("is measured from the oldest hour that actually has footage", () => {
    const stored = summarizeStoredFootage(
      [
        day("2026-10-03", [[9, 3600], [10, 3600]]),
        day("2026-10-01", [[0, 0], [14, 3500], [15, 3600]]),
      ],
      new Date(2026, 9, 3, 14, 0, 0),
    );
    expect(stored?.since).toEqual(new Date(2026, 9, 1, 14, 0, 0));
    expect(stored?.days).toBeCloseTo(2, 5);
  });

  it("ignores hours with no duration — an empty hour is not stored footage", () => {
    expect(summarizeStoredFootage([day("2026-10-01", [[3, 0], [4, 0]])], new Date(2026, 9, 3))).toBeNull();
  });

  it("is null when there is nothing", () => {
    expect(summarizeStoredFootage([], new Date())).toBeNull();
  });

  it("skips an entry with an unparseable day instead of throwing", () => {
    expect(summarizeStoredFootage([day("nonsense", [[1, 100]])], new Date())).toBeNull();
  });

  it("words the span without overclaiming precision", () => {
    expect(formatStoredDays(0.4)).toBe("Under a day");
    expect(formatStoredDays(2.64)).toBe("2.6 days");
    expect(formatStoredDays(1)).toBe("1.0 days");
    expect(formatStoredDays(30.2)).toBe("30 days");
  });
});

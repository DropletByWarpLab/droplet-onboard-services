/**
 * WARP-3511 — the `recording` block on a camera: what it keeps, how much of
 * it there is, and when something last landed on disk.
 *
 * Pure derivation, no I/O. `getCameras` fetches (Frigate stats, config, the
 * storage endpoint, one bounded recordings window per camera) and hands the
 * readings here, so each rule — what a mode means, what a missing number
 * means — is testable without a Frigate.
 *
 * ## Mode
 *
 * Frigate 0.17 keeps a segment if ANY of four retention windows still covers
 * it (see `retainsFootage`). The mode is named for the BROADEST window that
 * is open:
 *
 *   continuous — `record.continuous.days` > 0: everything is kept
 *   motion     — no 24/7 window, `record.motion.days` > 0: segments with motion
 *   events     — only `alerts` / `detections`: footage that overlaps an event
 *   off        — nothing is retained (every window 0, or record disabled)
 *
 * ## Unknown is not zero
 *
 * `null` always means "not known", never "nothing": Frigate answers `usage:
 * null` for a camera with no segments and `bandwidth: 0` before it has
 * segments to average, and the dashboard renders those differently from a
 * real zero. When Frigate could not be read at all the whole block says so
 * (`degraded`) rather than reporting a reassuring set of zeros.
 */

import { retainsFootage } from "./camera-retention-defaults.js";
import type { CameraRecordingState, RecordingMode } from "../types/camera.js";

/**
 * A camera's retention as `retentionFromFrigateConfig` reads it from the
 * RESOLVED Frigate config — what Frigate will actually enforce, inherited
 * defaults included.
 */
export interface FrigateRetention {
  enabled?: boolean;
  continuousDays: number;
  motionDays: number;
  alertsRetainDays: number;
  detectionsRetainDays: number;
}

export function recordingModeOf(retention: FrigateRetention): RecordingMode {
  // Same predicate as the status badge, so the chip and the badge can never
  // disagree about whether anything is being kept.
  if (!retainsFootage(retention)) return "off";
  if (retention.continuousDays > 0) return "continuous";
  if (retention.motionDays > 0) return "motion";
  return "events";
}

// --- Storage readings -------------------------------------------------------

const MIB = 1024 * 1024;

export interface StorageBytes {
  /** Bytes on disk, or null when Frigate has no segments / no usable figure. */
  usedBytes: number | null;
  /** Measured write rate in bytes/hour, or null when not yet measured. */
  bytesPerHour: number | null;
}

/**
 * One row of Frigate's `/api/recordings/storage` → bytes.
 *
 * Frigate reports MiB; this is the single place that converts. `usage` is
 * `null` (not 0) for a camera with no segments, and a `bandwidth` of 0 means
 * "not measured yet" — both stay `null` here.
 */
export function toStorageBytes(
  raw: { usage?: number | null; bandwidth?: number } | null | undefined,
): StorageBytes {
  const usedMib = raw?.usage === null || raw?.usage === undefined ? null : Number(raw.usage);
  const usedBytes = usedMib === null || !Number.isFinite(usedMib) ? null : Math.round(usedMib * MIB);

  const bwMib = Number(raw?.bandwidth ?? 0);
  const bytesPerHour = Number.isFinite(bwMib) && bwMib > 0 ? Math.round(bwMib * MIB) : null;

  return { usedBytes, bytesPerHour };
}

/**
 * Frigate keys `/api/recordings/storage` by `friendly_name` when a camera
 * defines one, otherwise by the camera name. Joining on camera name directly
 * silently drops every camera that has a friendly name, so resolve through
 * the config.
 */
export function storageKeysFromConfig(
  configCameras: Record<string, unknown> | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, cam] of Object.entries(configCameras ?? {})) {
    const friendly = (cam as { friendly_name?: unknown } | null | undefined)?.friendly_name;
    map.set(typeof friendly === "string" && friendly ? friendly : name, name);
  }
  return map;
}

/** The storage endpoint's payload, re-keyed by camera name and converted to bytes. */
export function indexStorageByCamera(
  usage: Record<string, { usage?: number | null; bandwidth?: number }>,
  configCameras: Record<string, unknown> | null | undefined,
): Map<string, StorageBytes> {
  const keyToCamera = storageKeysFromConfig(configCameras);
  const byCamera = new Map<string, StorageBytes>();
  for (const [key, raw] of Object.entries(usage ?? {})) {
    byCamera.set(keyToCamera.get(key) ?? key, toStorageBytes(raw));
  }
  return byCamera;
}

// --- The block --------------------------------------------------------------

export interface RecordingStateInputs {
  retention: FrigateRetention;
  /** This camera's storage reading, or undefined when Frigate has no row for it. */
  storage?: StorageBytes;
  /** Unix seconds the newest saved segment ended, or null when none was found. */
  lastSegmentEnd: number | null;
  lastSegmentReadFailed?: boolean;
}

export function buildRecordingState(inputs: RecordingStateInputs): CameraRecordingState {
  const { retention, storage, lastSegmentEnd } = inputs;
  const bytesPerHour = storage?.bytesPerHour ?? null;
  const segmentDate = lastSegmentEnd !== null && lastSegmentEnd > 0
    ? new Date(lastSegmentEnd * 1000)
    : null;

  return {
    degraded: false,
    mode: recordingModeOf(retention),
    // As configured, even when the mode is "off": a camera with recording
    // switched off still has windows, and the page can say what turning it
    // back on would keep.
    retentionDays: {
      continuous: retention.continuousDays,
      motion: retention.motionDays,
      alerts: retention.alertsRetainDays,
      detections: retention.detectionsRetainDays,
    },
    lastSegmentAt:
      segmentDate && Number.isFinite(segmentDate.getTime())
        ? segmentDate.toISOString()
        : null,
    ...(inputs.lastSegmentReadFailed ? { lastSegmentReadFailed: true } : {}),
    usedBytes: storage?.usedBytes ?? null,
    bytesPerDay: bytesPerHour === null ? null : Math.round(bytesPerHour * 24),
  };
}

const DEGRADED: CameraRecordingState = Object.freeze({
  degraded: true,
  mode: null,
  retentionDays: null,
  lastSegmentAt: null,
  usedBytes: null,
  bytesPerDay: null,
});

/**
 * The block for a camera whose Frigate reading failed. Says nothing about
 * what is being kept — claiming "off" here would put a false "not saving"
 * warning on every tile for the seconds Frigate takes to restart.
 */
export function degradedRecordingState(): CameraRecordingState {
  return DEGRADED;
}

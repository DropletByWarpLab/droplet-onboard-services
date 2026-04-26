/**
 * Per-camera settings — read + write the slice of Frigate's config
 * that an operator can dial in from the dashboard's
 * /cameras/[name]/settings page.
 *
 * Strategy: Frigate's `/api/config` returns the full effective config
 * tree; `/api/config/save?save_option=restart` accepts the full
 * config back (YAML, but JSON is valid YAML 1.2). For each operator
 * change we read the current full config, mutate the camera-specific
 * slice, and write the whole thing back. That's atomic from the
 * operator's perspective and avoids relying on Frigate version-
 * specific partial-update endpoints.
 *
 * Phase 4.1 covers the controls that don't need a polygon editor:
 *   - detect.enabled + fps
 *   - objects.track + per-label thresholds
 *   - record.enabled + retain.days
 *   - snapshots.enabled + retain.default
 *
 * Zones + motion masks (which need a canvas editor) come in Phase 4.2.
 */

import pino from "pino";
import { config as appConfig } from "../config.js";
import { fetchConfig } from "./frigate.client.js";

const logger = pino({ name: "camera-settings" });

const FRIGATE_URL = appConfig.FRIGATE_URL;

// --- DTO shape ---

export interface ObjectFilter {
  /** Detection score threshold — Frigate's `threshold`. [0, 1]. */
  threshold: number;
  /** Minimum score before the object is tracked at all. [0, 1]. */
  minScore: number;
}

export interface CameraSettings {
  /** Whether detection is enabled at all on this camera. */
  detectEnabled: boolean;
  /** Detection FPS — higher catches faster motion but burns GPU. */
  detectFps: number;
  /** Object labels Frigate is tracking on this camera. */
  trackedLabels: string[];
  /** Per-label score filters keyed by label. Defaults to whatever
   *  Frigate's per-label or global filter section says. */
  objectFilters: Record<string, ObjectFilter>;
  /** Continuous recording on/off. */
  recordEnabled: boolean;
  /** Continuous-recording retention days. */
  recordRetainDays: number;
  /** Whether per-event snapshots are saved. */
  snapshotsEnabled: boolean;
  /** How long event snapshots are kept (days). */
  snapshotRetainDays: number;
  /** Whether this camera has any zones defined (read-only here —
   *  the polygon editor in Phase 4.2 will manage them). */
  zoneNames: string[];
  /** Whether a motion mask is configured (read-only for now). */
  hasMotionMask: boolean;
}

export interface CameraSettingsPatch {
  detectEnabled?: boolean;
  detectFps?: number;
  trackedLabels?: string[];
  objectFilters?: Record<string, Partial<ObjectFilter>>;
  recordEnabled?: boolean;
  recordRetainDays?: number;
  snapshotsEnabled?: boolean;
  snapshotRetainDays?: number;
}

// --- Read ---

export async function getCameraSettings(
  cameraName: string,
): Promise<CameraSettings> {
  const config = await fetchConfig();
  const cameras = (config as Record<string, unknown>).cameras as
    | Record<string, Record<string, unknown>>
    | undefined;
  const camera = cameras?.[cameraName];
  if (!camera) {
    throw new Error(`camera ${cameraName} not found`);
  }

  const detect = (camera.detect ?? {}) as Record<string, unknown>;
  const objects = (camera.objects ?? {}) as Record<string, unknown>;
  const record = (camera.record ?? {}) as Record<string, unknown>;
  const snapshots = (camera.snapshots ?? {}) as Record<string, unknown>;
  const zones = (camera.zones ?? {}) as Record<string, unknown>;
  const motion = (camera.motion ?? {}) as Record<string, unknown>;

  const recordRetain = (record.retain ?? {}) as Record<string, unknown>;
  const snapshotRetain = (snapshots.retain ?? {}) as Record<string, unknown>;

  // `track` is sometimes an array, sometimes absent (then Frigate
  // falls back to globals). Coerce to an array of strings.
  const trackedLabels = Array.isArray(objects.track)
    ? (objects.track as unknown[]).map(String)
    : [];

  // Frigate's per-label filters live at objects.filters[label].
  // Fall back to globals if a camera doesn't override.
  const cameraFilters = (objects.filters ?? {}) as Record<string, Record<string, unknown>>;
  const globalObjects = ((config as Record<string, unknown>).objects ?? {}) as Record<string, unknown>;
  const globalFilters = (globalObjects.filters ?? {}) as Record<string, Record<string, unknown>>;

  const objectFilters: Record<string, ObjectFilter> = {};
  // Build the merged view: every tracked label gets an entry, drawing
  // from camera-specific then global filters then Frigate's defaults.
  for (const label of trackedLabels) {
    const cf = cameraFilters[label] ?? {};
    const gf = globalFilters[label] ?? {};
    objectFilters[label] = {
      threshold: Number(cf.threshold ?? gf.threshold ?? 0.7),
      minScore: Number(cf.min_score ?? gf.min_score ?? 0.5),
    };
  }

  return {
    detectEnabled: Boolean(detect.enabled ?? true),
    detectFps: Number(detect.fps ?? 5),
    trackedLabels,
    objectFilters,
    recordEnabled: Boolean(record.enabled ?? false),
    recordRetainDays: Number(recordRetain.days ?? 0),
    snapshotsEnabled: Boolean(snapshots.enabled ?? false),
    snapshotRetainDays: Number(snapshotRetain.default ?? 10),
    zoneNames: Object.keys(zones),
    hasMotionMask: Boolean(
      motion.mask &&
        (Array.isArray(motion.mask)
          ? (motion.mask as unknown[]).length > 0
          : String(motion.mask).length > 0),
    ),
  };
}

// --- Write ---

/**
 * Apply a settings patch to a camera. Reads the full config, deep-
 * merges into the camera slice, and POSTs the result back to
 * `/api/config/save?save_option=restart` so Frigate reloads the
 * camera with the new settings. The restart is what makes the
 * change visible (most camera-level settings need it).
 *
 * Validation here is structural — type/range checks. The route
 * layer should already have rejected obviously-bad inputs.
 */
export async function updateCameraSettings(
  cameraName: string,
  patch: CameraSettingsPatch,
): Promise<CameraSettings> {
  const config = (await fetchConfig()) as Record<string, unknown>;
  const cameras = config.cameras as Record<string, Record<string, unknown>> | undefined;
  if (!cameras?.[cameraName]) {
    throw new Error(`camera ${cameraName} not found`);
  }

  const camera = cameras[cameraName];

  if (patch.detectEnabled !== undefined || patch.detectFps !== undefined) {
    const detect = (camera.detect ?? {}) as Record<string, unknown>;
    if (patch.detectEnabled !== undefined) detect.enabled = patch.detectEnabled;
    if (patch.detectFps !== undefined) {
      if (!Number.isFinite(patch.detectFps) || patch.detectFps < 1 || patch.detectFps > 30) {
        throw new Error("detectFps must be between 1 and 30");
      }
      detect.fps = patch.detectFps;
    }
    camera.detect = detect;
  }

  if (patch.trackedLabels !== undefined || patch.objectFilters !== undefined) {
    const objects = (camera.objects ?? {}) as Record<string, unknown>;
    if (patch.trackedLabels !== undefined) {
      objects.track = patch.trackedLabels;
    }
    if (patch.objectFilters !== undefined) {
      const filters = (objects.filters ?? {}) as Record<string, Record<string, unknown>>;
      for (const [label, f] of Object.entries(patch.objectFilters)) {
        const existing = (filters[label] ?? {}) as Record<string, unknown>;
        if (f.threshold !== undefined) {
          if (f.threshold < 0 || f.threshold > 1) {
            throw new Error(`threshold for ${label} must be between 0 and 1`);
          }
          existing.threshold = f.threshold;
        }
        if (f.minScore !== undefined) {
          if (f.minScore < 0 || f.minScore > 1) {
            throw new Error(`minScore for ${label} must be between 0 and 1`);
          }
          existing.min_score = f.minScore;
        }
        filters[label] = existing;
      }
      objects.filters = filters;
    }
    camera.objects = objects;
  }

  if (patch.recordEnabled !== undefined || patch.recordRetainDays !== undefined) {
    const record = (camera.record ?? {}) as Record<string, unknown>;
    if (patch.recordEnabled !== undefined) record.enabled = patch.recordEnabled;
    if (patch.recordRetainDays !== undefined) {
      if (!Number.isFinite(patch.recordRetainDays) || patch.recordRetainDays < 0 || patch.recordRetainDays > 365) {
        throw new Error("recordRetainDays must be between 0 and 365");
      }
      const retain = (record.retain ?? {}) as Record<string, unknown>;
      retain.days = patch.recordRetainDays;
      record.retain = retain;
    }
    camera.record = record;
  }

  if (patch.snapshotsEnabled !== undefined || patch.snapshotRetainDays !== undefined) {
    const snapshots = (camera.snapshots ?? {}) as Record<string, unknown>;
    if (patch.snapshotsEnabled !== undefined) snapshots.enabled = patch.snapshotsEnabled;
    if (patch.snapshotRetainDays !== undefined) {
      if (!Number.isFinite(patch.snapshotRetainDays) || patch.snapshotRetainDays < 0 || patch.snapshotRetainDays > 365) {
        throw new Error("snapshotRetainDays must be between 0 and 365");
      }
      const retain = (snapshots.retain ?? {}) as Record<string, unknown>;
      retain.default = patch.snapshotRetainDays;
      snapshots.retain = retain;
    }
    camera.snapshots = snapshots;
  }

  await saveFrigateConfig(config);
  // Frigate restarts the camera asynchronously; the next read will
  // reflect the merged config even if the camera process is still
  // booting. Return the freshly-derived settings.
  return getCameraSettings(cameraName);
}

/**
 * POST the full Frigate config back. Frigate's save endpoint expects
 * a YAML body, but JSON-formatted text is valid YAML 1.2 so we send
 * the JSON serialisation as `text/plain` and let Frigate's safe_load
 * parse it. `save_option=restart` makes Frigate reload affected
 * cameras after persistence.
 */
async function saveFrigateConfig(config: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(config);
  const resp = await fetch(
    `${FRIGATE_URL}/api/config/save?save_option=restart`,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, body: errBody.slice(0, 200) },
      "Frigate config/save rejected",
    );
    throw new Error(`Frigate rejected the config: ${resp.status}`);
  }
}

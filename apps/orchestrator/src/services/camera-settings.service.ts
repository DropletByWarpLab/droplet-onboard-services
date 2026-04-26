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

/**
 * Frigate zone definition. Coordinates are stored as a flat list of
 * normalised [0, 1] (x, y) pairs in image space — Frigate's wire
 * shape is the comma-joined string ("0.1,0.2,0.5,0.6,0.4,0.9"); we
 * surface it as a structured array so the polygon editor can map
 * directly to SVG points.
 */
export interface CameraZone {
  name: string;
  /** Flat array of normalised coordinates: [x1, y1, x2, y2, ...]. */
  coordinates: number[];
  /** Object labels that trigger this zone — empty = any tracked label. */
  objects: string[];
  /** Pixel-distance an object must move while inside the zone before
   *  it counts as "in" the zone. Lower = trigger faster. */
  inertia: number;
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
  /** Defined zones (full coords, not just names — the polygon editor
   *  needs them). Phase 4.2 added these. */
  zones: CameraZone[];
  /** Whether a motion mask is configured (still read-only — Phase 4.3). */
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
  /** Replace the camera's zone set wholesale. Empty array deletes all
   *  zones; omitted leaves zones untouched. The polygon editor sends
   *  the full zone list each save so we don't have to track per-zone
   *  add/remove diffs. */
  zones?: CameraZone[];
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

  // Map each zone definition to a structured shape. Frigate stores
  // coordinates as a comma-joined string of normalised numbers; the
  // dashboard wants them as a flat array so the polygon editor can
  // map straight to SVG points. Bad/unparseable coords are dropped
  // for the affected zone (we'd rather show a slightly wrong polygon
  // than crash the page on a malformed config).
  const zoneList: CameraZone[] = Object.entries(zones).map(
    ([zoneName, raw]) => {
      const z = (raw ?? {}) as Record<string, unknown>;
      const coordsStr = String(z.coordinates ?? "");
      const coordinates = coordsStr
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      const objs = Array.isArray(z.objects)
        ? (z.objects as unknown[]).map(String)
        : [];
      return {
        name: zoneName,
        coordinates,
        objects: objs,
        inertia: Number(z.inertia ?? 3),
      };
    },
  );

  return {
    detectEnabled: Boolean(detect.enabled ?? true),
    detectFps: Number(detect.fps ?? 5),
    trackedLabels,
    objectFilters,
    recordEnabled: Boolean(record.enabled ?? false),
    recordRetainDays: Number(recordRetain.days ?? 0),
    snapshotsEnabled: Boolean(snapshots.enabled ?? false),
    snapshotRetainDays: Number(snapshotRetain.default ?? 10),
    zones: zoneList,
    hasMotionMask: Boolean(
      motion.mask &&
        (Array.isArray(motion.mask)
          ? (motion.mask as unknown[]).length > 0
          : String(motion.mask).length > 0),
    ),
  };
}

/** Frigate's zone-name regex is loose (any string). We tighten to a
 *  safer subset so a malicious caller can't smuggle YAML metacharacters
 *  through the config write path. */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

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

  if (patch.zones !== undefined) {
    // Wholesale-replace the camera's zones map. The editor sends the
    // full list each save so the diff lives in the UI, not here.
    const newZones: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const z of patch.zones) {
      if (!ZONE_NAME_RE.test(z.name)) {
        throw new Error(`Invalid zone name: ${z.name}`);
      }
      if (seen.has(z.name)) {
        throw new Error(`Duplicate zone name: ${z.name}`);
      }
      seen.add(z.name);
      // Polygons need at least 3 points → 6 coordinates.
      if (z.coordinates.length < 6 || z.coordinates.length % 2 !== 0) {
        throw new Error(`Zone ${z.name} needs at least 3 (x, y) points`);
      }
      for (const c of z.coordinates) {
        if (!Number.isFinite(c) || c < 0 || c > 1) {
          throw new Error(
            `Zone ${z.name} coordinates must be normalised [0, 1]`,
          );
        }
      }
      // Validate object labels structurally — each must be a non-empty
      // alphanumeric string. Empty list = "any tracked label."
      for (const obj of z.objects) {
        if (!/^[a-z0-9_-]{1,32}$/i.test(obj)) {
          throw new Error(`Zone ${z.name} has invalid object label: ${obj}`);
        }
      }
      if (!Number.isFinite(z.inertia) || z.inertia < 1 || z.inertia > 50) {
        throw new Error(`Zone ${z.name} inertia must be between 1 and 50`);
      }
      // Round coords to 4 decimals so the YAML writes are stable
      // across re-saves (avoids float-formatting noise diffs).
      const rounded = z.coordinates.map((c) => Math.round(c * 10000) / 10000);
      const entry: Record<string, unknown> = {
        coordinates: rounded.join(","),
        inertia: z.inertia,
      };
      if (z.objects.length > 0) entry.objects = z.objects;
      newZones[z.name] = entry;
    }
    camera.zones = newZones;
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

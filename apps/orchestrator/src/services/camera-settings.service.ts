/**
 * Per-camera settings — read + write the slice of Frigate's config
 * that an operator can dial in from the dashboard's
 * /cameras/[name]/settings page.
 *
 * Strategy — reads and writes deliberately use DIFFERENT sources:
 *
 *   read  → `/api/config`      the RESOLVED tree. A camera that doesn't
 *                              override a value inherits it from the
 *                              top-level block, and the operator should
 *                              see what is actually in force.
 *   write → `/api/config/raw`  the AUTHORED yaml, mutated in place and
 *                              saved back via `/api/config/save`.
 *
 * The resolved tree is NOT save-round-trippable on Frigate 0.17 — it
 * carries computed-only fields (`model.colormap`, `model.all_attributes`,
 * `auth.roles` populated with the reserved names, …) and the config models
 * are `extra="forbid"`. Measured against the live appliance, posting an
 * untouched resolved config back produces 42 validation errors. Until
 * WARP-1849 this service did exactly that, so no per-camera setting could
 * be saved at all. `deleteCamera` / `syncCamerasFromDb` in
 * frigate.client.ts had already hit this and switched to the authored
 * yaml; this path had not.
 *
 * Phase 4.1 covers the controls that don't need a polygon editor:
 *   - detect.enabled + fps
 *   - objects.track + per-label thresholds
 *   - record.enabled + the four retention windows
 *   - snapshots.enabled + retain.default
 *
 * Zones + motion masks (which need a canvas editor) come in Phase 4.2.
 *
 * WARP-1849 — retention keys. Frigate 0.17 removed `record.retain` and
 * split retention into four independent windows, which are the keys its
 * own `record/cleanup.py` expires against:
 *
 *   record.continuous.days          — 24/7 footage
 *   record.motion.days              — segments with motion
 *   record.alerts.retain.days       — review items escalated to alerts
 *   record.detections.retain.days   — lower-confidence review items
 *
 * `record.retain` is not merely ignored: `FrigateBaseModel` is declared
 * `ConfigDict(extra="forbid")`, so a camera block carrying it fails
 * validation and Frigate rejects the ENTIRE save — silently losing the
 * detection, object, zone and mask changes batched into the same patch.
 * That is why `stripLegacyRetain` strips the legacy key on every
 * write, not only when retention is the thing being edited.
 *
 * `snapshots.retain.default` is unchanged in 0.17 and remains correct.
 */

import { parseDocument, isMap, isScalar, type Document } from "yaml";

import {
  fetchConfig,
  fetchRawConfigYaml,
  saveRawConfig,
} from "./frigate.client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-settings");

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

/** A single motion-mask polygon. Same coordinate convention as zones —
 *  flat normalised [x1, y1, x2, y2, …]. Masks have no name + no per-mask
 *  metadata; they're just regions Frigate ignores for motion. */
export interface MotionMaskPolygon {
  coordinates: number[];
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
  /** Days of 24/7 footage to keep — Frigate's `record.continuous.days`.
   *  0 = keep no continuous footage (Frigate's own default); review
   *  segments are still retained per the alerts/detections windows. */
  continuousRetainDays: number;
  /** Days to keep segments that contain motion — `record.motion.days`. */
  motionRetainDays: number;
  /** Days to keep review items escalated to alerts —
   *  `record.alerts.retain.days`. */
  alertsRetainDays: number;
  /** Days to keep lower-confidence review items —
   *  `record.detections.retain.days`. */
  detectionsRetainDays: number;
  /** Whether per-event snapshots are saved. */
  snapshotsEnabled: boolean;
  /** How long event snapshots are kept (days). */
  snapshotRetainDays: number;
  /** Defined zones (full coords). Phase 4.2 surfaced these. */
  zones: CameraZone[];
  /** Motion-mask polygons. Empty array = no mask. Phase 4.3 added these. */
  motionMasks: MotionMaskPolygon[];
}

export interface CameraSettingsPatch {
  detectEnabled?: boolean;
  detectFps?: number;
  trackedLabels?: string[];
  objectFilters?: Record<string, Partial<ObjectFilter>>;
  recordEnabled?: boolean;
  continuousRetainDays?: number;
  motionRetainDays?: number;
  alertsRetainDays?: number;
  detectionsRetainDays?: number;
  snapshotsEnabled?: boolean;
  snapshotRetainDays?: number;
  /** Replace the camera's zone set wholesale. Empty array deletes all
   *  zones; omitted leaves zones untouched. The polygon editor sends
   *  the full zone list each save so we don't have to track per-zone
   *  add/remove diffs. */
  zones?: CameraZone[];
  /** Replace the camera's motion-mask polygons wholesale. Same
   *  whole-list-on-save semantics as zones. */
  motionMasks?: MotionMaskPolygon[];
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

  // WARP-1849: read the four windows Frigate 0.17 actually expires
  // against. A legacy `record.retain` block is deliberately NOT consulted
  // — Frigate ignores it, so surfacing its number would show the operator
  // a retention the appliance will never honour.
  const continuousRetain = (record.continuous ?? {}) as Record<string, unknown>;
  const motionRetain = (record.motion ?? {}) as Record<string, unknown>;
  const alerts = (record.alerts ?? {}) as Record<string, unknown>;
  const detections = (record.detections ?? {}) as Record<string, unknown>;
  const alertsRetain = (alerts.retain ?? {}) as Record<string, unknown>;
  const detectionsRetain = (detections.retain ?? {}) as Record<string, unknown>;
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

  // Frigate's motion.mask is loose: missing, a single comma-joined
  // string ("0.1,0.2,0.5,0.6,..."), or an array of such strings (one
  // entry per mask polygon). Normalise to a flat list of coord arrays.
  const motionMasks: MotionMaskPolygon[] = [];
  const rawMaskList: unknown[] = motion.mask === undefined
    ? []
    : Array.isArray(motion.mask)
      ? (motion.mask as unknown[])
      : [motion.mask];
  for (const entry of rawMaskList) {
    const coords = String(entry ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (coords.length >= 6 && coords.length % 2 === 0) {
      motionMasks.push({ coordinates: coords });
    }
  }

  return {
    detectEnabled: Boolean(detect.enabled ?? true),
    detectFps: Number(detect.fps ?? 5),
    trackedLabels,
    objectFilters,
    recordEnabled: Boolean(record.enabled ?? false),
    // Fallbacks mirror Frigate 0.17's own schema defaults so an unset key
    // reads as what Frigate will actually do: RecordRetainConfig.days = 0
    // for continuous/motion, ReviewRetainConfig.days = 10 for the review
    // windows.
    continuousRetainDays: Number(continuousRetain.days ?? 0),
    motionRetainDays: Number(motionRetain.days ?? 0),
    alertsRetainDays: Number(alertsRetain.days ?? 10),
    detectionsRetainDays: Number(detectionsRetain.days ?? 10),
    snapshotsEnabled: Boolean(snapshots.enabled ?? false),
    snapshotRetainDays: Number(snapshotRetain.default ?? 10),
    zones: zoneList,
    motionMasks,
  };
}

/** Frigate's zone-name regex is loose (any string). We tighten to a
 *  safer subset so a malicious caller can't smuggle YAML metacharacters
 *  through the config write path. */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/** Range-check one retention window. Frigate stores days as a float
 *  `ge=0`; we cap at 365 so a fat-fingered value can't silently commit
 *  the appliance to years of footage. */
function assertRetentionDays(days: number, field: string): void {
  if (!Number.isFinite(days) || days < 0 || days > 365) {
    throw new Error(`${field} must be between 0 and 365`);
  }
}


/**
 * Drop the pre-0.17 `record.retain` key from every camera before the
 * config goes back to Frigate.
 *
 * This runs on EVERY save, not just retention edits. `record.retain` is
 * rejected by `extra="forbid"`, so a config that still carries it —
 * authored by hand, migrated from an older Frigate, or written by the
 * dashboard before WARP-1849 — would fail validation on an unrelated save
 * (a zone edit, a tracked-object change) and lose that work with a message
 * pointing at a field the operator never touched.
 *
 * Returns the camera names cleaned, so the caller can log it once.
 */
function stripLegacyRetain(doc: Document): string[] {
  const cameras = doc.getIn(["cameras"]);
  if (!isMap(cameras)) return [];

  const cleaned: string[] = [];
  for (const item of cameras.items) {
    const key = item.key;
    const name = isScalar(key) ? String(key.value) : String(key);
    if (doc.getIn(["cameras", name, "record", "retain"]) !== undefined) {
      doc.deleteIn(["cameras", name, "record", "retain"]);
      cleaned.push(name);
    }
  }
  return cleaned;
}

// --- Write ---

/**
 * Apply a settings patch to a camera.
 *
 * WARP-1849 — this writes the AUTHORED YAML (`/api/config/raw`), not the
 * resolved tree from `/api/config`.
 *
 * The resolved config is not save-round-trippable on Frigate 0.17. It
 * carries computed-only fields (`model.colormap`, `model.all_attributes`,
 * `auth.roles` populated with the reserved names, …) and the config models
 * are `extra="forbid"`, so posting it back fails validation for reasons
 * that have nothing to do with what the operator changed. Measured against
 * the live appliance: an untouched resolved config produces **42**
 * validation errors on the way back in.
 *
 * `deleteCamera` and `syncCamerasFromDb` already worked off the authored
 * YAML for exactly this reason (see frigate.client.ts). This path had never
 * been converted — which meant no per-camera setting could be saved at all
 * on 0.17, not merely retention.
 *
 * Reads deliberately stay on the resolved config: a camera that doesn't
 * override a value inherits it from the top-level block, and the operator
 * should see what is actually in force.
 *
 * Validation is structural (type + range) and runs BEFORE any mutation, so
 * a rejected value can never leave a half-written camera block behind.
 */
export async function updateCameraSettings(
  cameraName: string,
  patch: CameraSettingsPatch,
): Promise<CameraSettings> {
  const doc = parseDocument(await fetchRawConfigYaml());
  if (doc.getIn(["cameras", cameraName]) === undefined) {
    throw new Error(`camera ${cameraName} not found`);
  }

  // Snapshot the effective settings BEFORE the write, while Frigate is
  // definitely up. The post-save read is unavailable (see the note at the
  // end of this function), so this is what the returned projection builds on.
  const before = await getCameraSettings(cameraName);

  const at = (...rest: string[]) => ["cameras", cameraName, ...rest];

  // ── validate ─────────────────────────────────────────────────────────
  if (patch.detectFps !== undefined) {
    if (
      !Number.isFinite(patch.detectFps) ||
      patch.detectFps < 1 ||
      patch.detectFps > 30
    ) {
      throw new Error("detectFps must be between 1 and 30");
    }
  }
  if (patch.continuousRetainDays !== undefined) {
    assertRetentionDays(patch.continuousRetainDays, "continuousRetainDays");
  }
  if (patch.motionRetainDays !== undefined) {
    assertRetentionDays(patch.motionRetainDays, "motionRetainDays");
  }
  if (patch.alertsRetainDays !== undefined) {
    assertRetentionDays(patch.alertsRetainDays, "alertsRetainDays");
  }
  if (patch.detectionsRetainDays !== undefined) {
    assertRetentionDays(patch.detectionsRetainDays, "detectionsRetainDays");
  }
  if (patch.snapshotRetainDays !== undefined) {
    assertRetentionDays(patch.snapshotRetainDays, "snapshotRetainDays");
  }

  if (patch.objectFilters !== undefined) {
    for (const [label, f] of Object.entries(patch.objectFilters)) {
      if (f.threshold !== undefined && (f.threshold < 0 || f.threshold > 1)) {
        throw new Error(`threshold for ${label} must be between 0 and 1`);
      }
      if (f.minScore !== undefined && (f.minScore < 0 || f.minScore > 1)) {
        throw new Error(`minScore for ${label} must be between 0 and 1`);
      }
    }
  }

  // Zones and masks are validated into their Frigate wire shape first; the
  // doc is only touched once every polygon has passed.
  let newZones: Record<string, unknown> | undefined;
  if (patch.zones !== undefined) {
    newZones = {};
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
      for (const obj of z.objects) {
        if (!/^[a-z0-9_-]{1,32}$/i.test(obj)) {
          throw new Error(`Zone ${z.name} has invalid object label: ${obj}`);
        }
      }
      if (!Number.isFinite(z.inertia) || z.inertia < 1 || z.inertia > 50) {
        throw new Error(`Zone ${z.name} inertia must be between 1 and 50`);
      }
      // Round coords to 4 decimals so the YAML writes are stable across
      // re-saves (avoids float-formatting noise diffs).
      const rounded = z.coordinates.map((c) => Math.round(c * 10000) / 10000);
      const entry: Record<string, unknown> = {
        coordinates: rounded.join(","),
        inertia: z.inertia,
      };
      if (z.objects.length > 0) entry.objects = z.objects;
      newZones[z.name] = entry;
    }
  }

  let newMasks: string[] | undefined;
  if (patch.motionMasks !== undefined) {
    newMasks = [];
    for (const m of patch.motionMasks) {
      if (m.coordinates.length < 6 || m.coordinates.length % 2 !== 0) {
        throw new Error("Each motion mask needs at least 3 (x, y) points");
      }
      for (const c of m.coordinates) {
        if (!Number.isFinite(c) || c < 0 || c > 1) {
          throw new Error("Motion mask coordinates must be normalised [0, 1]");
        }
      }
      const rounded = m.coordinates.map((c) => Math.round(c * 10000) / 10000);
      newMasks.push(rounded.join(","));
    }
  }

  // ── apply ────────────────────────────────────────────────────────────
  if (patch.detectEnabled !== undefined) {
    doc.setIn(at("detect", "enabled"), patch.detectEnabled);
  }
  if (patch.detectFps !== undefined) {
    doc.setIn(at("detect", "fps"), patch.detectFps);
  }

  if (patch.trackedLabels !== undefined) {
    doc.setIn(at("objects", "track"), doc.createNode(patch.trackedLabels));
  }
  if (patch.objectFilters !== undefined) {
    for (const [label, f] of Object.entries(patch.objectFilters)) {
      if (f.threshold !== undefined) {
        doc.setIn(at("objects", "filters", label, "threshold"), f.threshold);
      }
      if (f.minScore !== undefined) {
        doc.setIn(at("objects", "filters", label, "min_score"), f.minScore);
      }
    }
  }

  if (patch.recordEnabled !== undefined) {
    doc.setIn(at("record", "enabled"), patch.recordEnabled);
  }
  // The four windows Frigate 0.17 expires against. `continuous` and
  // `motion` are plain RecordRetainConfig blocks; `alerts` and
  // `detections` nest theirs under `retain` (EventsConfig.retain),
  // alongside `mode` / `pre_capture` / `post_capture`, which setIn leaves
  // untouched.
  if (patch.continuousRetainDays !== undefined) {
    doc.setIn(at("record", "continuous", "days"), patch.continuousRetainDays);
  }
  if (patch.motionRetainDays !== undefined) {
    doc.setIn(at("record", "motion", "days"), patch.motionRetainDays);
  }
  if (patch.alertsRetainDays !== undefined) {
    doc.setIn(at("record", "alerts", "retain", "days"), patch.alertsRetainDays);
  }
  if (patch.detectionsRetainDays !== undefined) {
    doc.setIn(
      at("record", "detections", "retain", "days"),
      patch.detectionsRetainDays,
    );
  }

  if (patch.snapshotsEnabled !== undefined) {
    doc.setIn(at("snapshots", "enabled"), patch.snapshotsEnabled);
  }
  if (patch.snapshotRetainDays !== undefined) {
    doc.setIn(at("snapshots", "retain", "default"), patch.snapshotRetainDays);
  }

  if (newZones !== undefined) {
    // The editor sends the full zone list each save, so a zone absent from
    // the payload was deleted. But do NOT rebuild the block wholesale:
    // getCameraSettings models only coordinates/objects/inertia, while
    // Frigate 0.17's ZoneConfig also carries loitering_time,
    // speed_threshold, distances and filters. Rewriting from the reduced
    // shape would silently delete operator-authored fields the dashboard
    // cannot even display.
    //
    // So: drop only the zones that actually went away, and merge the three
    // fields we own into the survivors, leaving their other keys intact.
    if (Object.keys(newZones).length === 0) {
      // All zones removed — drop the parent key rather than leaving an
      // empty `zones: {}` map behind.
      doc.deleteIn(at("zones"));
    } else {
      const existing = doc.getIn(at("zones"));
      if (isMap(existing)) {
        for (const item of existing.items) {
          const key = item.key;
          const zoneName = isScalar(key) ? String(key.value) : String(key);
          if (!(zoneName in newZones)) doc.deleteIn(at("zones", zoneName));
        }
      }
    }
    for (const [zoneName, entry] of Object.entries(newZones)) {
      const e = entry as Record<string, unknown>;
      doc.setIn(at("zones", zoneName, "coordinates"), e.coordinates);
      doc.setIn(at("zones", zoneName, "inertia"), e.inertia);
      if (e.objects !== undefined) {
        doc.setIn(at("zones", zoneName, "objects"), doc.createNode(e.objects));
      } else if (doc.getIn(at("zones", zoneName)) !== undefined) {
        // Objects cleared to "any tracked label" — remove the key rather
        // than writing an empty list, matching Frigate's default.
        doc.deleteIn(at("zones", zoneName, "objects"));
      }
    }
  }

  if (newMasks !== undefined) {
    if (newMasks.length === 0) {
      // `deleteIn` THROWS when an intermediate node is missing ("Expected
      // YAML collection at motion"), and addCamera authors camera blocks
      // with no `motion:` key at all — so clearing masks on an
      // appliance-provisioned camera would 500 and take the zones edit in
      // the same patch down with it. Only delete when the parent exists.
      // (`setIn` auto-creates intermediates, so the write path below is
      // unaffected; this asymmetry is the whole trap.)
      if (doc.getIn(at("motion")) !== undefined) {
        doc.deleteIn(at("motion", "mask"));
      }
    } else {
      // Always an array, even single-entry, so a future polygon append
      // doesn't have to special-case the string form.
      doc.setIn(at("motion", "mask"), doc.createNode(newMasks));
    }
  }

  // Strip the pre-0.17 `record.retain` key from EVERY camera, not just this
  // one. It is rejected by `extra="forbid"`, so config written by hand, by
  // an older Frigate, or by this dashboard before WARP-1849 would otherwise
  // sink an unrelated save with an error naming a field the operator never
  // touched.
  const cleaned = stripLegacyRetain(doc);
  if (cleaned.length > 0) {
    logger.info(
      { cameras: cleaned },
      "dropped legacy record.retain block(s) Frigate 0.17 would reject",
    );
  }

  const resp = await saveRawConfig(String(doc));
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    logger.warn(
      { status: resp.status, camera: cameraName, body: errBody.slice(0, 200) },
      "Frigate config/save rejected while updating camera settings",
    );
    throw new Error(`Frigate rejected the config: ${resp.status}`);
  }

  // Do NOT read back from Frigate here.
  //
  // `save_option=restart` tells Frigate to persist and reload. `/api/config`
  // is served from the running process's in-memory config, so an immediate
  // GET either (a) hits a socket that is refused mid-restart — turning a save
  // that LANDED into a 500 the operator reads as "couldn't save" — or (b) is
  // answered by the pre-restart process and returns the OLD values, which the
  // dashboard pins with `mutate(next, { revalidate: false })`, snapping the
  // slider the operator just moved back to where it was.
  //
  // Instead, project the result from the settings we read before the write
  // plus the patch we know we applied. Frigate has accepted the config (a
  // non-2xx already threw above), so this is the state it is booting into.
  return projectSettings(before, patch);
}

/**
 * Apply a validated patch to a settings snapshot, producing the state the
 * appliance is converging on.
 *
 * This is NOT a guess: every field here was just written to the authored
 * yaml and accepted by Frigate's validator. It exists so the caller never
 * has to read from a process that is mid-restart.
 */
function projectSettings(
  before: CameraSettings,
  patch: CameraSettingsPatch,
): CameraSettings {
  const next: CameraSettings = {
    ...before,
    zones: before.zones.map((z) => ({ ...z })),
    motionMasks: before.motionMasks.map((m) => ({ ...m })),
    objectFilters: { ...before.objectFilters },
  };

  if (patch.detectEnabled !== undefined) next.detectEnabled = patch.detectEnabled;
  if (patch.detectFps !== undefined) next.detectFps = patch.detectFps;
  if (patch.trackedLabels !== undefined) next.trackedLabels = [...patch.trackedLabels];
  if (patch.objectFilters !== undefined) {
    for (const [label, f] of Object.entries(patch.objectFilters)) {
      const cur = next.objectFilters[label] ?? { threshold: 0.7, minScore: 0.5 };
      next.objectFilters[label] = {
        threshold: f.threshold ?? cur.threshold,
        minScore: f.minScore ?? cur.minScore,
      };
    }
  }
  if (patch.recordEnabled !== undefined) next.recordEnabled = patch.recordEnabled;
  if (patch.continuousRetainDays !== undefined) {
    next.continuousRetainDays = patch.continuousRetainDays;
  }
  if (patch.motionRetainDays !== undefined) next.motionRetainDays = patch.motionRetainDays;
  if (patch.alertsRetainDays !== undefined) next.alertsRetainDays = patch.alertsRetainDays;
  if (patch.detectionsRetainDays !== undefined) {
    next.detectionsRetainDays = patch.detectionsRetainDays;
  }
  if (patch.snapshotsEnabled !== undefined) next.snapshotsEnabled = patch.snapshotsEnabled;
  if (patch.snapshotRetainDays !== undefined) {
    next.snapshotRetainDays = patch.snapshotRetainDays;
  }
  if (patch.zones !== undefined) next.zones = patch.zones.map((z) => ({ ...z }));
  if (patch.motionMasks !== undefined) {
    next.motionMasks = patch.motionMasks.map((m) => ({ ...m }));
  }

  return next;
}

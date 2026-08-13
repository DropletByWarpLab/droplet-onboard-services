/**
 * WARP-1957 — what a newly adopted camera actually keeps.
 *
 * ## The bug this exists to close
 *
 * Both adoption writers used to send `record: { enabled: true }` and
 * nothing else. Frigate 0.17 expires against FOUR independent windows,
 * and `docker/frigate/config.yml` defines only two of them at the top
 * level (`alerts.retain.days`, `detections.retain.days`). It has no
 * `continuous:` and no `motion:` key at all, and Frigate's schema
 * defaults both to **0** — "keep nothing".
 *
 * So every camera we adopted decoded, detected and wrote segments to
 * cache, but kept only the segments overlapping an alert or detection
 * review item. Scrub back to 3am and there was nothing there, while the
 * UI said "Recording". Measured on the box: sparse event-only segments
 * until someone hand-set `continuous: 8`, then a full 360 segments/hour.
 *
 * ## Why the defaults live HERE and not in config.yml
 *
 * The obvious fix — put `continuous:` and `motion:` in the top-level
 * `record:` block — is a trap. `docker/frigate/config.yml` is **dirty by
 * design on every box**: Frigate writes live camera registrations into it
 * in place via `PUT /api/config/set`. A tracked change to that file means
 * the next `git checkout` during a box refresh sees it differ between
 * commits and clobbers real camera state.
 *
 * Writing explicit per-camera values on adoption avoids that entirely,
 * and has the side benefit that each camera's retention is visible in its
 * own block rather than inherited invisibly.
 *
 * ## Configurable, not hardcoded
 *
 * Values come from the environment so an operator can change what new
 * cameras get without a code change, and both adoption writers (this one
 * and the Python one in `services/camera-discovery`) read the same names.
 * Keep the two in sync — `camera_retention_defaults.py` mirrors this file.
 */

/**
 * Frigate 0.17's `RecordConfig` bounds `pre_capture` and `post_capture`
 * at `le=60`. Verified against the running container's own pydantic model
 * rather than the docs:
 *
 *   docker exec droplet-frigate-1 python3 -c \
 *     "from frigate.config.camera.record import RecordConfig; \
 *      RecordConfig(**{'alerts':{'pre_capture':120}})"
 *   -> Input should be less than or equal to 60
 *
 * A value over the bound fails the WHOLE config save (the model is
 * `extra="forbid"` and validates strictly), taking the rest of the camera
 * block down with it. So this is clamped everywhere it is accepted.
 */
export const MAX_CAPTURE_PADDING_SEC = 60;

/** Frigate rejects retention windows above this; keep the UI in step. */
export const MAX_RETENTION_DAYS = 90;

export interface CameraRetentionDefaults {
  /** Days of 24/7 footage. 0 = don't keep any. */
  continuousDays: number;
  /** Days to keep segments containing motion. */
  motionDays: number;
  /** Days to keep alert review items. */
  alertsRetainDays: number;
  /** Days to keep lower-confidence detection review items. */
  detectionsRetainDays: number;
  /** Seconds of footage kept BEFORE an event starts. */
  preCaptureSec: number;
  /** Seconds of footage kept AFTER an event ends. */
  postCaptureSec: number;
  /** Days to keep event snapshots. */
  snapshotRetainDays: number;
}

/**
 * Shipped defaults, agreed with Stefan 2026-08-13: three days of 24/7
 * footage so any moment in the last 72 hours is scrubbable, a month of
 * motion segments so the interesting parts outlive that, and 20 seconds
 * of padding on each side of an event so a clip opens before the thing
 * that triggered it.
 *
 * Costed against the measured rate on the box (~0.65 GB/hr while
 * writing): 3 days of continuous is roughly 46 GB per camera, comfortable
 * on the 1.8 TB array.
 */
export const SHIPPED_RETENTION_DEFAULTS: Readonly<CameraRetentionDefaults> = Object.freeze({
  continuousDays: 3,
  motionDays: 30,
  alertsRetainDays: 14,
  detectionsRetainDays: 14,
  preCaptureSec: 20,
  postCaptureSec: 20,
  snapshotRetainDays: 14,
});

/**
 * Read one numeric override.
 *
 * Compose writes `FOO=` for an unset variable, so an EMPTY STRING must be
 * treated as absent — `Number("")` is 0, which would silently mean "keep
 * nothing" for a retention window. That footgun has bitten this repo
 * before via `${VAR:-}` defeating a zod `.default()`.
 */
function envNumber(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * The retention a newly adopted camera is given, with environment
 * overrides applied. Pass `env` in tests; defaults to `process.env`.
 */
export function resolveRetentionDefaults(
  env: NodeJS.ProcessEnv = process.env,
): CameraRetentionDefaults {
  const d = SHIPPED_RETENTION_DEFAULTS;
  return {
    continuousDays: envNumber(
      env.NVR_DEFAULT_CONTINUOUS_DAYS,
      d.continuousDays,
      MAX_RETENTION_DAYS,
    ),
    motionDays: envNumber(env.NVR_DEFAULT_MOTION_DAYS, d.motionDays, MAX_RETENTION_DAYS),
    alertsRetainDays: envNumber(
      env.NVR_DEFAULT_ALERTS_RETAIN_DAYS,
      d.alertsRetainDays,
      MAX_RETENTION_DAYS,
    ),
    detectionsRetainDays: envNumber(
      env.NVR_DEFAULT_DETECTIONS_RETAIN_DAYS,
      d.detectionsRetainDays,
      MAX_RETENTION_DAYS,
    ),
    preCaptureSec: envNumber(
      env.NVR_DEFAULT_EVENT_PRE_CAPTURE_SEC,
      d.preCaptureSec,
      MAX_CAPTURE_PADDING_SEC,
    ),
    postCaptureSec: envNumber(
      env.NVR_DEFAULT_EVENT_POST_CAPTURE_SEC,
      d.postCaptureSec,
      MAX_CAPTURE_PADDING_SEC,
    ),
    snapshotRetainDays: envNumber(
      env.NVR_DEFAULT_SNAPSHOT_RETAIN_DAYS,
      d.snapshotRetainDays,
      MAX_RETENTION_DAYS,
    ),
  };
}

/**
 * The `record:` block to send to Frigate for a newly adopted camera.
 *
 * Shape matches Frigate 0.17's `RecordConfig` exactly — verified against
 * the running container's pydantic model, which accepted this literal.
 * Note `alerts`/`detections` nest their days under `retain`, while
 * `continuous`/`motion` do not; getting that wrong fails the whole save.
 */
export function buildRecordBlock(
  defaults: CameraRetentionDefaults = resolveRetentionDefaults(),
): Record<string, unknown> {
  return {
    enabled: true,
    continuous: { days: defaults.continuousDays },
    motion: { days: defaults.motionDays },
    alerts: {
      retain: { days: defaults.alertsRetainDays },
      pre_capture: defaults.preCaptureSec,
      post_capture: defaults.postCaptureSec,
    },
    detections: {
      retain: { days: defaults.detectionsRetainDays },
      pre_capture: defaults.preCaptureSec,
      post_capture: defaults.postCaptureSec,
    },
  };
}

/** The `snapshots:` block for a newly adopted camera. */
export function buildSnapshotsBlock(
  defaults: CameraRetentionDefaults = resolveRetentionDefaults(),
): Record<string, unknown> {
  return {
    enabled: true,
    retain: { default: defaults.snapshotRetainDays },
  };
}

/**
 * Does this camera keep anything at all?
 *
 * `record.enabled` is NOT the answer, and neither is a live frame rate.
 * Frigate keeps a segment if ANY of the four windows still covers it, so
 * "retaining" means at least one of them is above zero. A camera with all
 * four at 0 is decoding and detecting and storing nothing — which is
 * exactly the state that made the UI claim "Recording" over an empty
 * timeline.
 */
export function retainsFootage(record: {
  enabled?: boolean;
  continuousDays?: number;
  motionDays?: number;
  alertsRetainDays?: number;
  detectionsRetainDays?: number;
}): boolean {
  if (record.enabled === false) return false;
  return (
    (record.continuousDays ?? 0) > 0 ||
    (record.motionDays ?? 0) > 0 ||
    (record.alertsRetainDays ?? 0) > 0 ||
    (record.detectionsRetainDays ?? 0) > 0
  );
}

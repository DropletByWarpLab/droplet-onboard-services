/**
 * WARP-3511 — the ranges a camera's settings accept, in ONE place.
 *
 * The orchestrator validates a settings PATCH against these and the
 * dashboard's sliders are drawn from them. They used to be two sets of
 * numbers — detection FPS 1–15 on the sliders but 1–30 in the service, and
 * retention 0–90 on the sliders but 0–365 in the service — so the form could
 * not express a value the API accepted, and an API caller could set one the
 * form could not show.
 *
 * These are the appliance's own limits, not Frigate's: Frigate 0.17's config
 * puts no upper bound on `detect.fps` or on any retention `days` (only
 * `ge=0`). They exist so a fat-fingered value cannot silently commit the box
 * to a detector it cannot feed or to a year of footage.
 */

/** Detection frames per second Frigate is asked to process, per camera. */
export const CAMERA_DETECT_FPS_MIN = 1;
export const CAMERA_DETECT_FPS_MAX = 30;

/**
 * Days a retention window may keep footage: each of continuous, motion,
 * alerts and detections, and event snapshots. 0 closes a window.
 */
export const CAMERA_RETENTION_DAYS_MAX = 90;

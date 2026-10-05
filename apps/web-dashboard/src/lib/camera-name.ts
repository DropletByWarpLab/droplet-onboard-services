/**
 * Camera NAME normalisation (WARP-3505 / WARP-3506).
 *
 * The name is the Frigate camera key. Everything the appliance generates itself
 * is lowercase with underscores (camera-discovery's `_sanitize_camera_name`), so
 * the form turns what the operator types into that shape as they type, rather
 * than accepting "Front-Door" and leaving them with a key no other surface
 * would ever produce. Spaces and hyphens become underscores; anything else that
 * is not a lowercase letter or digit is dropped.
 *
 * Deliberately NOT trimmed: a typed space becomes an underscore at once, so
 * "front door" can be typed as it is said. Leading/trailing underscores are
 * valid for the orchestrator's name rule (`isValidCameraName`).
 */

/** The orchestrator rejects names longer than this (1-64 chars). */
export const CAMERA_NAME_MAX = 64;

export function normalizeCameraName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, CAMERA_NAME_MAX);
}

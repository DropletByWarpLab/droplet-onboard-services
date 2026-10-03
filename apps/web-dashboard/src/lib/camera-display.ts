import type { CameraInfo } from "@/lib/types";

/**
 * Frigate camera keys are slugs ("warp_lab_office"); the household names them
 * ("Warp Lab Office"). The orchestrator derives a camera's default displayName
 * from its key as `name.replace(/_/g, " ")` with every word capitalised
 * (camera.service.ts toDisplayName) — this is the same rule, for a key the
 * cameras list does not carry (yet), so it reads the way the list will name it
 * a moment later.
 */
export function prettifyCameraKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Frigate camera key → the name to show for it (WARP-3509).
 *
 * The Events page named cameras by key on its cards while its filter chips
 * showed `displayName`. Resolving both through the cameras list keeps a card
 * and a chip from disagreeing about the same camera. A camera the list does not
 * carry — still loading, or since removed — reads as its prettified key rather
 * than the raw slug.
 */
export function cameraLabeler(
  cameras: ReadonlyArray<Pick<CameraInfo, "name" | "displayName">>,
): (key: string) => string {
  const byKey = new Map(cameras.map((c) => [c.name, c.displayName]));
  return (key) => byKey.get(key) || prettifyCameraKey(key);
}

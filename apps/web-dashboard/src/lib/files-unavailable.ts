/**
 * WARP-3076 — the Files "unavailable" state, kept out of `api.ts` so test
 * files that mock `@/lib/api` wholesale still get the real guard and copy.
 */

/** Discriminator carried by `FilesUnavailableError`. */
export const FILES_UNAVAILABLE = "FILES_UNAVAILABLE";
export const FILES_UNAVAILABLE_TITLE = "Files are unavailable right now";
export const FILES_UNAVAILABLE_HINT = "Try again in a moment.";

/**
 * WARP-3076 — thrown by the Files read fetchers when the box marks its answer
 * `X-Droplet-Degraded` (WARP-3052): Nextcloud is down and the 200 carries the
 * empty fallback body, byte-identical to a genuinely empty folder or Trash.
 * Resolving it as `[]` is how "Trash is empty" got shown during an outage.
 */
export class FilesUnavailableError extends Error {
  readonly code = FILES_UNAVAILABLE;

  constructor() {
    super(`${FILES_UNAVAILABLE_TITLE}. ${FILES_UNAVAILABLE_HINT}`);
    this.name = "FilesUnavailableError";
  }
}

/** Structural, like `isTrashUnsupportedError`, so it survives mocked modules. */
export function isFilesUnavailableError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === FILES_UNAVAILABLE
  );
}

/**
 * WARP-3105 — the same contract for cameras: the Events and Reviews routes
 * answer a Frigate outage with 200 + an empty list marked
 * `X-Droplet-Degraded: frigate-unavailable`. Kept here beside the Files guard
 * so both "service unavailable" states share one module.
 */
export const CAMERAS_UNAVAILABLE = "CAMERAS_UNAVAILABLE";
export const CAMERAS_UNAVAILABLE_TITLE = "Cameras are unavailable right now";

export class CamerasUnavailableError extends Error {
  readonly code = CAMERAS_UNAVAILABLE;

  constructor() {
    super(`${CAMERAS_UNAVAILABLE_TITLE}. ${FILES_UNAVAILABLE_HINT}`);
    this.name = "CamerasUnavailableError";
  }
}

export function isCamerasUnavailableError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === CAMERAS_UNAVAILABLE
  );
}

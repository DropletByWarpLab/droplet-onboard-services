/**
 * WARP-3430 — where an anonymous box finds its release: plain file downloads
 * under one base URL (config.DROPLET_OTA_DOWNLOAD_BASE, default
 * `https://github.com/DropletByWarpLab/droplet-onboard-services/releases/download`).
 * No REST API, no token (ADR-045: none may sit on an appliance), so no
 * 60-requests-an-hour-per-IP cap.
 *
 *   <base>/ota-index/channel-<channel>.json(.sig)   the signed channel pointer
 *   <base>/<tag>/<name>                             a release's own assets
 *
 * Pure string builders shared by discovery (poller.ts) and apply (apply.ts).
 * Every variable segment is percent-encoded, so a tag or asset name read from
 * a document can never add a path segment or a query.
 */

function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** `<base>/ota-index/channel-<channel>.json` — append `.sig` for its signature. */
export function channelPointerUrl(base: string, channel: string): string {
  return `${trimBase(base)}/ota-index/channel-${encodeURIComponent(channel)}.json`;
}

/** `<base>/<tag>/<name>` — an asset of the release with exactly this tag; never `latest`. */
export function releaseAssetDownloadUrl(base: string, tag: string, name: string): string {
  return `${trimBase(base)}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

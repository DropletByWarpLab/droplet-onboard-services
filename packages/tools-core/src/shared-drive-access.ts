/** Index owner for the SMB volume. This key is never an authorization grant. */
export const SHARED_DRIVE_INDEX_USER = "__droplet_share__";

/** Canonical Nextcloud path of a file under the configured /Droplet mount. */
export function isSharedDrivePath(path: string): boolean {
  return path.startsWith("/Droplet/") &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export interface SharedDriveHit {
  path: string;
  source?: string;
  /** Indexed Nextcloud identity, retained through dedupe and result caching. */
  externalFileId?: number;
}

/**
 * Gate shared-volume results with the requesting person's CURRENT WebDAV
 * credential, including cached snippets. A mounted folder or a role alone
 * does not establish per-file access. Never cache a positive verdict across
 * calls, and compare file IDs so a replaced path cannot expose an old file.
 */
export async function authorizeSharedDriveHits<T extends SharedDriveHit>(
  hits: T[],
  resolveCurrentFileId: (path: string) => Promise<number | null>,
): Promise<T[]> {
  const decisions = new Map<string, Promise<boolean>>();
  const permitted: T[] = [];
  // Bound network fan-out while preserving the search's ranking order.
  for (let offset = 0; offset < hits.length; offset += 8) {
    const batch = hits.slice(offset, offset + 8);
    const allowed = await Promise.all(batch.map(async (hit) => {
      const shared = hit.externalFileId !== undefined ||
        (hit.source !== "brain" && (hit.path === "/Droplet" || hit.path.startsWith("/Droplet/")));
      if (!shared) return true;
      if (!isSharedDrivePath(hit.path) || !Number.isSafeInteger(hit.externalFileId) || hit.externalFileId! <= 0) return false;
      const key = JSON.stringify([hit.path, hit.externalFileId]);
      let decision = decisions.get(key);
      if (!decision) {
        decision = Promise.resolve().then(() => resolveCurrentFileId(hit.path))
          .then((current) => current === hit.externalFileId, () => false);
        decisions.set(key, decision);
      }
      return decision;
    }));
    permitted.push(...batch.filter((_, index) => allowed[index]));
  }
  return permitted;
}

import {
  authorizeSharedDriveHits,
  isSharedDrivePath,
  type HttpClient,
  type SharedDriveHit,
} from "@droplet/tools-core";

/** Check live per-file access through the caller's own Nextcloud credential. */
export async function authorizeMcpSharedDriveHits<T extends SharedDriveHit>(
  client: HttpClient,
  userId: string,
  ncToken: string | undefined,
  hits: T[],
): Promise<T[]> {
  const currentIds = new Map<string, number>();
  if (ncToken) {
    const candidates = [...new Map(hits.filter((hit) =>
      isSharedDrivePath(hit.path) && Number.isSafeInteger(hit.externalFileId) && hit.externalFileId! > 0,
    ).map((hit) => [JSON.stringify([hit.path, hit.externalFileId]), {
      path: hit.path, externalFileId: hit.externalFileId!,
    }])).values()];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const files = candidates.slice(offset, offset + 100);
      try {
        const response = await client.post("/shared-drive/access", { files }, {
          headers: { "X-Nextcloud-User": userId, "X-Nextcloud-Token": ncToken },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) continue;
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("files" in body) || !Array.isArray(body.files)) continue;
        const requested = new Set(files.map((file) => JSON.stringify([file.path, file.externalFileId])));
        for (const file of body.files as unknown[]) {
          if (!file || typeof file !== "object" || !("path" in file) || !("externalFileId" in file)) continue;
          if (typeof file.path !== "string" || !Number.isSafeInteger(file.externalFileId)) continue;
          if (requested.has(JSON.stringify([file.path, file.externalFileId]))) {
            currentIds.set(file.path, file.externalFileId as number);
          }
        }
      } catch {
        // Unreachable API, expired credentials or malformed JSON deny this batch.
      }
    }
  }
  return authorizeSharedDriveHits(hits, async (path) => currentIds.get(path) ?? null);
}

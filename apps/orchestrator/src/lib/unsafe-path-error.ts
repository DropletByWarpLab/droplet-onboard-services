/**
 * WARP-1262 (security): a caller-supplied path contains a `..` traversal
 * segment. Mapped to HTTP 400 by the files router's `handleFileError`, so a
 * traversal is a clean client error instead of an escaped WebDAV request.
 *
 * A leaf module (WARP-3193 SEC-INJ-6) because both `routes/files.ts`
 * (`rootForSpace`) and `services/nextcloud.client.ts` (`webdavUrl`) throw it,
 * and route tests mock the client module wholesale — the class must not
 * vanish with the mock.
 */
export class UnsafePathError extends Error {
  constructor(message = "path must not contain '..' segments") {
    super(message);
    this.name = "UnsafePathError";
  }
}

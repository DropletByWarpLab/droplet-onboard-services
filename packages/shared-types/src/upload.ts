/**
 * Maximum number of files accepted by a single `POST /api/files/upload`
 * request.
 *
 * WARP-1666: this constant is shared on purpose. The orchestrator enforces it
 * through multer and the dashboard batches selections into chunks of the same
 * size — when those two numbers lived apart, the client happily posted 36 files
 * at a server that accepted 20, and multer rejected the whole request with
 * `LIMIT_UNEXPECTED_FILE`. That code is also what a genuinely misnamed field
 * raises, so the user was told their field name was wrong when the real problem
 * was the count, and all 36 files were dropped.
 *
 * WARP-2093: no longer a memory bound — parts stream through the
 * orchestrator into Nextcloud one at a time and are never buffered whole. It
 * stays 20 because a request is committed as a unit (every part staged,
 * then moved into place), so it bounds how much one request stages before
 * anything lands, and how much a failed request throws away.
 */
export const MAX_FILES_PER_UPLOAD = 20;

/**
 * Byte ceiling for the files packed into a single `POST /api/files/upload`
 * request.
 *
 * WARP-1843: nginx caps the upload request body (`client_max_body_size` on
 * `location = /api/files/upload`, `docker/nginx/nginx.conf`) and rejects an
 * over-cap request WHOLESALE with a 413 — so a batch of files that are each
 * within the per-file limit still all failed together whenever their SUM
 * crossed the cap. The dashboard packs upload batches so summed file bytes
 * stay at or under this ceiling, ~10% below the nginx cap (1100M) to leave
 * headroom for multipart framing (per-part headers + boundaries).
 *
 * A single file larger than this ceiling is still sent — alone in its own
 * batch — so the server (the authority on per-file / per-user caps) answers
 * with its honest 413 / policy error instead of the client silently dropping
 * the file.
 *
 * WARP-2093: the old 90 MB value was the orchestrator's OOM guard (uploads
 * were buffered by `multer.memoryStorage()` in a 768 MB container). Uploads
 * now stream, so this tracks nginx instead. Raise the two together; the
 * per-file ceiling is Nextcloud's own 1 GiB request limit (APACHE_BODY_LIMIT),
 * mirrored by the orchestrator's MAX_UPLOAD_SIZE_MB default.
 */
export const MAX_UPLOAD_BATCH_BYTES = 1000 * 1024 * 1024;

/**
 * WARP-2096 — what `POST /api/files/upload` did with each file, per entry of
 * its `uploaded` array:
 *   - `uploaded`  written under the requested name, nothing replaced;
 *   - `renamed`   the name was taken, so it was kept under `name` and the
 *                 entry carries `requestedName` (the dashboard default —
 *                 never a silent overwrite);
 *   - `replaced`  an existing file was overwritten: `?overwrite=true` on the
 *                 multipart path, or write_file's documented contract on the
 *                 JSON path.
 * Independently, `duplicateOf` names a file with the SAME bytes the caller
 * already has in that space (advisory; the upload is still kept).
 */
export type UploadEntryStatus = "uploaded" | "renamed" | "replaced";

export interface UploadedFileEntry {
  /** Final basename on the box (differs from `requestedName` when renamed). */
  name: string;
  path: string;
  size: number;
  status: UploadEntryStatus;
  requestedName?: string;
  duplicateOf?: string;
}

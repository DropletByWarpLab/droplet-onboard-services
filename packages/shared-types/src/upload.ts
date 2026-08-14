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
 * The ceiling is a memory bound, not a policy one: uploads are buffered in RAM
 * (`multer.memoryStorage()`) and each file may be as large as the caller's
 * effective `MAX_UPLOAD_SIZE_MB`, so raising this raises peak resident memory
 * per in-flight request on the box.
 */
export const MAX_FILES_PER_UPLOAD = 20;

/**
 * Byte ceiling for the files packed into a single `POST /api/files/upload`
 * request.
 *
 * WARP-1843: nginx caps every `/api/` request body at
 * `client_max_body_size 100M` (`docker/nginx/nginx.conf`) and rejects an
 * over-cap request WHOLESALE with a 413 — so a batch of files that are each
 * within the per-file limit still all failed together whenever their SUM
 * crossed the cap. The dashboard packs upload batches so summed file bytes
 * stay at or under this ceiling; it sits ~10% below the nginx cap to leave
 * headroom for multipart framing (per-part headers + boundaries).
 *
 * A single file larger than this ceiling is still sent — alone in its own
 * batch — so the server (the authority on per-file / per-user caps) answers
 * with its honest 413 / policy error instead of the client silently dropping
 * the file.
 *
 * Do NOT raise this toward (or past) the nginx 100M: that cap doubles as the
 * orchestrator's OOM guard — uploads are buffered in RAM by
 * `multer.memoryStorage()` inside a 768MB container (ADR-021).
 */
export const MAX_UPLOAD_BATCH_BYTES = 90 * 1024 * 1024;

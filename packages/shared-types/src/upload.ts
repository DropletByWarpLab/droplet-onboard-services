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

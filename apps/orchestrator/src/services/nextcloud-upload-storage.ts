/**
 * WARP-2093 / WARP-2096 — multer StorageEngine that streams each uploaded
 * part straight into Nextcloud's upload staging namespace, hashing it on the
 * way through.
 *
 * Replaces `multer.memoryStorage()` on POST /files/upload. Nothing is held
 * in orchestrator memory beyond stream buffers: busboy's part stream →
 * a SHA-256/byte-count Transform → a streamed WebDAV PUT, with backpressure
 * end to end. multer stays in front for its limits and error codes
 * (LIMIT_FILE_SIZE / LIMIT_FILE_COUNT / LIMIT_UNEXPECTED_FILE) and its
 * client-abort handling; only where the bytes go changed.
 *
 * A staged upload is NOT in the user's tree. The route commits it (MOVE)
 * only after multer has parsed the whole body cleanly; on any multer error
 * — over-cap part, too many files, client abort — multer calls
 * `_removeFile` for every staged part and this engine discards them, so a
 * failed request leaves nothing behind and no half-sent file can ever read
 * as complete.
 */
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import type { StorageEngine } from "multer";
import { ncDiscardUpload, ncStageUpload } from "./nextcloud.client.js";

/** What the engine adds to each `req.files` entry. */
export interface StagedUploadInfo {
  uploadId: string;
  /** Hex SHA-256 of exactly the bytes staged. */
  sha256: string;
  size: number;
}

export function nextcloudUploadStorage(token: string, user: string): StorageEngine {
  return {
    _handleFile(_req, file, cb) {
      const uploadId = `droplet-${randomUUID()}`;
      const source = file.stream as Readable & { truncated?: boolean };
      const hash = createHash("sha256");
      let size = 0;

      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
        // busboy ENDS an over-cap part cleanly (it just stops emitting data
        // and sets `truncated`). Ending the PUT cleanly there would stage a
        // truncated file, so a truncated source fails the stream instead.
        flush(done) {
          done(source.truncated ? new Error("upload part truncated at the size cap") : null);
        },
      });

      // Fail fast on the cap rather than waiting out the rest of the part.
      // The SOURCE is never destroyed — busboy owns it and a destroyed part
      // stream would stall the parser — it is unpiped and drained instead.
      const fail = (err: Error) => {
        source.unpipe(meter);
        source.resume();
        meter.destroy(err);
      };
      source.on("limit", () => fail(new Error("upload part exceeded the size cap")));
      source.on("error", fail);
      source.pipe(meter);

      ncStageUpload(token, user, uploadId, meter).then(
        () => {
          const info: StagedUploadInfo = { uploadId, sha256: hash.digest("hex"), size };
          // multer's callback is typed for its own File fields; it merges
          // whatever the engine returns into the `req.files` entry.
          cb(null, info as unknown as Partial<Express.Multer.File>);
        },
        async (err: unknown) => {
          await ncDiscardUpload(token, user, uploadId);
          cb(err instanceof Error ? err : new Error(String(err)));
        },
      );
    },

    _removeFile(_req, file, cb) {
      const uploadId = (file as Partial<StagedUploadInfo>).uploadId;
      if (!uploadId) {
        cb(null);
        return;
      }
      void ncDiscardUpload(token, user, uploadId).then(() => cb(null));
    },
  };
}

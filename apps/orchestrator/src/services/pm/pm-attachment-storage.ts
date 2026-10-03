/**
 * WARP-1505 — where attachment BYTES live, and how they get there.
 *
 * One orchestrator-owned volume (`pm-attachments`, ADR-026), mounted at
 * `config.PM_ATTACHMENTS_DIR`. A blob is `<root>/<first two key chars>/<key>`
 * where `key` is the row's `storageKey` — a random uuid. The user's file name
 * never touches the file system, so there is no name to traverse with: the
 * traversal defence is that the only string ever joined onto `root` is a key
 * that matches `STORAGE_KEY` below, and `blobPath` throws on anything else.
 *
 * `createAttachmentStorage` is the multer `StorageEngine` for the upload route —
 * the same library, and the same streaming shape, as `nextcloud-upload-storage`
 * (WARP-2093): busboy's part stream → a hashing/counting Transform → disk, with
 * backpressure end to end and nothing buffered beyond stream buffers. multer
 * stays in front for its limits and error codes (LIMIT_FILE_SIZE & friends);
 * only where the bytes go is ours. The size cap is therefore enforced WHILE
 * streaming: the moment busboy reports the part passed `limits.fileSize` the
 * engine fails the upload and removes what it had written.
 *
 * Durability: a READY row is a promise that a download will work, and these
 * boxes do lose power. Before the engine reports success the file is fsync'd
 * (and, where the platform allows it, so is its directory), so a power cut after
 * "uploaded" cannot leave a READY row pointing at an empty file.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import type { StorageEngine } from "multer";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { SNIFF_BYTES } from "./pm-attachment-content.js";

const logger = createLogger("pm-attachments");

/** `storageKey` is always a `randomUUID()`. Matching it exactly is the guard. */
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Is `storageKey` one this store could have minted (a lower-case uuid)? */
export function isStorageKey(storageKey: string): boolean {
  return STORAGE_KEY.test(storageKey);
}

/**
 * The path of one blob. THROWS on a key that is not a lower-case uuid — a
 * traversal attempt, a corrupted row, or a caller bug — instead of joining it.
 */
export function blobPath(root: string, storageKey: string): string {
  if (!isStorageKey(storageKey)) throw new Error("invalid_storage_key");
  return join(root, storageKey.slice(0, 2), storageKey);
}

/** What the engine adds to the multer file (`req.file`). */
export interface StoredAttachmentFile {
  /** Exactly the bytes written. */
  size: number;
  /** Lower-case hex SHA-256 of exactly those bytes. */
  sha256: string;
  /** The first `SNIFF_BYTES` of the file, for the content policy. */
  head: Buffer;
}

/** Remove one blob. Resolves when it is gone, including when it never was. */
export async function removeBlob(root: string, storageKey: string): Promise<void> {
  await rm(blobPath(root, storageKey), { force: true });
}

/**
 * Remove a set of blobs AFTER the database has already let go of their rows
 * (work-item and project hard delete). Never throws: the rows are gone, the
 * caller's delete succeeded, and a file that would not unlink is a disk problem
 * to log loudly, not a reason to tell the user their delete failed.
 *
 * A key this store never minted (a row from before the volume existed, or a
 * corrupted one) has no blob to remove, and is never joined onto the root: it is
 * skipped with a warning, not counted as a failure.
 */
export async function removeAttachmentBlobs(
  storageKeys: readonly string[],
  root: string = config.PM_ATTACHMENTS_DIR,
): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  for (const key of storageKeys) {
    if (!isStorageKey(key)) {
      logger.warn({ storageKey: key }, "attachment row has a storage key this store never minted; nothing to remove");
      continue;
    }
    try {
      await removeBlob(root, key);
      removed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ err, storageKey: key }, "pm attachment blob could not be removed after its row was deleted");
    }
  }
  return { removed, failed };
}

/** fsync a file by path. A failure here is a failed upload: the bytes may not be
 *  on the platter, so the row must not claim they are. */
async function syncFile(path: string): Promise<void> {
  // "r+" rather than "r": Windows refuses to flush a read-only handle.
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync a directory so the new entry survives a power cut. Best effort: not
 *  every platform lets you open a directory (Windows does not), and the file's
 *  own data is already synced. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* unsupported here — nothing further to do */
  }
}

/**
 * The multer storage engine for ONE upload, bound to the `storageKey` the route
 * minted for it. Accepts a single part (the route sets `limits.files = 1`).
 */
export function createAttachmentStorage(root: string, storageKey: string): StorageEngine {
  return {
    _handleFile(_req, file, cb) {
      // busboy's part stream, with the `truncated` flag it sets at the size cap.
      const source = file.stream as Readable & { truncated?: boolean };

      let dest: string;
      try {
        dest = blobPath(root, storageKey);
      } catch (err) {
        // Not a key we minted: nothing was written, so nothing to clean up.
        source.resume();
        cb(err);
        return;
      }

      const hash = createHash("sha256");
      const head: Buffer[] = [];
      let headLength = 0;
      let size = 0;

      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          if (headLength < SNIFF_BYTES) {
            const keep = chunk.subarray(0, SNIFF_BYTES - headLength);
            head.push(keep);
            headLength += keep.length;
          }
          done(null, chunk);
        },
        // busboy ENDS an over-cap part cleanly (it stops emitting data and sets
        // `truncated`). Finishing the write there would store a truncated file
        // as if it were whole, so a truncated source fails the stream instead.
        flush(done) {
          done(source.truncated ? new Error("upload part truncated at the size cap") : null);
        },
      });

      let out: Writable | undefined;
      // True once WE created the file ("wx" opened it). A failure before that —
      // the open itself, e.g. EEXIST — must not delete a file that is not ours.
      let created = false;
      let settled = false;

      /** First outcome wins; everything after it is ignored. */
      const settle = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        if (err === null) {
          const info: StoredAttachmentFile = { size, sha256: hash.digest("hex"), head: Buffer.concat(head) };
          // multer's callback is typed for its own File fields; it merges
          // whatever the engine returns into `req.file`.
          cb(null, info as unknown as Partial<Express.Multer.File>);
          return;
        }
        // The SOURCE is busboy's: it is never destroyed (a destroyed part stream
        // stalls the parser). It is unpiped and drained so the parse can finish.
        source.unpipe(meter);
        source.resume();
        meter.destroy();
        const cleanUp = (): void => {
          if (!created) {
            cb(err);
            return;
          }
          // Whatever was written is not an upload. Remove it, THEN report, so a
          // caller that sees the error never races a half-file.
          void rm(dest, { force: true })
            .catch((rmErr: unknown) => logger.warn({ err: rmErr, storageKey }, "partial attachment blob not removed"))
            .finally(() => cb(err));
        };
        if (out && !out.destroyed) {
          out.once("close", cleanUp);
          out.destroy();
        } else {
          cleanUp();
        }
      };

      // Registered before anything async: the part stream is paused until piped,
      // but a failure must never find the engine without a listener.
      source.on("limit", () => settle(new Error("upload part exceeded the size cap")));
      source.on("error", (err: Error) => settle(err));
      // busboy tearing the part down WITHOUT an error (the client went away, the
      // parser was destroyed) ends in 'close' with the part unfinished — the one
      // terminal event neither listener above sees. A part that ended normally
      // is `readableEnded` by the time it closes, so it is not mistaken for this.
      source.on("close", () => {
        if (!source.readableEnded) settle(new Error("upload part closed before it ended"));
      });

      mkdir(dirname(dest), { recursive: true, mode: 0o700 }).then(
        () => {
          if (settled) return;
          // "wx": never overwrite — a key collision (impossible for a uuid) fails loudly.
          const stream = createWriteStream(dest, { flags: "wx", mode: 0o600 });
          out = stream;
          stream.on("open", () => {
            created = true;
          });
          stream.on("error", (err: Error) => settle(err));
          meter.on("error", (err: Error) => settle(err));
          stream.on("close", () => {
            if (settled) return;
            // Written and closed: make it durable BEFORE claiming success.
            syncFile(dest)
              .then(() => syncDirectory(dirname(dest)))
              .then(
                () => settle(null),
                (err: Error) => settle(err),
              );
          });
          source.pipe(meter).pipe(stream);
        },
        (err: Error) => settle(err),
      );
    },

    _removeFile(_req, _file, cb) {
      // multer calls this for a part that COMPLETED when a later part or the
      // request itself failed. The route's own abort path also removes it, so
      // this is the belt to that pair of braces; removal is idempotent.
      removeBlob(root, storageKey).then(
        () => cb(null),
        (err: Error) => cb(err),
      );
    },
  };
}

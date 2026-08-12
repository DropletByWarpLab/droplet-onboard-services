/**
 * WARP-1876 / WARP-1506 — one upload run, shared by both surfaces that
 * have one (My Files and Company files).
 *
 * `POST /api/files/upload` writes FLAT: target directory from `?path=`,
 * basename from each part's `originalname`. It has no nested-path field and
 * neither ticket added one — so a folder tree is composed from the two
 * calls that already ship:
 *
 *   1. `POST /api/files/mkdir` per directory, shallow → deep — including the
 *      folders that hold no files, which the walk records itself because a
 *      file's parent path cannot express them. WebDAV MKCOL 409s when an
 *      intermediate collection is missing, and the server tolerates 405
 *      "already exists", so the order matters and a re-drop of the same
 *      folder is idempotent.
 *   2. `POST /api/files/upload` once per directory. Each call keeps its own
 *      batching and its own `UploadBatchError` accounting (WARP-1666 /
 *      WARP-1843); this sums them so a run spanning several directories
 *      still reports honest totals.
 *
 * Nothing here decides copy or touches component state — see
 * `lib/upload-feedback.ts` for the message and the callers for the UI.
 */
import { createDirectory, uploadFiles, UploadBatchError } from "./api";
import {
  groupByDirectory,
  requiredDirectories,
  type DroppedSelection,
} from "@/components/FileManager/dropped-entries";
import type { FileSpaceId } from "./types";

export interface UploadRunOptions {
  /** Space-relative directory the drop landed on ("/" at a space root). */
  basePath: string;
  space: FileSpaceId;
  /** 0-100 across the WHOLE run, byte-weighted — never per group. */
  onProgress?: (percent: number) => void;
}

export interface UploadRunResult {
  uploaded: number;
  /**
   * Everything the drop was supposed to put on the box — the files that
   * reached an upload call PLUS the ones the walk could not read. A run that
   * reports 188 of 188 for a 200-document folder is the silent partial
   * migration this count exists to prevent (WARP-1876 review).
   */
  total: number;
  /** Of `total`, how many never reached an upload call at all. */
  skipped: number;
  /** First underlying failure, already unwrapped from `UploadBatchError`. */
  cause: unknown;
  /** Directories the run had to create — drives the progress copy. */
  directoryCount: number;
}

/** Join a dropped folder's relative directory onto the target path. */
export function joinRelativePath(base: string, rel: string): string {
  if (!rel) return base;
  return base === "/" ? `/${rel}` : `${base}/${rel}`;
}

export async function runUpload(
  selection: DroppedSelection,
  { basePath, space, onProgress }: UploadRunOptions,
): Promise<UploadRunResult> {
  const { uploads, directories, skipped } = selection;
  // Files the walk never got hold of are part of the total, not rounded out
  // of it — see UploadRunResult.total.
  const total = uploads.length + skipped;
  const dirs = requiredDirectories(uploads, directories);
  const groups = groupByDirectory(uploads);

  const totalBytes = uploads.reduce((sum, u) => sum + u.file.size, 0);
  let sentBytes = 0;
  let uploaded = 0;
  let cause: unknown;
  const noteFailure = (err: unknown) => {
    if (cause === undefined) {
      cause = err instanceof UploadBatchError ? err.cause : err;
    }
  };

  // A directory that fails to create is NOT fatal to the run — only its own
  // group can't land, and that group reports itself below.
  for (const dir of dirs) {
    try {
      await createDirectory(joinRelativePath(basePath, dir), space);
    } catch (err) {
      console.error("upload: mkdir failed", dir, err);
      noteFailure(err);
    }
  }

  for (const group of groups) {
    const groupBytes = group.files.reduce((sum, f) => sum + f.size, 0);
    const before = sentBytes;
    try {
      await uploadFiles(
        joinRelativePath(basePath, group.dir),
        group.files,
        onProgress &&
          ((percent) => {
            const done = before + (percent / 100) * groupBytes;
            onProgress(
              totalBytes > 0 ? Math.min(100, Math.round((done / totalBytes) * 100)) : 100,
            );
          }),
        space,
      );
      uploaded += group.files.length;
    } catch (err) {
      // A failed group still uploaded whatever its own batches got through
      // — count those, don't write them off.
      if (err instanceof UploadBatchError) uploaded += err.uploaded;
      console.error("partial upload", group.dir, err);
      noteFailure(err);
    }
    sentBytes += groupBytes;
  }

  return { uploaded, total, skipped, cause, directoryCount: dirs.length };
}

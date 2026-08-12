/**
 * WARP-1876 / WARP-1506 — one place that decides what an upload run says
 * when it is over.
 *
 * WARP-1666 established the posture and WARP-1843 sharpened it: a batch
 * that fails partway leaves the earlier batches ON the box, so the user is
 * told exactly how many landed and how many didn't — counts composed from
 * the typed `UploadBatchError`, never echoed out of a raw server message
 * (`translateError`'s no-echo rule).
 *
 * It lives here because there is now a SECOND upload surface (Company
 * files, WARP-1506). Two copies of this branch would drift, and the one
 * that drifted would be the one nobody had a test for.
 */
import { translateError } from "./friendly-errors";

/**
 * Copy for a finished upload run.
 *
 * @param uploaded how many files actually landed
 * @param total    how many were selected/dropped, INCLUDING the ones the
 *                 walk never got hold of
 * @param cause    the first underlying failure (already unwrapped from
 *                 `UploadBatchError` by the caller)
 * @param skipped  of `total`, how many never reached an upload call
 * @returns the message to toast, or `null` when everything landed
 */
export function uploadOutcomeMessage(
  uploaded: number,
  total: number,
  cause: unknown,
  skipped = 0,
): string | null {
  // Files an upload call actually lost, as opposed to ones the browser never
  // handed over — the two have different sentences and different remedies.
  const failed = Math.max(0, total - uploaded - skipped);
  if (failed === 0 && skipped === 0) return null;

  // WARP-1876 review: an unreadable file (an online-only OneDrive/iCloud
  // placeholder is the usual one) used to fall out of the totals entirely,
  // so a 200-document migration that moved 188 reported success. It gets its
  // own sentence — the remedy is "make them available offline", not "retry".
  const unread =
    skipped === 0
      ? ""
      : skipped === 1
        ? " 1 item couldn't be read and wasn't uploaded."
        : ` ${skipped} items couldn't be read and weren't uploaded.`;

  // Nothing landed — there is no partial success to report, so fall back
  // to the domain translator's fixed copy.
  if (uploaded === 0) {
    return failed > 0 ? `${translateError(cause, "files")}${unread}` : unread.trim();
  }
  if (failed === 0) return `Uploaded ${uploaded} of ${total} files.${unread}`;
  return `Uploaded ${uploaded} of ${total} files. ${failed} didn't upload — try again to finish.${unread}`;
}

/**
 * Copy for a drop that carried folders but no files at all.
 *
 * The folders are still created — an empty folder is part of the tree the
 * user dragged — so the run has something true to report. Saying nothing
 * reads as "the app ignored me", which is what a zero-file drop used to do
 * (WARP-1876 review).
 */
export function folderOnlyOutcomeMessage(folderCount: number, cause: unknown): string {
  if (cause !== undefined) return translateError(cause, "files");
  const folders = `${folderCount} folder${folderCount === 1 ? "" : "s"}`;
  return `Created ${folders}. There were no files in ${
    folderCount === 1 ? "it" : "them"
  } to upload.`;
}

/** Status line while a run is in flight. `folderCount` is the number of
 *  directories the run has to create first (0 for a flat selection). */
export function uploadProgressLabel(total: number, folderCount: number): string {
  const files = `${total} file${total === 1 ? "" : "s"}`;
  if (folderCount === 0) return `Uploading ${files}...`;
  // A folder tree with nothing in it is still a tree to create.
  if (total === 0) return `Creating ${folderCount} folder${folderCount === 1 ? "" : "s"}...`;
  return `Uploading ${files} into ${folderCount} folder${folderCount === 1 ? "" : "s"}...`;
}

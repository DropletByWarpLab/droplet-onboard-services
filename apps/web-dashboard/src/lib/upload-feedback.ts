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
 * @param total    how many were selected/dropped
 * @param cause    the first underlying failure (already unwrapped from
 *                 `UploadBatchError` by the caller)
 * @returns the message to toast, or `null` when everything landed
 */
export function uploadOutcomeMessage(
  uploaded: number,
  total: number,
  cause: unknown,
): string | null {
  if (uploaded >= total) return null;
  // Nothing landed — there is no partial success to report, so fall back
  // to the domain translator's fixed copy.
  if (uploaded === 0) return translateError(cause, "files");
  const missed = total - uploaded;
  return `Uploaded ${uploaded} of ${total} files. ${missed} didn't upload — try again to finish.`;
}

/** Status line while a run is in flight. `folderCount` is the number of
 *  directories the run has to create first (0 for a flat selection). */
export function uploadProgressLabel(total: number, folderCount: number): string {
  const files = `${total} file${total === 1 ? "" : "s"}`;
  if (folderCount === 0) return `Uploading ${files}...`;
  return `Uploading ${files} into ${folderCount} folder${folderCount === 1 ? "" : "s"}...`;
}

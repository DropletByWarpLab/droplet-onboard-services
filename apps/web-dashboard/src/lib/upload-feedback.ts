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
 * WARP-1912 — was this failure "the file can never fit"?
 *
 * Both size gates in front of an upload answer 413: nginx's
 * `client_max_body_size 100M` (HTML body, no code) and the orchestrator's
 * per-user multer cap (JSON body with the stable `UPLOAD_TOO_LARGE` wire
 * code plus the ACTUAL applied `limitMb`). `uploadBatch` puts those fields
 * on the error (see `uploadRejectionError` in lib/api.ts); classifying here
 * lets the copy below say "too large (max X MB)" instead of advising a
 * retry that cannot help — the QA-reported .dmg toast.
 */
function tooLargeRejection(cause: unknown): { limitMb?: number } | null {
  if (!cause || typeof cause !== "object") return null;
  const c = cause as { status?: unknown; code?: unknown; limitMb?: unknown };
  if (c.status !== 413 && c.code !== "UPLOAD_TOO_LARGE") return null;
  return { limitMb: typeof c.limitMb === "number" ? c.limitMb : undefined };
}

/**
 * Copy for a finished upload run.
 *
 * @param uploaded how many files actually landed
 * @param total    how many were selected/dropped, INCLUDING the ones the
 *                 walk never got hold of
 * @param cause    the first underlying failure (already unwrapped from
 *                 `UploadBatchError` by the caller)
 * @param skipped  of `total`, how many never reached an upload call
 * @param directoriesFailed how many mkdir calls the run lost — see the
 *                 `lostFolders` clause below for why files alone can't
 *                 stand in for this
 * @returns the message to toast, or `null` when the whole drop landed
 */
export function uploadOutcomeMessage(
  uploaded: number,
  total: number,
  cause: unknown,
  skipped = 0,
  directoriesFailed = 0,
): string | null {
  // Files an upload call actually lost, as opposed to ones the browser never
  // handed over — the two have different sentences and different remedies.
  const failed = Math.max(0, total - uploaded - skipped);
  if (failed === 0 && skipped === 0 && directoriesFailed === 0) return null;

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

  // WARP-1876 review round 2: a LEAF folder holding no files is the one
  // piece of a dropped tree that can fail with every file still landing.
  // A folder that HAS files fails loudly — the PUT into the missing
  // collection 409s and the per-group accounting above catches it — but an
  // empty one has no upload call to notice, and `total` counts files only.
  // So `Clients/` arrived a folder short and the run returned `null`.
  const lostFolders =
    directoriesFailed === 0
      ? ""
      : directoriesFailed === 1
        ? " 1 folder couldn't be created — try again to add it."
        : ` ${directoriesFailed} folders couldn't be created — try again to add them.`;

  // WARP-1912 — a too-large rejection gets its own sentence in both
  // branches below: "try again" (and the generic retry fallback) is the one
  // remedy guaranteed never to work for a file over the cap. The number is
  // the server's own `limitMb` (the applied per-user cap), never parsed out
  // of its prose; a bare nginx 413 carries no number and the copy stays
  // honest without one.
  const tooLarge = failed > 0 ? tooLargeRejection(cause) : null;
  const cap =
    tooLarge?.limitMb !== undefined ? ` (max ${tooLarge.limitMb} MB)` : "";

  // Nothing landed — there is no partial success to report, so fall back
  // to the domain translator's fixed copy. Folders get their own count
  // rather than the translator's generic line: "3 folders couldn't be
  // created" is both truer and more actionable than "we couldn't reach
  // your files", and it still never echoes the server.
  if (uploaded === 0) {
    const lead = tooLarge
      ? failed === 1
        ? `That file is too large to upload${cap}.`
        : `Those files are too large to upload${cap}.`
      : failed > 0
        ? translateError(cause, "files")
        : "";
    return `${lead}${unread}${lostFolders}`.trim();
  }
  if (failed === 0) return `Uploaded ${uploaded} of ${total} files.${unread}${lostFolders}`;
  if (tooLarge) {
    return `Uploaded ${uploaded} of ${total} files. ${failed} ${
      failed === 1 ? "was" : "were"
    } too large to upload${cap}.${unread}${lostFolders}`;
  }
  return `Uploaded ${uploaded} of ${total} files. ${failed} didn't upload — try again to finish.${unread}${lostFolders}`;
}

/**
 * Copy for a drop that carried folders but no files at all.
 *
 * The folders are still created — an empty folder is part of the tree the
 * user dragged — so the run has something true to report. Saying nothing
 * reads as "the app ignored me", which is what a zero-file drop used to do
 * (WARP-1876 review).
 *
 * Only the all-succeeded case reaches here: any lost folder now makes
 * `uploadOutcomeMessage` non-null via `directoriesFailed`, so this never
 * has to guess a failure it cannot count.
 */
export function folderOnlyOutcomeMessage(folderCount: number): string {
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

/**
 * WARP-3538 / ADR-041 §4 — sealing the human-readable columns of the landed
 * Microsoft 365 drive metadata.
 *
 * `M365DriveItem` and `M365SharePointLibrary` hold METADATA about a person's
 * files, and the metadata is itself sensitive: a file name in a practice
 * routinely carries a patient's name, and a library name can carry a matter.
 * ADR-041 §4 requires synced content be encrypted at rest. WARP-2549's narrow
 * reading would have let this table be plaintext — it makes no encryption
 * promise to break, unlike `ErpEntityCache` — but a table that claims only what
 * it implements should implement the stronger thing when the data warrants it.
 *
 * Three choices, each mirroring `token-cache.ts`:
 *
 *   - **Its own derived key** (`deriveM365DriveMetadataKey`): not the token-cache
 *     key, so a compromise of one does not open the other.
 *   - **AAD-bound to the row AND the column.** The person, the drive, the item
 *     (or library) and which column it is are all authenticated, so a blob that
 *     ends up on the wrong row, under the wrong person, or in the wrong column
 *     of the right row FAILS TO DECRYPT instead of quietly showing one person
 *     another person's file name — or a file's name where its link belongs.
 *   - **The AAD is an unambiguous encoding of the tuple**, not the ids joined
 *     with a delimiter. Ids come out of Microsoft's response bodies and may
 *     contain any character a delimiter could be; with a join, `a:b` + `c` and
 *     `a` + `b:c` would produce the same AAD and one row's blob would open as
 *     another's.
 *
 * Only the human-readable columns are sealed. Ids, the folder flag, MIME type,
 * size and timestamps stay clear on purpose: the table is filtered, ordered and
 * swept by them, and none of them names anything.
 *
 * Nothing here logs. Callers must never put a plaintext name in a log line.
 */
import {
  decryptColumn,
  deriveM365DriveMetadataKey,
  encryptColumn,
} from "../column-crypto.service.js";

/** The sealed columns of `M365DriveItem`. */
export type DriveItemColumn = "name" | "webUrl" | "lastModifiedBy";

/** The sealed columns of `M365SharePointLibrary`. */
export type LibraryColumn = "siteName" | "libraryName" | "webUrl";

// A different first element per table, so a blob moved from one table to the
// other fails even when every other part of the tuple matches.
function driveItemAad(userId: string, driveId: string, itemId: string, column: DriveItemColumn): string {
  return JSON.stringify(["m365-drive-item", userId, driveId, itemId, column]);
}

function libraryAad(userId: string, driveId: string, column: LibraryColumn): string {
  return JSON.stringify(["m365-sharepoint-library", userId, driveId, column]);
}

/** Seal one column of a drive item for `M365DriveItem`. Returns an opaque `dcv1:` blob. */
export function sealDriveItemField(
  userId: string,
  driveId: string,
  itemId: string,
  column: DriveItemColumn,
  plaintext: string,
): string {
  return encryptColumn(deriveM365DriveMetadataKey(), plaintext, driveItemAad(userId, driveId, itemId, column));
}

/**
 * Open one column of a drive item. Throws for another person's row, another
 * drive, another item, another column, a tampered blob, or a rotated
 * DEVICE_SECRET_KEY — callers treat a throw as "this row cannot be read", never
 * as a reason to show something else.
 */
export function unsealDriveItemField(
  userId: string,
  driveId: string,
  itemId: string,
  column: DriveItemColumn,
  blob: string,
): string {
  return decryptColumn(deriveM365DriveMetadataKey(), blob, driveItemAad(userId, driveId, itemId, column));
}

/** Seal one column of a discovered library for `M365SharePointLibrary`. */
export function sealLibraryField(
  userId: string,
  driveId: string,
  column: LibraryColumn,
  plaintext: string,
): string {
  return encryptColumn(deriveM365DriveMetadataKey(), plaintext, libraryAad(userId, driveId, column));
}

/** Open one column of a discovered library. Throws on the same conditions as {@link unsealDriveItemField}. */
export function unsealLibraryField(
  userId: string,
  driveId: string,
  column: LibraryColumn,
  blob: string,
): string {
  return decryptColumn(deriveM365DriveMetadataKey(), blob, libraryAad(userId, driveId, column));
}

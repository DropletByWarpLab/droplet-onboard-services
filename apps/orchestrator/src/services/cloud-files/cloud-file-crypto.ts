/**
 * WARP-3538 / ADR-041 §4 — sealing the human-readable columns of the landed
 * cloud-file metadata.
 *
 * `CloudFileItem` and `CloudFileSource` hold METADATA about a person's files, and
 * the metadata is itself sensitive: a file name in a practice routinely carries a
 * patient's name, and a library name can carry a matter. ADR-041 §4 requires
 * synced content be encrypted at rest. WARP-2549's narrow reading would have let
 * these tables be plaintext — they make no encryption promise to break, unlike
 * `ErpEntityCache` — but a table that claims only what it implements should
 * implement the stronger thing when the data warrants it.
 *
 * Provider-agnostic on purpose (D13): one key for every cloud the store holds
 * (Microsoft 365 today, Google Drive and Dropbox next), with the provider bound
 * into the AAD below. Each of the other choices mirrors `token-cache.ts`:
 *
 *   - **Its own derived key** (`deriveCloudFileMetadataKey`): not the token-cache
 *     key, so a compromise of one does not open the other.
 *   - **AAD-bound to the row AND the column.** The provider, the person, the
 *     source, the item (where there is one) and which column it is are all
 *     authenticated, so a blob that ends up on the wrong row, under the wrong
 *     person, under the wrong provider, or in the wrong column of the right row
 *     FAILS TO DECRYPT instead of quietly showing one person another person's
 *     file name — or a file's name where its link belongs.
 *   - **The AAD is an unambiguous encoding of the tuple**, not the ids joined
 *     with a delimiter. Ids come out of a provider's response bodies and may
 *     contain any character a delimiter could be; with a join, `a:b` + `c` and
 *     `a` + `b:c` would produce the same AAD and one row's blob would open as
 *     another's. A JSON array of strings cannot collide that way: every element
 *     is quoted and escaped.
 *   - **The first element says which TABLE the blob belongs to.** Items and
 *     sources share column names (`name`, `webUrl`), and an item's `externalId`
 *     is provider-chosen text: with no discriminator, an item whose id happened
 *     to be the word a source tuple uses for "no item" would collide with the
 *     source row beside it.
 *
 * Only the human-readable columns are sealed. Ids, the folder flag, MIME type,
 * size and timestamps stay clear on purpose: the tables are filtered, ordered and
 * swept by them, and none of them names anything.
 *
 * Nothing here logs. Callers must never put a plaintext name in a log line.
 */
import type { CloudFileProvider } from "@prisma/client";

import {
  decryptColumn,
  deriveCloudFileMetadataKey,
  encryptColumn,
} from "../column-crypto.service.js";

/** The sealed columns of `CloudFileItem`. */
export type CloudFileItemColumn = "name" | "webUrl" | "lastModifiedBy";

/** The sealed columns of `CloudFileSource`. */
export type CloudFileSourceColumn = "siteName" | "name" | "webUrl";

/** Which `CloudFileItem` a blob belongs to — the whole of its identity. */
export interface CloudFileItemRef {
  readonly provider: CloudFileProvider;
  readonly userId: string;
  readonly sourceId: string;
  readonly externalId: string;
}

/** Which `CloudFileSource` a blob belongs to. */
export interface CloudFileSourceRef {
  readonly provider: CloudFileProvider;
  readonly userId: string;
  readonly sourceId: string;
}

function itemAad(ref: CloudFileItemRef, column: CloudFileItemColumn): string {
  return JSON.stringify(["cloud-file-item", ref.provider, ref.userId, ref.sourceId, ref.externalId, column]);
}

function sourceAad(ref: CloudFileSourceRef, column: CloudFileSourceColumn): string {
  return JSON.stringify(["cloud-file-source", ref.provider, ref.userId, ref.sourceId, column]);
}

/**
 * The sealing and opening operations, bound to ONE derived key.
 *
 * `deriveCloudFileMetadataKey()` is an HKDF each time it is called. That is
 * nothing beside a database write, but a search opens up to
 * `MAX_SEARCH_CANDIDATES` rows × three columns, and re-deriving per blob would
 * be most of its CPU. Bind once per search or per page; the module-level
 * functions below bind per call, which is the right default for everything else.
 *
 * Opening throws for another person's row, another provider, another source,
 * another item, another column, a tampered blob, or a rotated DEVICE_SECRET_KEY —
 * callers treat a throw as "this row cannot be read", never as a reason to show
 * something else.
 */
export interface CloudFileCrypto {
  sealItem(ref: CloudFileItemRef, column: CloudFileItemColumn, plaintext: string): string;
  openItem(ref: CloudFileItemRef, column: CloudFileItemColumn, blob: string): string;
  sealSource(ref: CloudFileSourceRef, column: CloudFileSourceColumn, plaintext: string): string;
  openSource(ref: CloudFileSourceRef, column: CloudFileSourceColumn, blob: string): string;
}

/** Bind the sealing and opening operations to the key as it is right now. */
export function cloudFileCrypto(): CloudFileCrypto {
  const key = deriveCloudFileMetadataKey();
  return {
    sealItem: (ref, column, plaintext) => encryptColumn(key, plaintext, itemAad(ref, column)),
    openItem: (ref, column, blob) => decryptColumn(key, blob, itemAad(ref, column)),
    sealSource: (ref, column, plaintext) => encryptColumn(key, plaintext, sourceAad(ref, column)),
    openSource: (ref, column, blob) => decryptColumn(key, blob, sourceAad(ref, column)),
  };
}

/** Seal one column of an item for `CloudFileItem`. Returns an opaque `dcv1:` blob. */
export function sealItemField(
  ref: CloudFileItemRef,
  column: CloudFileItemColumn,
  plaintext: string,
): string {
  return cloudFileCrypto().sealItem(ref, column, plaintext);
}

/** Open one column of an item. Throws on every mismatch — see {@link CloudFileCrypto}. */
export function unsealItemField(
  ref: CloudFileItemRef,
  column: CloudFileItemColumn,
  blob: string,
): string {
  return cloudFileCrypto().openItem(ref, column, blob);
}

/** Seal one column of a source for `CloudFileSource`. */
export function sealSourceField(
  ref: CloudFileSourceRef,
  column: CloudFileSourceColumn,
  plaintext: string,
): string {
  return cloudFileCrypto().sealSource(ref, column, plaintext);
}

/** Open one column of a source. Throws on the same conditions as {@link unsealItemField}. */
export function unsealSourceField(
  ref: CloudFileSourceRef,
  column: CloudFileSourceColumn,
  blob: string,
): string {
  return cloudFileCrypto().openSource(ref, column, blob);
}

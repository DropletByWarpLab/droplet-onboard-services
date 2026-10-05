/**
 * WARP-3538 / ADR-041 §4 — deleting what the Microsoft 365 sync engine landed.
 *
 * The cloud-file store holds copies of a person's file lists, and ADR-041 §4 is
 * explicit that "deletion is a real operation". The store itself
 * (`cloud-files/cloud-file-store.service.ts`) knows how to delete items and
 * sources; this module is the Microsoft 365 side of that, because only Microsoft
 * 365 knows which CURSORS read them. Rows leave in three ways, each a promise
 * made to a person:
 *
 *   - **Switching SharePoint off** ({@link purgeSharePointDataForUser}):
 *     "Droplet deletes the list of SharePoint files it kept and stops reading
 *     them". SharePoint's cursors, sources and items — and NOT OneDrive's, which
 *     the confirmation dialog never mentioned.
 *   - **A COMPLETE discovery** ({@link pruneSharePointLibraries}): libraries the
 *     person can no longer open, with the cursor that read them and what it
 *     landed. Only after a complete walk — see `discoverSharePointLibraries`.
 *   - **Disconnect and a leaver's deletion** ({@link purgeM365FileDataForUser}):
 *     everything the person has landed from Microsoft 365.
 *
 * ## Which libraries a person has — the union of two lists
 *
 * A library is READ because it has a cursor and SHOWN because it has a source
 * row, and a crash between the two writes of a discovery can leave one without
 * the other. Removing "the libraries" therefore starts from the UNION of the
 * `sharepoint` cursors' resource ids and the SHAREPOINT_LIBRARY sources' ids: a
 * library with a cursor and no row would otherwise be read, landed and never
 * removed, and a row with no cursor would linger as a library nothing reads. The
 * landed items carry no kind of their own (the store is provider-agnostic), so
 * they are found through those ids too.
 *
 * Every filter carries `userId` — these tables have no foreign key to a user, so
 * nothing but the `where` stops a purge deleting somebody else's rows — and the
 * cloud-file filters carry the provider as well. The tests pin both.
 *
 * The database handle is typed structurally so the same functions run on the
 * client and on an interactive-transaction client: switching SharePoint off
 * deletes cursors, items and sources in ONE transaction (`PUT /m365/sharepoint`).
 */
import type { CloudFileProvider, PrismaClient } from "@prisma/client";

import {
  deleteItemsInSources,
  deleteSources,
  listSourceIds,
  purgeProviderForUser,
  type CloudFileDb,
} from "../cloud-files/cloud-file-store.service.js";

/** What these functions touch: the client, or a transaction's client. */
export type DriveDataDb = CloudFileDb & Pick<PrismaClient, "m365DeltaCursor">;

/** The `workload` value SharePoint cursors carry. */
const SHAREPOINT = "sharepoint";

/** Every Microsoft 365 file lands under this provider. */
const PROVIDER: CloudFileProvider = "M365";

/**
 * What one removal took out. `libraries` is how many DISTINCT libraries went —
 * not `sources`, which counts rows and so misses a library that had a cursor and
 * no row.
 */
export interface SharePointRemoval {
  libraries: number;
  cursors: number;
  sources: number;
  items: number;
}

/** Every library this person has: the union of what is read and what is shown. */
async function librariesOf(db: DriveDataDb, userId: string): Promise<string[]> {
  const cursors = await db.m365DeltaCursor.findMany({
    where: { userId, workload: SHAREPOINT },
    select: { resourceId: true },
  });
  const sources = await listSourceIds(db, { userId, provider: PROVIDER, kind: "SHAREPOINT_LIBRARY" });
  return [...new Set([...cursors.map((c) => c.resourceId), ...sources])];
}

/**
 * Delete these libraries: the cursor that reads each, what it landed, and the row
 * that names it. Cursors FIRST — a cursor is what makes the engine READ a
 * library, so deleting it is what makes "stops reading them" true; if a later
 * delete failed, the residue would be rows nothing refreshes, not a library still
 * being read.
 */
async function removeLibraries(
  db: DriveDataDb,
  userId: string,
  libraries: readonly string[],
  cursorWhere: { resourceId?: { in: string[] } },
): Promise<SharePointRemoval> {
  const cursors = await db.m365DeltaCursor.deleteMany({ where: { userId, workload: SHAREPOINT, ...cursorWhere } });
  const items = await deleteItemsInSources(db, { userId, provider: PROVIDER, sourceIds: libraries });
  const sources = await deleteSources(db, { userId, provider: PROVIDER, sourceIds: libraries });
  return { libraries: libraries.length, cursors: cursors.count, sources, items };
}

/**
 * Remove SharePoint — all of it, for one person — and nothing else.
 *
 * Every `sharepoint` cursor goes, not only the ones the lookup saw: a discovery
 * that was already running when the switch was thrown may create one between the
 * lookup and the delete, and "stops reading them" must not have an exception for
 * it. (Whatever it lands before the delete is removed by the next call — the sync
 * tick makes it on every discovery for a person with the switch off.)
 */
export async function purgeSharePointDataForUser(db: DriveDataDb, userId: string): Promise<SharePointRemoval> {
  return removeLibraries(db, userId, await librariesOf(db, userId), {});
}

/**
 * Remove the SharePoint libraries a person has registered that are NOT in
 * `keptDriveIds`: their cursors, their sources, and whatever was landed from
 * them.
 *
 * `workload: "sharepoint"` on the cursor filter and the library list are
 * load-bearing: OneDrive's cursor and source live in the same tables, and "a
 * library that is gone" is by definition not OneDrive.
 *
 * Does what it is told. WHETHER an answer is complete enough to prune on is the
 * caller's decision, and the caller treats a partial, failed or implausibly empty
 * listing as "prune nothing".
 */
export async function pruneSharePointLibraries(
  db: DriveDataDb,
  userId: string,
  keptDriveIds: readonly string[],
): Promise<SharePointRemoval> {
  const kept = new Set(keptDriveIds);
  const gone = (await librariesOf(db, userId)).filter((id) => !kept.has(id));
  if (gone.length === 0) return { libraries: 0, cursors: 0, sources: 0, items: 0 };
  return removeLibraries(db, userId, gone, { resourceId: { in: gone } });
}

/**
 * Remove everything a person has landed from Microsoft 365 — OneDrive's and
 * SharePoint's items, and every source. For disconnect, for a leaver's deletion
 * and for a reconnect as a different account.
 *
 * Deliberately NOT the cursors: `purgeCursorsForUser` owns those, and the
 * callers delete them first, so that if this step fails the residue is rows
 * nothing will refresh rather than a cursor still reading for a person who has
 * left. (Only Microsoft 365's rows: a person's files in another cloud are that
 * cloud's to remove.)
 */
export async function purgeM365FileDataForUser(
  db: CloudFileDb,
  userId: string,
): Promise<{ items: number; sources: number }> {
  return purgeProviderForUser(db, { userId, provider: PROVIDER });
}

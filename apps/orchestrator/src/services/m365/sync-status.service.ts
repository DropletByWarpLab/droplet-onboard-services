/**
 * WARP-3538 — what the Microsoft 365 connection is reading for a person, and how
 * far it has got: the answer behind `GET /api/m365/sync-status`.
 *
 * The card in Settings says "Droplet keeps a list of file names, folders and
 * dates" and then shows, for the person's OneDrive and for each SharePoint
 * library, how many files that is, when it was last read and whether it is
 * healthy. Three tables know three different parts of that, and this module is
 * the join:
 *
 *   - the CURSORS (`M365DeltaCursor`) know whether a thing is being read, when a
 *     read last finished and whether it is failing — one per library, one for the
 *     OneDrive, one per mail folder and so on;
 *   - the cloud-file SOURCES (`CloudFileSource`) know what a library is called:
 *     the names are sealed at rest and opened here, server-side, so the browser
 *     only ever sees text;
 *   - the landed ITEMS (`CloudFileItem`) know how many files there are.
 *
 * ## What it answers with, and what it never does
 *
 * Every read is scoped to ONE `userId` — none of these tables has a foreign key
 * to a user, so the `where` is the only thing between one person's card and
 * another's libraries — and the cloud-file reads to the Microsoft 365 provider.
 *
 * The cursor read NAMES its columns and never asks for `deltaLink` or
 * `resumeLink`: a delta link is a credential-shaped URL (replaying one reads the
 * person's files), the status has no use for it, and a value that is never
 * selected cannot be returned by a later edit to the mapping. `lastError` was
 * redacted when it was written (`recordFailure`); it goes through
 * `redactDeltaTokens` again here, because a status that reaches a browser is
 * the last place a leaked token could be stopped.
 *
 * A library is listed only when it has BOTH a source (its name) and a cursor (it
 * is being read). A source with no cursor is residue that nothing reads — it will
 * be re-registered or pruned by the next discovery — and a cursor with no source
 * is one a discovery registered a moment before it wrote the name. Listing either
 * would show a library the person cannot tell is real.
 *
 * A library whose names cannot be opened (a rotated device key; it heals at the
 * next reconnect) is still listed, under a plain placeholder and with its REAL
 * state: hiding it would hide a failing cursor, and any other name would be a
 * lie. The card needs strings, so it gets generic ones.
 *
 * While SharePoint is OFF no libraries are listed and the cap count is 0, even if
 * a race has left a row behind: the deletion converges within a tick
 * (`purgeSharePointDataForUser`), and listing a library the person has just
 * switched off would contradict the switch.
 */
import type { PrismaClient } from "@prisma/client";

import { countFilesBySource, type CloudFileDb } from "../cloud-files/cloud-file-store.service.js";
import { unsealSourceField } from "../cloud-files/cloud-file-crypto.js";
import { M365_WORKLOADS, SINGLETON_RESOURCE, redactDeltaTokens } from "./graph-resources.js";
import { sharePointViewOf, type M365SharePointView } from "./m365-auth.service.js";

/** What the status reads: the connection, the cursors, and the two cloud-file tables. */
export type SyncStatusDb = CloudFileDb & Pick<PrismaClient, "m365Connection" | "m365DeltaCursor">;

/** How one workload's cursors are doing, in total. */
export interface WorkloadStatus {
  workload: string;
  /** Every cursor of the person's in this workload, whatever its state. */
  cursors: number;
  idle: number;
  backoff: number;
  failed: number;
  /** ISO 8601 — the most recent finished read of any of them, or null if none has finished. */
  lastSyncedAt: string | null;
}

/** One place the box reads: the OneDrive, or a library. */
export interface SourceStatus {
  /** FILES only — folders are not counted. */
  files: number;
  /** ISO 8601, or null before its first complete read. */
  lastSyncedAt: string | null;
  /** The cursor's state: IDLE, SYNCING, BACKOFF, RESYNC_REQUIRED or FAILED. */
  state: string;
  /** Why it is failing, redacted; null when it is not. */
  lastError: string | null;
}

export interface LibraryStatus extends SourceStatus {
  driveId: string;
  siteName: string;
  libraryName: string;
  /** Where the library lives. For a person to follow, never for the page to put in an href. */
  webUrl: string | null;
  /** The person follows the site, as opposed to it being found by search alone. */
  followed: boolean;
}

export interface M365SyncStatus {
  workloads: WorkloadStatus[];
  /** Null until the box has registered the drive AND something reads it. */
  oneDrive: SourceStatus | null;
  sharePoint: M365SharePointView & {
    /** Libraries found beyond the per-person cap and not read. */
    capped: number;
    libraries: LibraryStatus[];
  };
}

/** What a library is called when its names cannot be opened. Plain, and obviously not a name. */
const UNKNOWN_SITE = "Unknown site";
const UNKNOWN_LIBRARY = "Library (name unavailable)";

/** Plain code-unit order, the same on every machine — unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tryOpen(open: () => string): string | null {
  try {
    return open();
  } catch {
    return null;
  }
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

export async function getSyncStatus(db: SyncStatusDb, userId: string): Promise<M365SyncStatus> {
  const connection = await db.m365Connection.findUnique({
    where: { userId },
    select: { sharePointEnabled: true, grantedScopes: true, sharePointLibrariesCapped: true },
  });
  const sharePoint = sharePointViewOf(connection?.sharePointEnabled, connection?.grantedScopes);

  // Named columns only: never the delta link, never the resume checkpoint.
  const cursors = await db.m365DeltaCursor.findMany({
    where: { userId },
    select: { workload: true, resourceId: true, state: true, lastSyncedAt: true, lastError: true },
  });

  // --- per workload ------------------------------------------------------
  const workloads: WorkloadStatus[] = [];
  for (const workload of M365_WORKLOADS) {
    const mine = cursors.filter((c) => c.workload === workload);
    if (mine.length === 0) continue;
    const times = mine.map((c) => c.lastSyncedAt).filter((t): t is Date => t !== null);
    workloads.push({
      workload,
      cursors: mine.length,
      idle: mine.filter((c) => c.state === "IDLE").length,
      backoff: mine.filter((c) => c.state === "BACKOFF").length,
      failed: mine.filter((c) => c.state === "FAILED").length,
      lastSyncedAt: times.length === 0 ? null : iso(new Date(Math.max(...times.map((t) => t.getTime())))),
    });
  }

  const sources = await db.cloudFileSource.findMany({
    where: { userId, provider: "M365" },
    select: {
      sourceId: true,
      kind: true,
      siteNameEnc: true,
      nameEnc: true,
      webUrlEnc: true,
      followed: true,
      createdAt: true,
    },
  });
  const files = await countFilesBySource(db, { userId, provider: "M365" });
  const statusOf = (
    cursor: { state: string; lastSyncedAt: Date | null; lastError: string | null },
    sourceId: string,
  ): SourceStatus => ({
    files: files.get(sourceId) ?? 0,
    lastSyncedAt: iso(cursor.lastSyncedAt),
    state: cursor.state,
    lastError: cursor.lastError === null ? null : redactDeltaTokens(cursor.lastError),
  });

  // --- OneDrive ----------------------------------------------------------
  // Its cursor's own resource is the singleton `-`, so the cursor cannot name
  // its drive: the registered ONEDRIVE source does. The newest wins should there
  // ever be two, so the answer is deterministic.
  const drive = sources
    .filter((s) => s.kind === "ONEDRIVE")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareText(a.sourceId, b.sourceId))[0];
  const driveCursor = cursors.find((c) => c.workload === "files" && c.resourceId === SINGLETON_RESOURCE);
  const oneDrive = drive && driveCursor ? statusOf(driveCursor, drive.sourceId) : null;

  // --- SharePoint libraries ----------------------------------------------
  const libraries: LibraryStatus[] = [];
  if (sharePoint.enabled) {
    const readBy = new Map(cursors.filter((c) => c.workload === "sharepoint").map((c) => [c.resourceId, c]));
    for (const source of sources) {
      const cursor = readBy.get(source.sourceId);
      if (source.kind !== "SHAREPOINT_LIBRARY" || !cursor) continue;
      const ref = { provider: "M365" as const, userId, sourceId: source.sourceId };
      libraries.push({
        driveId: source.sourceId,
        siteName:
          source.siteNameEnc === null
            ? UNKNOWN_SITE
            : (tryOpen(() => unsealSourceField(ref, "siteName", source.siteNameEnc!)) ?? UNKNOWN_SITE),
        libraryName: tryOpen(() => unsealSourceField(ref, "name", source.nameEnc)) ?? UNKNOWN_LIBRARY,
        webUrl: source.webUrlEnc === null ? null : tryOpen(() => unsealSourceField(ref, "webUrl", source.webUrlEnc!)),
        followed: source.followed,
        ...statusOf(cursor, source.sourceId),
      });
    }
    libraries.sort(
      (a, b) =>
        compareText(a.siteName.toLowerCase(), b.siteName.toLowerCase()) ||
        compareText(a.libraryName.toLowerCase(), b.libraryName.toLowerCase()) ||
        compareText(a.siteName, b.siteName) ||
        compareText(a.libraryName, b.libraryName) ||
        compareText(a.driveId, b.driveId),
    );
  }

  return {
    workloads,
    oneDrive,
    sharePoint: {
      ...sharePoint,
      capped: sharePoint.enabled ? (connection?.sharePointLibrariesCapped ?? 0) : 0,
      libraries,
    },
  };
}

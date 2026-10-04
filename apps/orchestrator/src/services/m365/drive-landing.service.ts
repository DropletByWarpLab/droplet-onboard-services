/**
 * WARP-3538 / ADR-041 §4 — landing what Microsoft's drive delta feed reports
 * into the provider-agnostic cloud-file store.
 *
 * This is the first thing the Microsoft 365 sync engine does with a page besides
 * count it. `m365-sync.service.ts` still owns WHEN and HOW a page is read (the
 * cursor, the token, the failure routing); this module owns only what one drive
 * page MEANS: a Graph `driveItem` mapped onto `CloudFileItem`, and the three
 * statements that keep the store equal to the drive — upsert, delete, and the
 * sweep of a full enumeration. Everything about storage itself (sealing, the
 * sweep's SQL, deleting a folder's subtree) is the store's
 * (`cloud-files/cloud-file-store.service.ts`) and is the same for every provider.
 *
 * It lands two workloads — `files` (the person's OneDrive) and `sharepoint` (one
 * cursor per document library) — and does NOTHING for the others: mail, calendar,
 * contacts and To Do are still counted and discarded here, which is a separate
 * decision per workload taken where its schema exists.
 *
 * METADATA ONLY, and that is an egress decision rather than a missing feature
 * (graph-resources.ts): a file's content is a 302 to a per-tenant host no
 * `allowed-egress.yaml` entry can name, so nothing here reads `downloadUrl` or
 * asks for `/content`.
 *
 * ## What the feed does and does not say (driveitem-delta, 2026-06-06)
 *
 *   - An item can arrive MORE THAN ONCE in one enumeration; the last one wins.
 *     Items are therefore upserted by id and processed in the order they arrive.
 *   - `parentReference.path` is NOT returned by delta. Items are tracked by id
 *     (`parentReference.id` is the parent's id), and a path is rebuilt from the
 *     chain at read time (cloud-file-search.service.ts).
 *   - A deleted item carries a `deleted` facet. A deleted FOLDER need not be
 *     followed by deletions of what was inside it, so deleting one removes the
 *     subtree (the store does it).
 *   - The drive root arrives with a `root` facet. It is not a file and is not
 *     stored; a top-level item's parent chain simply ends at an id with no row.
 *   - A folder's `size` is the cumulative size of its contents. Nobody asks a
 *     folder for its size, so it is not kept.
 *   - Delegated delta returns only what the signed-in person can access
 *     (scan-guidance, 2026-05-14). What lands is what they could open.
 *
 * ## Which source an item belongs to
 *
 *   - `sharepoint`: the cursor's resource id — the library's drive id.
 *   - `files`: the id of the person's OneDrive SOURCE, registered by discovery
 *     from `GET /me/drive`. The OneDrive cursor's own resource is the singleton
 *     `-`, so it cannot name the drive; and the id is read from the registered
 *     source rather than from each item's `parentReference.driveId` because the
 *     sweep needs it on pages that carry NO items — the final page of a long
 *     enumeration is often only the delta link, and a sweep that could not name
 *     its drive on that page would never run, leaving every file deleted upstream
 *     in search forever. One explicit id, from one place, for the mark, the
 *     upserts, the deletes and the sweep.
 *
 * ## The sweep
 *
 * A first sync, or a resync after Microsoft dropped the token, returns the
 * CURRENT state and says nothing about what was deleted in between. The engine
 * tells this handler when a full enumeration starts and ends
 * ({@link PageContext}); on the first page every row of the source is marked
 * "not seen yet", every item the run returns un-marks itself, and on the last
 * page the rows still marked are deleted. An incremental run never marks, so it
 * can never delete anything but what the feed said was deleted.
 */
import type { CloudFileProvider } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import {
  deleteItemTree,
  findSourceId,
  markSourceForSweep,
  sweepSource,
  upsertItem,
  type CloudFileDb,
  type CloudFileItemInput,
  type CloudFileSourceScope,
} from "../cloud-files/cloud-file-store.service.js";
import type { PageHandler } from "./m365-sync.service.js";

const logger = createLogger("m365-drive-landing");

/** Every Microsoft 365 file lands under this provider. */
const PROVIDER: CloudFileProvider = "M365";

/**
 * A `files` page arrived and this person has no OneDrive source registered, so
 * there is no drive id to land it under.
 *
 * Thrown rather than guessed around: the engine records it as a failed page
 * (retryable — `HANDLER_FAILED`), so the cursor backs off and the whole run
 * repeats from its last good position, while the next discovery tick registers
 * the source (`GET /me/drive`) and the retry succeeds. Landing under a made-up id
 * would put files where the sweep, the file count and the search cannot find
 * them.
 */
export class OneDriveSourceMissingError extends Error {
  constructor() {
    super("this person's OneDrive has not been registered yet, so its files have nowhere to land");
    this.name = "OneDriveSourceMissingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The URL, but only when it is an https URL — null otherwise.
 *
 * It ends up as a link a person clicks and a field a model reads. Microsoft
 * generates it, but a scheme that is not https (`javascript:`, `data:`, `file:`)
 * has no business being one, and refusing it here means nothing downstream has
 * to remember to.
 */
function httpsUrl(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** What one entry of a drive delta page asks for. */
export type DriveEntry =
  | { readonly kind: "deleted"; readonly externalId: string }
  | { readonly kind: "root" }
  | {
      readonly kind: "item";
      readonly externalId: string;
      readonly parentExternalId: string | null;
      readonly isFolder: boolean;
      readonly name: string;
      readonly webUrl: string | null;
      readonly lastModifiedBy: string | null;
      readonly mimeType: string | null;
      readonly sizeBytes: number | null;
      readonly remoteCreatedAt: Date | null;
      readonly remoteModifiedAt: Date | null;
    }
  | { readonly kind: "skipped"; readonly reason: "not_an_object" | "no_id" | "no_name" };

/**
 * Read one entry of a drive delta page.
 *
 * A DELETED entry is recognised by its facet before anything else and needs
 * nothing but its id: Graph often sends a deleted item with no name. The root is
 * recognised next and carries nothing worth storing. An item with no name is
 * skipped rather than stored: `nameEnc` is never null, and a nameless row would
 * be a search hit with nothing to show for itself.
 *
 * Never throws: a malformed entry is `skipped` and counted, because one odd item
 * must not fail a page of two hundred (a failed page repeats forever, and the
 * other 199 would never land).
 */
export function readDriveEntry(raw: unknown): DriveEntry {
  if (!isRecord(raw)) return { kind: "skipped", reason: "not_an_object" };
  const externalId = nonEmpty(raw.id);
  if (!externalId) return { kind: "skipped", reason: "no_id" };
  if ("deleted" in raw && raw.deleted !== undefined && raw.deleted !== null) {
    return { kind: "deleted", externalId };
  }
  if ("root" in raw && raw.root !== undefined && raw.root !== null) return { kind: "root" };
  const name = nonEmpty(raw.name);
  if (!name) return { kind: "skipped", reason: "no_name" };

  // A shortcut to a folder somebody shared (a `remoteItem` entry) is a folder to
  // the person looking at their drive, whatever facets the entry itself carries.
  const isFolder =
    isRecord(raw.folder) || (isRecord(raw.remoteItem) && isRecord(raw.remoteItem.folder));
  const file = isRecord(raw.file) ? raw.file : null;
  const parent = isRecord(raw.parentReference) ? raw.parentReference : null;
  const modifier = isRecord(raw.lastModifiedBy) ? raw.lastModifiedBy : null;
  const user = modifier && isRecord(modifier.user) ? modifier.user : null;
  const application = modifier && isRecord(modifier.application) ? modifier.application : null;

  return {
    kind: "item",
    externalId,
    parentExternalId: nonEmpty(parent?.id),
    isFolder,
    name,
    webUrl: httpsUrl(raw.webUrl),
    lastModifiedBy: nonEmpty(user?.displayName) ?? nonEmpty(application?.displayName),
    mimeType: isFolder ? null : nonEmpty(file?.mimeType),
    // A file's own size. A folder's is cumulative — see the module header.
    sizeBytes: !isFolder && typeof raw.size === "number" ? raw.size : null,
    remoteCreatedAt: dateOrNull(raw.createdDateTime),
    remoteModifiedAt: dateOrNull(raw.lastModifiedDateTime),
  };
}

/** What a log line may carry about skipped entries: how many, why — never a name. */
type SkipCounts = Partial<Record<Extract<DriveEntry, { kind: "skipped" }>["reason"], number>>;

/** Where a cursor's pages land, or `null` for a workload this module does not land. */
async function targetFor(
  db: CloudFileDb,
  cursor: { readonly userId: string; readonly workload: string; readonly resourceId: string },
): Promise<CloudFileSourceScope | null> {
  if (cursor.workload === "sharepoint") {
    return { userId: cursor.userId, provider: PROVIDER, sourceId: cursor.resourceId };
  }
  if (cursor.workload === "files") {
    const sourceId = await findSourceId(db, { userId: cursor.userId, provider: PROVIDER, kind: "ONEDRIVE" });
    if (!sourceId) throw new OneDriveSourceMissingError();
    return { userId: cursor.userId, provider: PROVIDER, sourceId };
  }
  return null;
}

/** The part of the logger this module uses — a parameter so a test can read exactly what would be logged. */
export interface LandingLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The page handler the sync engine is wired with (`m365Deps.handlePage`).
 *
 * Order within a page matters and is not incidental: the MARK comes before the
 * first upsert (a mark after it would mark the items it had just landed), the
 * SWEEP after the last (a sweep before it would delete the page's own items), and
 * entries are processed in the order Graph sent them, so an item repeated in one
 * page ends as its last mention says.
 *
 * Throws on a storage failure, deliberately: the engine treats a throwing handler
 * as a failed run and repeats it from the last good position, which is correct
 * because every statement here is idempotent. Swallowing the error would advance
 * the cursor past a page that was read and not stored.
 */
export function createDriveLandingHandler(db: CloudFileDb, log: LandingLog = logger): PageHandler {
  return async (cursor, page, run) => {
    const target = await targetFor(db, cursor);
    if (!target) return;

    if (run.fullEnumeration && run.isFirstPage) await markSourceForSweep(db, target);

    const skipped: SkipCounts = {};
    for (const raw of page.items) {
      const entry = readDriveEntry(raw);
      switch (entry.kind) {
        case "deleted":
          await deleteItemTree(db, { ...target, externalId: entry.externalId });
          break;
        case "root":
          break;
        case "skipped":
          skipped[entry.reason] = (skipped[entry.reason] ?? 0) + 1;
          break;
        case "item": {
          const { kind: _kind, ...fields } = entry;
          const input: CloudFileItemInput = { ...target, ...fields };
          await upsertItem(db, input);
          break;
        }
      }
    }

    if (run.fullEnumeration && run.isLastPage) await sweepSource(db, target);

    if (Object.keys(skipped).length > 0) {
      // Counts and reasons only: a file name in a practice carries a patient's.
      log.warn({ cursorId: cursor.id, workload: cursor.workload, skipped }, "drive page had entries that could not be landed");
    }
  };
}

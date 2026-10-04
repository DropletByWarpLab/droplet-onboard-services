/**
 * WARP-3538 / ADR-041 §4 — the provider-agnostic store a cloud connector LANDS
 * file metadata into, and what deleting it means.
 *
 * `CloudFileItem` holds one row per file or folder of a person's cloud storage;
 * `CloudFileSource` holds the containers those items sit in (a OneDrive, a
 * SharePoint library, and later a Google Drive or a Dropbox). Nothing in this
 * module knows a provider's wire format — a connector maps its own change feed
 * onto these inputs (m365/drive-landing.service.ts does it for Microsoft 365) —
 * and nothing in it knows a provider's cursors, which stay the connector's.
 *
 * ## Writing
 *
 * An item is an UPSERT keyed on (person, provider, source, the provider's own
 * item id), never an append: a change feed repeats items (Graph's documents say
 * so, and the engine itself re-runs a page after a failure), and the last one
 * seen wins. The human-readable columns are sealed on the way in
 * (cloud-file-crypto.ts); ids, flags, sizes and times stay clear because the
 * tables are filtered, ordered and swept by them.
 *
 * ## The sweep — how a full re-enumeration removes what is gone
 *
 * A change feed run from scratch (a first sync, or a resync after the provider
 * dropped its token) returns the CURRENT state and says nothing about what was
 * deleted in between. So a full enumeration is bracketed by two statements:
 * {@link markSourceForSweep} on its first page sets `sweepPending` on every row
 * of the source, every item the run then sees clears it
 * ({@link upsertItem}), and {@link sweepSource} on its last page deletes the rows
 * still marked — they were not returned, so they are gone upstream. The mark is a
 * durable column, not engine memory, because a big source takes many ticks and a
 * restart in the middle must not lose it.
 *
 * ## Deleting — every filter carries `userId`
 *
 * These tables have no foreign key to a user (like every cloud-connector table),
 * so nothing cascades and nothing but the `where` stops a purge deleting
 * somebody else's rows. EVERY statement below is scoped by `userId` and
 * `provider`; the tests pin it, because a statement that forgets either one is a
 * bug that no other test notices until it empties another person's file list.
 *
 * The database handle is typed structurally so the same functions run on the
 * client and on an interactive-transaction client — switching SharePoint off
 * deletes cursors, items and sources in ONE transaction.
 */
import type { CloudFileProvider, CloudFileSourceKind, PrismaClient } from "@prisma/client";

import { cloudFileCrypto } from "./cloud-file-crypto.js";

/** What these functions touch: the client, or a transaction's client. */
export type CloudFileDb = Pick<PrismaClient, "cloudFileItem" | "cloudFileSource">;

/** Whose files, from which cloud. Every statement in this module is scoped by both. */
export interface CloudFileOwner {
  readonly userId: string;
  readonly provider: CloudFileProvider;
}

/** One container of a person's files. */
export interface CloudFileSourceScope extends CloudFileOwner {
  readonly sourceId: string;
}

/** One file or folder. */
export interface CloudFileItemKey extends CloudFileSourceScope {
  readonly externalId: string;
}

/** What a connector hands the store for one file or folder. Plaintext — it is sealed here. */
export interface CloudFileItemInput extends CloudFileItemKey {
  readonly parentExternalId: string | null;
  readonly isFolder: boolean;
  readonly name: string;
  readonly webUrl: string | null;
  readonly lastModifiedBy: string | null;
  readonly mimeType: string | null;
  /** A FILE's size in bytes; null for a folder. Anything that is not a
   *  non-negative safe integer is stored as null rather than as a wrong number. */
  readonly sizeBytes: number | null;
  readonly remoteCreatedAt: Date | null;
  readonly remoteModifiedAt: Date | null;
}

/** What a connector hands the store for one container. Plaintext — it is sealed here. */
export interface CloudFileSourceInput extends CloudFileSourceScope {
  readonly kind: CloudFileSourceKind;
  /** M365 SharePoint's composite site id; null where there is no site. */
  readonly siteId: string | null;
  readonly siteName: string | null;
  readonly name: string;
  readonly webUrl: string | null;
  readonly followed: boolean;
}

/**
 * How many ids go into one `IN (…)` list. Postgres allows ~32k bind parameters
 * per statement; a deleted folder with a six-figure subtree must not be one
 * statement, and 500 keeps every statement small enough to read in a slow-query
 * log.
 */
const ID_CHUNK = 500;

function chunked<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** A size that is a real count of bytes, or null. A float, a negative or a
 *  number past 2^53 is a provider bug, and null says "unknown" where a stored
 *  wrong number would say something false. */
function sizeToBigInt(size: number | null): bigint | null {
  return size !== null && Number.isSafeInteger(size) && size >= 0 ? BigInt(size) : null;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Land one file or folder: create it, or refresh it if it is already here.
 *
 * `sweepPending` is written `false` on BOTH paths — that is how an item the
 * current full enumeration returns un-marks itself (see the module header). An
 * upsert that left it alone would let the sweep delete a file the provider
 * had just told us about.
 */
export async function upsertItem(db: CloudFileDb, input: CloudFileItemInput): Promise<void> {
  const { userId, provider, sourceId, externalId } = input;
  const ref = { provider, userId, sourceId, externalId };
  const crypto = cloudFileCrypto();
  const fields = {
    parentExternalId: input.parentExternalId,
    isFolder: input.isFolder,
    nameEnc: crypto.sealItem(ref, "name", input.name),
    webUrlEnc: input.webUrl === null ? null : crypto.sealItem(ref, "webUrl", input.webUrl),
    lastModifiedByEnc:
      input.lastModifiedBy === null ? null : crypto.sealItem(ref, "lastModifiedBy", input.lastModifiedBy),
    mimeType: input.mimeType,
    sizeBytes: sizeToBigInt(input.sizeBytes),
    remoteCreatedAt: input.remoteCreatedAt,
    remoteModifiedAt: input.remoteModifiedAt,
    sweepPending: false,
  };
  await db.cloudFileItem.upsert({
    where: { userId_provider_sourceId_externalId: ref },
    create: { ...ref, ...fields },
    update: fields,
  });
}

/**
 * Remove one item — and, when it is a folder, everything beneath it.
 *
 * A change feed may report a deleted FOLDER without listing what was in it (the
 * descendants are not guaranteed to arrive as deletions of their own), and a
 * stored child of a folder that no longer exists is a search hit that opens a
 * 404. So the delete follows `parentExternalId` downwards, level by level, and
 * removes the whole subtree.
 *
 * Bounded by what exists, never by a guess: a visited set makes a malformed
 * parent loop (A under B under A) end instead of spin, and ids go through the
 * database in chunks. The descendants are looked up even when the row itself is
 * absent — a delete that arrives after an earlier run already removed the folder
 * must still clear children that run missed.
 *
 * Scoped to the one source: an item id is unique within a container, not across
 * them.
 */
export async function deleteItemTree(db: CloudFileDb, key: CloudFileItemKey): Promise<number> {
  const { userId, provider, sourceId, externalId } = key;
  const doomed = new Set<string>([externalId]);
  let level: string[] = [externalId];
  while (level.length > 0) {
    const deeper: string[] = [];
    for (const parents of chunked(level, ID_CHUNK)) {
      const children = await db.cloudFileItem.findMany({
        where: { userId, provider, sourceId, parentExternalId: { in: parents } },
        select: { externalId: true },
      });
      for (const child of children) {
        if (doomed.has(child.externalId)) continue;
        doomed.add(child.externalId);
        deeper.push(child.externalId);
      }
    }
    level = deeper;
  }

  let deleted = 0;
  for (const ids of chunked([...doomed], ID_CHUNK)) {
    const { count } = await db.cloudFileItem.deleteMany({
      where: { userId, provider, sourceId, externalId: { in: ids } },
    });
    deleted += count;
  }
  return deleted;
}

/**
 * The first half of a full enumeration: every row this source holds for this
 * person becomes "not seen yet". See the module header.
 */
export async function markSourceForSweep(db: CloudFileDb, scope: CloudFileSourceScope): Promise<number> {
  const { userId, provider, sourceId } = scope;
  const { count } = await db.cloudFileItem.updateMany({
    where: { userId, provider, sourceId },
    data: { sweepPending: true },
  });
  return count;
}

/**
 * The second half: the rows the run did not see are gone upstream, so delete
 * them. Only rows still marked — an incremental run never marks, so it can never
 * reach one — and only this source's.
 */
export async function sweepSource(db: CloudFileDb, scope: CloudFileSourceScope): Promise<number> {
  const { userId, provider, sourceId } = scope;
  const { count } = await db.cloudFileItem.deleteMany({
    where: { userId, provider, sourceId, sweepPending: true },
  });
  return count;
}

/** How many FILES (folders excluded) each source holds, by `sourceId`. */
export async function countFilesBySource(
  db: CloudFileDb,
  owner: CloudFileOwner,
): Promise<Map<string, number>> {
  const { userId, provider } = owner;
  const rows = await db.cloudFileItem.groupBy({
    by: ["sourceId"],
    where: { userId, provider, isFolder: false },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.sourceId, r._count._all]));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function sealedSourceFields(input: CloudFileSourceInput) {
  const { userId, provider, sourceId } = input;
  const ref = { provider, userId, sourceId };
  const crypto = cloudFileCrypto();
  return {
    kind: input.kind,
    siteId: input.siteId,
    siteNameEnc: input.siteName === null ? null : crypto.sealSource(ref, "siteName", input.siteName),
    nameEnc: crypto.sealSource(ref, "name", input.name),
    webUrlEnc: input.webUrl === null ? null : crypto.sealSource(ref, "webUrl", input.webUrl),
    followed: input.followed,
  };
}

/**
 * Register a container, or refresh everything about it: a library renamed, a
 * site newly followed. For a container whose details the provider keeps
 * re-reporting; see {@link ensureSource} for one it reports once.
 */
export async function upsertSource(db: CloudFileDb, input: CloudFileSourceInput): Promise<void> {
  const { userId, provider, sourceId } = input;
  const fields = sealedSourceFields(input);
  await db.cloudFileSource.upsert({
    where: { userId_provider_sourceId: { userId, provider, sourceId } },
    create: { userId, provider, sourceId, ...fields },
    update: fields,
  });
}

/**
 * Register a container ONLY if it is not already here; an existing row is left
 * exactly as it is. For a container read once (a person's OneDrive): rewriting
 * its sealed fields on every tick would churn the row for nothing, and a refresh
 * that could fail halfway is a way to lose a good value for a worse one.
 */
export async function ensureSource(db: CloudFileDb, input: CloudFileSourceInput): Promise<void> {
  const { userId, provider, sourceId } = input;
  await db.cloudFileSource.upsert({
    where: { userId_provider_sourceId: { userId, provider, sourceId } },
    create: { userId, provider, sourceId, ...sealedSourceFields(input) },
    update: {},
  });
}

/**
 * The `sourceId` of this person's source of a kind, or null when they have none.
 * With more than one (which nothing should produce for the kinds that are
 * singletons) the newest wins, so the answer is deterministic rather than
 * whichever row the planner returned first.
 */
export async function findSourceId(
  db: CloudFileDb,
  owner: CloudFileOwner & { readonly kind: CloudFileSourceKind },
): Promise<string | null> {
  const { userId, provider, kind } = owner;
  const row = await db.cloudFileSource.findFirst({
    where: { userId, provider, kind },
    orderBy: [{ createdAt: "desc" }, { sourceId: "asc" }],
    select: { sourceId: true },
  });
  return row?.sourceId ?? null;
}

/**
 * Does this person have THIS source — this container, of this kind, in this cloud?
 *
 * What a landing handler asks before it writes a file: is the place the file would
 * sit one the person still has? A library can be removed while a page of it is
 * still being handled (the person switched SharePoint off, or a complete discovery
 * pruned it), and the rows that page would write have no foreign key to stop them:
 * they would sit under a source that no longer exists, where nothing lists them and
 * nothing deletes them. The kind is part of the question, so a OneDrive's id cannot
 * stand in for a library's.
 */
export async function hasSource(
  db: CloudFileDb,
  scope: CloudFileSourceScope & { readonly kind: CloudFileSourceKind },
): Promise<boolean> {
  const { userId, provider, sourceId, kind } = scope;
  const row = await db.cloudFileSource.findFirst({ where: { userId, provider, sourceId, kind }, select: { id: true } });
  return row !== null;
}

/** Every `sourceId` this person has of a kind. */
export async function listSourceIds(
  db: CloudFileDb,
  owner: CloudFileOwner & { readonly kind: CloudFileSourceKind },
): Promise<string[]> {
  const { userId, provider, kind } = owner;
  const rows = await db.cloudFileSource.findMany({ where: { userId, provider, kind }, select: { sourceId: true } });
  return rows.map((r) => r.sourceId);
}

// ---------------------------------------------------------------------------
// Purging
// ---------------------------------------------------------------------------

/** Delete every item that sits in any of these sources, for this person. */
export async function deleteItemsInSources(
  db: CloudFileDb,
  owner: CloudFileOwner & { readonly sourceIds: readonly string[] },
): Promise<number> {
  const { userId, provider } = owner;
  let deleted = 0;
  for (const ids of chunked(owner.sourceIds, ID_CHUNK)) {
    const { count } = await db.cloudFileItem.deleteMany({ where: { userId, provider, sourceId: { in: ids } } });
    deleted += count;
  }
  return deleted;
}

/** Delete these source rows, for this person. */
export async function deleteSources(
  db: CloudFileDb,
  owner: CloudFileOwner & { readonly sourceIds: readonly string[] },
): Promise<number> {
  const { userId, provider } = owner;
  let deleted = 0;
  for (const ids of chunked(owner.sourceIds, ID_CHUNK)) {
    const { count } = await db.cloudFileSource.deleteMany({ where: { userId, provider, sourceId: { in: ids } } });
    deleted += count;
  }
  return deleted;
}

/**
 * Delete everything a person has landed from one cloud — every item and every
 * source. For disconnect, for a leaver's deletion and for a reconnect as a
 * different account. Items first: a failure between the two leaves sources with
 * no files, which is residue, never files with no source to say where they live.
 */
export async function purgeProviderForUser(
  db: CloudFileDb,
  owner: CloudFileOwner,
): Promise<{ items: number; sources: number }> {
  const { userId, provider } = owner;
  const items = await db.cloudFileItem.deleteMany({ where: { userId, provider } });
  const sources = await db.cloudFileSource.deleteMany({ where: { userId, provider } });
  return { items: items.count, sources: sources.count };
}

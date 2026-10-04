/**
 * WARP-3538 / ADR-041 §4 — finding a person's own files in the provider-agnostic
 * cloud-file store.
 *
 * ONE search over every cloud a person has connected: a question asked once
 * ("the consent form changed this week") is answered from their OneDrive, their
 * SharePoint libraries and — as those connectors land — their Google Drive and
 * Dropbox together. That is why this lives beside the store and not in the
 * Microsoft 365 module.
 *
 * ## Why the filtering happens here, in memory
 *
 * File and library NAMES are sealed at rest (cloud-file-crypto.ts): a name in a
 * practice carries a patient's. The database cannot match on ciphertext, so a
 * name or location filter means decrypting. What the database CAN do it does:
 * the person, the provider, the source, and `modifiedSince` are clear columns and
 * are pushed into the query, so a narrow search over a large store reads little.
 *
 * ## The bound
 *
 * A search decrypts at most {@link MAX_SEARCH_CANDIDATES} rows and REFUSES a
 * larger candidate set ({@link CloudFileSearchTooLargeError}) rather than
 * returning a partial answer: "the 25 newest of the first fifty thousand rows the
 * database happened to return" is a wrong answer that looks right. The refusal
 * says how to narrow it (a location or a date). Without `q` the cost is nothing
 * but the sort (names are opened only for the answer), so the bound bites only
 * for the largest stores and the broadest name searches.
 *
 * ## What a result carries
 *
 * Names, locations, links and modified dates — never content (the store has none).
 * `path` is the containing FOLDERS, rebuilt at read time from the parent chain
 * because the change feed carries ids and no paths: best effort and root-excluded
 * — the chain ends at the first parent that is not stored (the source's root is
 * never stored), so a file directly under the root has an empty path. Only the
 * answer's own rows are resolved, a level per query, not the whole store.
 *
 * Every query is scoped to `userId`: a person only ever finds their own files.
 * A row that cannot be opened (a rotated device key) is skipped and counted, never
 * shown as something else.
 */
import type { CloudFileProvider, CloudFileSourceKind } from "@prisma/client";

import { createLogger } from "../../lib/logger.js";
import { cloudFileCrypto, type CloudFileCrypto } from "./cloud-file-crypto.js";
import { PROVIDER_DISPLAY_NAMES, providerToWire } from "./cloud-file-provider.js";
import type { CloudFileDb } from "./cloud-file-store.service.js";

const logger = createLogger("cloud-file-search");

/**
 * The most rows one search will decrypt. 50,000 names is a second or two of work
 * on the box and a few tens of MB; past it the right answer is to ask the person
 * to narrow the search, not to guess.
 */
export const MAX_SEARCH_CANDIDATES = 50_000;

/** What a search returns when the caller names no limit. */
export const DEFAULT_SEARCH_LIMIT = 25;

/** The most a search may return. */
export const MAX_SEARCH_LIMIT = 100;

/** How many parent folders a path climbs before it stops — far past any real tree, and the end of a malformed loop. */
const MAX_PATH_DEPTH = 32;

/** The separator in `"<site> › <library>"` — the location a SharePoint library is shown as. */
const LOCATION_SEPARATOR = " › ";

/**
 * How each kind of source is named to a person. A `Record` over the Prisma enum,
 * so a kind added to the schema cannot ship without a way to say where its files
 * live.
 */
const LOCATION_LABELS: Readonly<
  Record<CloudFileSourceKind, (names: { siteName: string | null; name: string }) => string>
> = {
  ONEDRIVE: () => "OneDrive",
  SHAREPOINT_LIBRARY: ({ siteName, name }) => (siteName ? `${siteName}${LOCATION_SEPARATOR}${name}` : name),
};

/** A search could not be answered because too many rows would have to be opened. */
export class CloudFileSearchTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(
      `There are more than ${limit} files to search through. Narrow the search to one location or to files changed since a date.`,
    );
    this.name = "CloudFileSearchTooLargeError";
  }
}

export interface CloudFileSearchParams {
  readonly userId: string;
  /** Words that must ALL appear in the file's name, in any order, ignoring case. */
  readonly query?: string;
  readonly provider?: CloudFileProvider;
  /** Matches (case-insensitively, as a substring) where the file lives: "OneDrive", a library, a site. */
  readonly source?: string;
  /** Only files modified at or after this moment. A file whose modified time is unknown is not "since" anything. */
  readonly modifiedSince?: Date;
  /** 1 to {@link MAX_SEARCH_LIMIT}; the caller validates. */
  readonly limit: number;
}

/** One file or folder, as it is shown to a person or a model. */
export interface CloudFileHit {
  readonly name: string;
  readonly isFolder: boolean;
  /** The wire spelling of the provider (`m365`). */
  readonly provider: string;
  /** `"OneDrive"` or `"<site> › <library>"`; the provider's own name where the source is not known. */
  readonly location: string;
  /** The containing folders, `"A/B"`, root excluded; empty for a top-level item. Best effort. */
  readonly path: string;
  readonly webUrl: string | null;
  /** ISO 8601, or null when the provider did not say. */
  readonly lastModifiedAt: string | null;
  readonly lastModifiedBy: string | null;
  /** Bytes, as a JS number — exact below 2^53, which no file approaches. Null for a folder or an unknown size. */
  readonly sizeBytes: number | null;
}

export interface CloudFileSearchResult {
  /** The newest `limit` matches, newest first. */
  readonly items: CloudFileHit[];
  /** How many files matched in all — more than `items` when the answer was cut at the limit. Rows, so it can include ones that could not be opened (see `unreadable`). */
  readonly total: number;
  /** Rows this answer found it could not open (a rotated device key); never shown, and counted so the caller can log it. */
  readonly unreadable: number;
}

interface Candidate {
  readonly provider: CloudFileProvider;
  readonly sourceId: string;
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly isFolder: boolean;
  readonly nameEnc: string;
  readonly webUrlEnc: string | null;
  readonly lastModifiedByEnc: string | null;
  readonly sizeBytes: bigint | null;
  readonly remoteModifiedAt: Date | null;
}

const key = (provider: string, sourceId: string) => `${provider}\u0000${sourceId}`;

/** Newest first, a row with no modified time last, then a fixed order so equal times never reshuffle between calls. */
function newestFirst(a: Candidate, b: Candidate): number {
  const at = a.remoteModifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bt = b.remoteModifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at < bt ? 1 : -1;
  return (
    (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
    (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0) ||
    (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0)
  );
}

function tryOpen(open: () => string): string | null {
  try {
    return open();
  } catch {
    return null;
  }
}

/** The person's sources as they are shown: where each lives, in words. */
async function locationsOf(
  db: CloudFileDb,
  crypto: CloudFileCrypto,
  userId: string,
  provider: CloudFileProvider | undefined,
): Promise<Map<string, string>> {
  const rows = await db.cloudFileSource.findMany({
    where: { userId, ...(provider ? { provider } : {}) },
    select: { provider: true, sourceId: true, kind: true, siteNameEnc: true, nameEnc: true },
  });
  const out = new Map<string, string>();
  for (const row of rows) {
    const ref = { provider: row.provider, userId, sourceId: row.sourceId };
    const name = tryOpen(() => crypto.openSource(ref, "name", row.nameEnc));
    // A source whose name cannot be opened is shown as its provider, never as a
    // guess — and its items cannot be opened either, so nothing is lost by it.
    if (name === null) continue;
    const siteName = row.siteNameEnc === null ? null : tryOpen(() => crypto.openSource(ref, "siteName", row.siteNameEnc!));
    out.set(key(row.provider, row.sourceId), LOCATION_LABELS[row.kind]({ siteName, name }));
  }
  return out;
}

/**
 * The containing-folder path of each hit, rebuilt from the parent chain — one
 * query per level, for the answer's rows only.
 */
async function pathsOf(
  db: CloudFileDb,
  crypto: CloudFileCrypto,
  userId: string,
  hits: readonly Candidate[],
): Promise<Map<Candidate, string>> {
  const names = new Map<Candidate, string[]>();
  const climbing = new Map<Candidate, string | null>();
  // The folders each hit has already climbed through: a malformed parent loop
  // (A under B under A) ends the chain at the second visit instead of repeating
  // itself until the depth cap.
  const visited = new Map<Candidate, Set<string>>();
  for (const hit of hits) {
    names.set(hit, []);
    climbing.set(hit, hit.parentExternalId);
    visited.set(hit, new Set());
  }

  for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
    // Which parent ids to fetch, per source: an item id is unique within a
    // container, not across them.
    const wanted = new Map<string, { provider: CloudFileProvider; sourceId: string; ids: Set<string> }>();
    for (const [hit, parent] of climbing) {
      if (parent === null) continue;
      const k = key(hit.provider, hit.sourceId);
      const group = wanted.get(k) ?? { provider: hit.provider, sourceId: hit.sourceId, ids: new Set<string>() };
      group.ids.add(parent);
      wanted.set(k, group);
    }
    if (wanted.size === 0) break;

    const found = new Map<string, { parentExternalId: string | null; nameEnc: string }>();
    for (const group of wanted.values()) {
      const rows = await db.cloudFileItem.findMany({
        where: { userId, provider: group.provider, sourceId: group.sourceId, externalId: { in: [...group.ids] } },
        select: { externalId: true, parentExternalId: true, nameEnc: true },
      });
      for (const row of rows) found.set(`${key(group.provider, group.sourceId)}\u0000${row.externalId}`, row);
    }

    for (const [hit, parent] of [...climbing]) {
      if (parent === null) continue;
      const row = found.get(`${key(hit.provider, hit.sourceId)}\u0000${parent}`);
      const name =
        row === undefined
          ? null
          : tryOpen(() => crypto.openItem({ provider: hit.provider, userId, sourceId: hit.sourceId, externalId: parent }, "name", row.nameEnc));
      // The chain ends where a parent is not stored (the root never is), cannot
      // be read, or has been climbed already: best effort, and never a path built
      // from a guess.
      if (row === undefined || name === null || visited.get(hit)!.has(parent)) {
        climbing.set(hit, null);
        continue;
      }
      visited.get(hit)!.add(parent);
      names.get(hit)!.push(name);
      climbing.set(hit, row.parentExternalId);
    }
  }

  return new Map([...names].map(([hit, chain]) => [hit, [...chain].reverse().join("/")]));
}

/**
 * Search a person's landed files.
 *
 * Order of work, cheapest first: the person's sources (a handful) are opened to
 * know where things live and to narrow `source`; the clear filters go into the
 * query; the candidates are sorted newest first; only then, if a name filter was
 * asked for, are names opened — and otherwise only the answer's own.
 */
export async function searchCloudFiles(
  db: CloudFileDb,
  params: CloudFileSearchParams,
): Promise<CloudFileSearchResult> {
  const { userId, provider, modifiedSince, limit } = params;
  const crypto = cloudFileCrypto();
  const terms = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const needle = (params.source ?? "").trim().toLowerCase();

  const locations = await locationsOf(db, crypto, userId, provider);

  // `source` is a statement about WHERE a file lives, so it can only be answered
  // for files whose source is known; it narrows the query to those sources.
  let sourceIds: string[] | undefined;
  if (needle) {
    sourceIds = [...locations].filter(([, label]) => label.toLowerCase().includes(needle)).map(([k]) => k.split("\u0000")[1]!);
    if (sourceIds.length === 0) return { items: [], total: 0, unreadable: 0 };
  }

  const rows = await db.cloudFileItem.findMany({
    where: {
      userId,
      ...(provider ? { provider } : {}),
      ...(sourceIds ? { sourceId: { in: sourceIds } } : {}),
      ...(modifiedSince ? { remoteModifiedAt: { gte: modifiedSince } } : {}),
    },
    select: {
      provider: true,
      sourceId: true,
      externalId: true,
      parentExternalId: true,
      isFolder: true,
      nameEnc: true,
      webUrlEnc: true,
      lastModifiedByEnc: true,
      sizeBytes: true,
      remoteModifiedAt: true,
    },
    // One past the bound: enough to know it was exceeded, without reading the lot.
    take: MAX_SEARCH_CANDIDATES + 1,
  });
  if (rows.length > MAX_SEARCH_CANDIDATES) throw new CloudFileSearchTooLargeError(MAX_SEARCH_CANDIDATES);

  // The query's `in` is a superset of the sources the label matched (it does not
  // know the provider alongside each id), so the exact (provider, source) pair is
  // checked again here — and a file whose source is unknown cannot match a location.
  const candidates = (rows as Candidate[])
    .filter((row) => !needle || locations.has(key(row.provider, row.sourceId)))
    .sort(newestFirst);

  const nameOf = new Map<Candidate, string>();
  const open = (row: Candidate): string | null => {
    const known = nameOf.get(row);
    if (known !== undefined) return known;
    const name = tryOpen(() =>
      crypto.openItem({ provider: row.provider, userId, sourceId: row.sourceId, externalId: row.externalId }, "name", row.nameEnc),
    );
    if (name !== null) nameOf.set(row, name);
    return name;
  };

  // With a name filter every candidate's name is opened to test it. Without one,
  // names are opened only for the rows that make the answer.
  let matches: Candidate[];
  let unreadable = 0;
  if (terms.length > 0) {
    matches = [];
    for (const row of candidates) {
      const name = open(row);
      if (name === null) unreadable += 1;
      else if (terms.every((t) => name.toLowerCase().includes(t))) matches.push(row);
    }
  } else {
    matches = candidates;
  }

  const answer: Candidate[] = [];
  for (const row of matches) {
    if (answer.length >= limit) break;
    if (open(row) === null) {
      if (terms.length === 0) unreadable += 1;
      continue;
    }
    answer.push(row);
  }
  if (unreadable > 0) {
    // Counts only: a name in a practice carries a patient's. A rotated device key
    // is the usual cause, and a reconnect re-lands everything under the new one.
    logger.warn({ unreadable }, "cloud files could not be opened and were left out of a search");
  }

  const paths = await pathsOf(db, crypto, userId, answer);
  const items = answer.map((row): CloudFileHit => {
    const ref = { provider: row.provider, userId, sourceId: row.sourceId, externalId: row.externalId };
    const size = row.sizeBytes === null ? null : Number(row.sizeBytes);
    return {
      name: nameOf.get(row)!,
      isFolder: row.isFolder,
      provider: providerToWire(row.provider),
      location: locations.get(key(row.provider, row.sourceId)) ?? PROVIDER_DISPLAY_NAMES[row.provider],
      path: paths.get(row) ?? "",
      webUrl: row.webUrlEnc === null ? null : tryOpen(() => crypto.openItem(ref, "webUrl", row.webUrlEnc!)),
      lastModifiedAt: row.remoteModifiedAt === null ? null : row.remoteModifiedAt.toISOString(),
      lastModifiedBy:
        row.lastModifiedByEnc === null ? null : tryOpen(() => crypto.openItem(ref, "lastModifiedBy", row.lastModifiedByEnc!)),
      sizeBytes: size !== null && Number.isSafeInteger(size) ? size : null,
    };
  });

  return { items, total: matches.length, unreadable };
}

/**
 * WARP-225 — per-user context-meter service.
 *
 * Backs the dashboard's home-page <ContextWidget /> + dedicated /context
 * page. All aggregates are scoped per user at the SQL layer; cross-user
 * leakage is structurally impossible (every query has WHERE "userId" = $1).
 *
 * WARP-1394 — every aggregate covers BOTH ingestion pipelines:
 *   - chat attachments (`BrainMemoryItem` + source='brain' chunks), keyed
 *     by the local User UUID (WARP-493);
 *   - Nextcloud-synced files (`FileIndexStatus` + source='nextcloud'
 *     chunks, watcher-written), keyed by the NEXTCLOUD username.
 *   The two key spaces differ in the production shape (UUID ≠ username),
 *   so every entry point takes both. Synced rows carry no MIME type,
 *   bytes, or upload timestamp: categories come from the file extension
 *   (`path_ext_to_category()` / lib/path-category.ts), "bytes indexed"
 *   is the indexed chunk-text volume, and time-to-ready is not tracked
 *   (avgSecondsToReady stays null on 'nextcloud' pipeline rows).
 *
 * Caching strategy (per spec §Data layer):
 *   - context-stats:<userId>:summary  → 30s   (stat cards + recently indexed)
 *   - context-stats:<userId>:full     → 60s   (deep-dive aggregates)
 *   - context-stats:<userId>:queued   → 5min  (queued drill-down)
 *   - context-stats:<userId>:failed   → 5min  (failed drill-down)
 *
 * Cache invalidation lives in src/services/context-stats-invalidation.ts —
 * it subscribes to `droplet/context-stats/invalidate` MQTT messages from
 * the file-indexer and DELs `context-stats:<userId>:*`. (The watcher does
 * not publish invalidations; synced-file freshness rides the TTLs above.)
 *
 * Why TS-side aggregates and not Prisma `groupBy`: the donut and bytes-bar
 * both group by `mime_to_category("mimeType")` / `path_ext_to_category("path")`,
 * which Prisma's typed query builder can't express. Using $queryRaw keeps the
 * per-query budget at one round-trip and lets the planner fold the IMMUTABLE
 * functions inline.
 */

import type { PrismaClient } from "@prisma/client";
import { withSwrCache } from "./cache.service.js";
import { CATEGORY_ORDER, type MimeCategory } from "../lib/mime-category.js";
import { pathToCategory } from "../lib/path-category.js";

// Cache TTLs — derived from the spec table. Constants (no env vars) because
// the dashboard's polling cadence is paired to these values; changing one
// without the other breaks the "fresh-feeling" UX target.
export const CACHE_TTL_SUMMARY_S = 30;
export const CACHE_TTL_FULL_S = 60;
export const CACHE_TTL_QUEUED_S = 300;
export const CACHE_TTL_FAILED_S = 300;

export const CACHE_KEY_PREFIX = "context-stats:";

export function summaryKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}:summary`;
}
export function fullKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}:full`;
}
export function queuedKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}:queued`;
}
export function failedKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}:failed`;
}
export function userKeyPrefix(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}:`;
}

// ── Response shapes ─────────────────────────────────────────────────────
//
// JSON-safe: BigInt is coerced to number inside the service layer because
// the dashboard's recharts pipeline can't bind BigInt and the response is
// serialised by Express anyway.

/** WARP-1394 — which ingestion pipeline a row came from. Mirrors the
 *  `FileContentSource` Prisma enum. */
export type ContextSource = "brain" | "nextcloud";

export interface ContextStatsSummary {
  files: number;
  chunks: number;
  queued: number;
  failed: number;
  /** WARP-2056 — files the indexer deliberately produced no text for
   *  (no text layer, no extractor for the format, empty document).
   *
   *  `files` counts every status, so before this existed the surface said
   *  "622 files" for a corpus where 505 were actually searchable, and there
   *  was nowhere at all a user could see that the other 117 were not. Every
   *  extraction defect found on the box hid behind exactly that gap. A skip
   *  is a normal outcome for a photo or an installer, so this is reported
   *  alongside `failed`, not as an error. */
  skipped: number;
  recentlyIndexed: RecentlyIndexedItem[];
}

export interface RecentlyIndexedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  indexedAt: string; // ISO
  chunkCount: number;
  source: ContextSource;
}

export interface SourceCategoryRow {
  category: MimeCategory;
  files: number;
  bytes: number;
}

export interface ThroughputDay {
  /** YYYY-MM-DD in server TZ; the dashboard only renders relative shape. */
  day: string;
  count: number;
}

export interface PipelineHealthRow {
  category: MimeCategory;
  files: number;
  /** null when no timing exists: for 'brain' rows that means no item of
   *  this category reached 'ready'; 'nextcloud' rows never carry timing
   *  (FileIndexStatus has no upload timestamp). */
  avgSecondsToReady: number | null;
  failed: number;
  source: ContextSource;
}

export interface ContextStatsFull extends ContextStatsSummary {
  /** Original file bytes for chat attachments + indexed chunk-text bytes
   *  for synced files (their original sizes aren't recorded). */
  bytesIndexed: number;
  byCategory: SourceCategoryRow[];
  throughput7d: ThroughputDay[];
  pipelineHealth: PipelineHealthRow[];
}

export interface QueuedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  uploadedAt: string;
  reason: string;
  source: ContextSource;
}

export interface FailedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  failureReason: string | null;
  lastAttemptedAt: string | null;
  recentAttemptCount: number;
  source: ContextSource;
}

// ── Internal helpers ────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

function isCategory(v: unknown): v is MimeCategory {
  return (
    typeof v === "string" &&
    (CATEGORY_ORDER as readonly string[]).includes(v as string)
  );
}

function reasonForQueued(mimeType: string | null): string {
  if (!mimeType) return "queued for processing";
  if (mimeType.startsWith("audio/"))
    return "audio file, scheduled for nightly transcription";
  if (mimeType.startsWith("video/"))
    return "video file, scheduled for nightly transcription";
  return "queued for processing";
}

function filenameFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base || path;
}

/** Synced rows have no DB id (composite userId+path key); the `nc:` prefix
 *  keeps the wire id unique next to BrainMemoryItem UUIDs and inert against
 *  the transcription-retry route (findUnique miss → 404). */
function ncItemId(path: string): string {
  return `nc:${path}`;
}

// ── Aggregate queries — chat attachments (BrainMemoryItem) ──────────────

async function fetchCounts(
  prisma: PrismaClient,
  userId: string,
): Promise<{ files: number; chunks: number; queued: number; failed: number; bytes: number }> {
  // Single-pass aggregate; one round trip per metric so we can index each
  // independently. Postgres planner uses the (userId), (userId, status),
  // (userId, source, indexedAt) indexes already on the schema.
  const [filesRow, chunksRow, queuedRow, failedRow, bytesRow] = await Promise.all(
    [
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "BrainMemoryItem"
         WHERE "userId" = ${userId}`,
      // Chat-attachment chunks only — synced chunks are keyed by the
      // Nextcloud username and counted in fetchNcCounts (the source
      // split also prevents double-counting in the dev shape where
      // UUID === username).
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileContentChunk"
         WHERE "userId" = ${userId}
           AND "source" = 'brain'`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "BrainMemoryItem"
         WHERE "userId" = ${userId}
           AND "status" = 'queued_for_transcription'`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "BrainMemoryItem"
         WHERE "userId" = ${userId}
           AND "status" = 'failed'`,
      prisma.$queryRaw<Array<{ b: bigint | null }>>`
        SELECT COALESCE(sum("bytes"), 0)::bigint AS b
          FROM "BrainMemoryItem"
         WHERE "userId" = ${userId}`,
    ],
  );
  return {
    files: toNum(filesRow[0]?.c),
    chunks: toNum(chunksRow[0]?.c),
    queued: toNum(queuedRow[0]?.c),
    failed: toNum(failedRow[0]?.c),
    bytes: toNum(bytesRow[0]?.b),
  };
}

async function fetchRecentlyIndexed(
  prisma: PrismaClient,
  userId: string,
  limit = 10,
): Promise<RecentlyIndexedItem[]> {
  // Recently-indexed list joins per-item chunk counts so the UI can show
  // "12 chunks" without an N+1 fan-out. Left join because items with
  // status='ready' but zero chunks (e.g. an empty-extraction edge case)
  // should still surface.
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      filename: string;
      mimeType: string | null;
      indexedAt: Date;
      chunkCount: bigint | null;
    }>
  >`
    SELECT i."id"        AS "id",
           i."filename"  AS "filename",
           i."mimeType"  AS "mimeType",
           i."indexedAt" AS "indexedAt",
           (
             SELECT count(*)::bigint
               FROM "FileContentChunk" c
              WHERE c."brainItemId" = i."id"
           ) AS "chunkCount"
      FROM "BrainMemoryItem" i
     WHERE i."userId" = ${userId}
       AND i."indexedAt" IS NOT NULL
     ORDER BY i."indexedAt" DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => {
    const category = mimeToCategorySync(r.mimeType);
    return {
      id: r.id,
      filename: r.filename,
      mimeType: r.mimeType,
      category,
      indexedAt: r.indexedAt.toISOString(),
      chunkCount: toNum(r.chunkCount ?? 0),
      source: "brain" as const,
    };
  });
}

async function fetchByCategory(
  prisma: PrismaClient,
  userId: string,
): Promise<SourceCategoryRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ category: string; files: bigint; bytes: bigint | null }>
  >`
    SELECT mime_to_category("mimeType") AS category,
           count(*)::bigint              AS files,
           COALESCE(sum("bytes"), 0)::bigint AS bytes
      FROM "BrainMemoryItem"
     WHERE "userId" = ${userId}
     GROUP BY category
     ORDER BY files DESC
  `;
  return rows.map((r) => ({
    category: isCategory(r.category) ? r.category : "other",
    files: toNum(r.files),
    bytes: toNum(r.bytes ?? 0),
  }));
}

async function fetchThroughput7dRows(
  prisma: PrismaClient,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<
    Array<{ day: Date; count: bigint }>
  >`
    SELECT date_trunc('day', "indexedAt")::date AS day,
           count(*)::bigint                      AS count
      FROM "BrainMemoryItem"
     WHERE "userId" = ${userId}
       AND "indexedAt" > NOW() - INTERVAL '7 days'
     GROUP BY day
     ORDER BY day ASC
  `;
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.day.toISOString().slice(0, 10), toNum(r.count));
  }
  return byDay;
}

async function fetchPipelineHealth(
  prisma: PrismaClient,
  userId: string,
): Promise<PipelineHealthRow[]> {
  // Per-category file counts, avg seconds-to-ready (only for items that
  // actually reached 'ready' — `indexedAt IS NOT NULL` AND status='ready'),
  // and failed counts. One pass over BrainMemoryItem; no joins.
  const rows = await prisma.$queryRaw<
    Array<{
      category: string;
      files: bigint;
      avg_seconds: number | string | null;
      failed: bigint;
    }>
  >`
    SELECT mime_to_category("mimeType") AS category,
           count(*)::bigint              AS files,
           avg(
             EXTRACT(EPOCH FROM ("indexedAt" - "uploadedAt"))
           ) FILTER (
             WHERE "indexedAt" IS NOT NULL AND "status" = 'ready'
           )                             AS avg_seconds,
           count(*) FILTER (WHERE "status" = 'failed')::bigint AS failed
      FROM "BrainMemoryItem"
     WHERE "userId" = ${userId}
     GROUP BY category
     ORDER BY files DESC
  `;
  return rows.map((r) => {
    const avg =
      r.avg_seconds === null || r.avg_seconds === undefined
        ? null
        : Number(r.avg_seconds);
    return {
      category: isCategory(r.category) ? r.category : "other",
      files: toNum(r.files),
      avgSecondsToReady:
        avg === null || Number.isNaN(avg) ? null : Math.round(avg * 10) / 10,
      failed: toNum(r.failed),
      source: "brain" as const,
    };
  });
}

async function fetchQueued(
  prisma: PrismaClient,
  userId: string,
): Promise<QueuedItem[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      filename: string;
      mimeType: string | null;
      uploadedAt: Date;
    }>
  >`
    SELECT "id", "filename", "mimeType", "uploadedAt"
      FROM "BrainMemoryItem"
     WHERE "userId" = ${userId}
       AND "status" = 'queued_for_transcription'
     ORDER BY "uploadedAt" ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    category: mimeToCategorySync(r.mimeType),
    uploadedAt: r.uploadedAt.toISOString(),
    reason: reasonForQueued(r.mimeType),
    source: "brain" as const,
  }));
}

async function fetchFailed(
  prisma: PrismaClient,
  userId: string,
): Promise<FailedItem[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      filename: string;
      mimeType: string | null;
      failureReason: string | null;
      lastAttemptedAt: Date | null;
      recentAttemptCount: number;
    }>
  >`
    SELECT "id", "filename", "mimeType", "failureReason",
           "lastAttemptedAt", "recentAttemptCount"
      FROM "BrainMemoryItem"
     WHERE "userId" = ${userId}
       AND "status" = 'failed'
     ORDER BY COALESCE("lastAttemptedAt", "uploadedAt") DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mimeType,
    category: mimeToCategorySync(r.mimeType),
    failureReason: r.failureReason,
    lastAttemptedAt: r.lastAttemptedAt
      ? r.lastAttemptedAt.toISOString()
      : null,
    recentAttemptCount: r.recentAttemptCount ?? 0,
    source: "brain" as const,
  }));
}

// ── Aggregate queries — Nextcloud-synced files (WARP-1394) ──────────────
//
// All keyed by the NEXTCLOUD username the watcher stamps. `files` counts
// every status (indexing/ready/skipped/failed) to mirror the brain-side
// "all rows" semantic; sub-states surface via queued/failed.

async function fetchNcCounts(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<{
  files: number;
  indexing: number;
  failed: number;
  skipped: number;
  chunks: number;
  textBytes: number;
}> {
  const [filesRow, indexingRow, failedRow, skippedRow, chunksRow, bytesRow] =
    await Promise.all([
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileIndexStatus"
         WHERE "userId" = ${ncUsername}`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileIndexStatus"
         WHERE "userId" = ${ncUsername}
           AND "status" = 'indexing'`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileIndexStatus"
         WHERE "userId" = ${ncUsername}
           AND "status" = 'failed'`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileIndexStatus"
         WHERE "userId" = ${ncUsername}
           AND "status" = 'skipped'`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileContentChunk"
         WHERE "userId" = ${ncUsername}
           AND "source" = 'nextcloud'`,
      prisma.$queryRaw<Array<{ b: bigint | null }>>`
        SELECT COALESCE(sum(length("text")), 0)::bigint AS b
          FROM "FileContentChunk"
         WHERE "userId" = ${ncUsername}
           AND "source" = 'nextcloud'`,
    ]);
  return {
    files: toNum(filesRow[0]?.c),
    indexing: toNum(indexingRow[0]?.c),
    failed: toNum(failedRow[0]?.c),
    skipped: toNum(skippedRow[0]?.c),
    chunks: toNum(chunksRow[0]?.c),
    textBytes: toNum(bytesRow[0]?.b),
  };
}

async function fetchNcRecentlyIndexed(
  prisma: PrismaClient,
  ncUsername: string,
  limit = 10,
): Promise<RecentlyIndexedItem[]> {
  // `updatedAt` of a 'ready' row is when the file (last) finished
  // indexing — the closest thing to `indexedAt` the watcher records.
  const rows = await prisma.$queryRaw<
    Array<{ path: string; updatedAt: Date; chunkCount: bigint | null }>
  >`
    SELECT i."path"      AS "path",
           i."updatedAt" AS "updatedAt",
           (
             SELECT count(*)::bigint
               FROM "FileContentChunk" c
              WHERE c."userId" = i."userId"
                AND c."path" = i."path"
                AND c."source" = 'nextcloud'
           ) AS "chunkCount"
      FROM "FileIndexStatus" i
     WHERE i."userId" = ${ncUsername}
       AND i."status" = 'ready'
     ORDER BY i."updatedAt" DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: ncItemId(r.path),
    filename: filenameFromPath(r.path),
    mimeType: null,
    category: pathToCategory(r.path),
    indexedAt: r.updatedAt.toISOString(),
    chunkCount: toNum(r.chunkCount ?? 0),
    source: "nextcloud" as const,
  }));
}

async function fetchNcByCategory(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<Map<string, { files: number; bytes: number }>> {
  // Two aggregates share the merge map: file counts from the status
  // table, indexed-text bytes from the synced chunks.
  const [fileRows, byteRows] = await Promise.all([
    prisma.$queryRaw<Array<{ category: string; files: bigint }>>`
      SELECT path_ext_to_category("path") AS category,
             count(*)::bigint AS files
        FROM "FileIndexStatus"
       WHERE "userId" = ${ncUsername}
       GROUP BY category
       ORDER BY files DESC
    `,
    prisma.$queryRaw<Array<{ category: string; bytes: bigint | null }>>`
      SELECT path_ext_to_category("path") AS category,
             COALESCE(sum(length("text")), 0)::bigint AS bytes
        FROM "FileContentChunk"
       WHERE "userId" = ${ncUsername}
         AND "source" = 'nextcloud'
       GROUP BY category
    `,
  ]);
  const out = new Map<string, { files: number; bytes: number }>();
  for (const r of fileRows) {
    const category = isCategory(r.category) ? r.category : "other";
    const cur = out.get(category) ?? { files: 0, bytes: 0 };
    cur.files += toNum(r.files);
    out.set(category, cur);
  }
  for (const r of byteRows) {
    const category = isCategory(r.category) ? r.category : "other";
    const cur = out.get(category) ?? { files: 0, bytes: 0 };
    cur.bytes += toNum(r.bytes ?? 0);
    out.set(category, cur);
  }
  return out;
}

async function fetchNcThroughput7dRows(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<
    Array<{ day: Date; count: bigint }>
  >`
    SELECT date_trunc('day', "updatedAt")::date AS day,
           count(*)::bigint AS count
      FROM "FileIndexStatus"
     WHERE "userId" = ${ncUsername}
       AND "status" = 'ready'
       AND "updatedAt" > NOW() - INTERVAL '7 days'
     GROUP BY day
     ORDER BY day ASC
  `;
  const byDay = new Map<string, number>();
  for (const r of rows) {
    byDay.set(r.day.toISOString().slice(0, 10), toNum(r.count));
  }
  return byDay;
}

async function fetchNcPipelineHealth(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<PipelineHealthRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ category: string; files: bigint; failed: bigint }>
  >`
    SELECT path_ext_to_category("path") AS category,
           count(*)::bigint AS files,
           count(*) FILTER (WHERE "status" = 'failed')::bigint AS failed
      FROM "FileIndexStatus"
     WHERE "userId" = ${ncUsername}
     GROUP BY category
     ORDER BY files DESC
  `;
  return rows.map((r) => ({
    category: isCategory(r.category) ? r.category : "other",
    files: toNum(r.files),
    avgSecondsToReady: null,
    failed: toNum(r.failed),
    source: "nextcloud" as const,
  }));
}

async function fetchNcQueued(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<QueuedItem[]> {
  const rows = await prisma.$queryRaw<
    Array<{ path: string; updatedAt: Date }>
  >`
    SELECT "path", "updatedAt"
      FROM "FileIndexStatus"
     WHERE "userId" = ${ncUsername}
       AND "status" = 'indexing'
     ORDER BY "updatedAt" ASC
  `;
  return rows.map((r) => ({
    id: ncItemId(r.path),
    filename: filenameFromPath(r.path),
    mimeType: null,
    category: pathToCategory(r.path),
    uploadedAt: r.updatedAt.toISOString(),
    reason: "being indexed from your synced files",
    source: "nextcloud" as const,
  }));
}

async function fetchNcFailed(
  prisma: PrismaClient,
  ncUsername: string,
): Promise<FailedItem[]> {
  const rows = await prisma.$queryRaw<
    Array<{ path: string; reason: string | null; updatedAt: Date }>
  >`
    SELECT "path", "reason", "updatedAt"
      FROM "FileIndexStatus"
     WHERE "userId" = ${ncUsername}
       AND "status" = 'failed'
     ORDER BY "updatedAt" DESC
  `;
  return rows.map((r) => ({
    id: ncItemId(r.path),
    filename: filenameFromPath(r.path),
    mimeType: null,
    category: pathToCategory(r.path),
    failureReason: r.reason,
    lastAttemptedAt: r.updatedAt.toISOString(),
    recentAttemptCount: 0,
    source: "nextcloud" as const,
  }));
}

// ── Merge helpers ───────────────────────────────────────────────────────

function mergeRecentlyIndexed(
  brain: RecentlyIndexedItem[],
  nc: RecentlyIndexedItem[],
  limit: number,
): RecentlyIndexedItem[] {
  return [...brain, ...nc]
    .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt))
    .slice(0, limit);
}

function mergeByCategory(
  brain: SourceCategoryRow[],
  nc: Map<string, { files: number; bytes: number }>,
): SourceCategoryRow[] {
  const out = new Map<string, { files: number; bytes: number }>();
  for (const r of brain) {
    const cur = out.get(r.category) ?? { files: 0, bytes: 0 };
    cur.files += r.files;
    cur.bytes += r.bytes;
    out.set(r.category, cur);
  }
  for (const [category, v] of nc) {
    const cur = out.get(category) ?? { files: 0, bytes: 0 };
    cur.files += v.files;
    cur.bytes += v.bytes;
    out.set(category, cur);
  }
  return [...out.entries()]
    .map(([category, v]) => ({
      category: (isCategory(category) ? category : "other") as MimeCategory,
      files: v.files,
      bytes: v.bytes,
    }))
    .sort((a, b) => b.files - a.files);
}

function denseThroughput7d(
  maps: Array<Map<string, number>>,
): ThroughputDay[] {
  // Sparse time series — Postgres doesn't synthesize zero-count days, so
  // we backfill on the JS side. The dashboard expects a dense 7-element
  // array (oldest first) for a clean sparkline.
  const out: ThroughputDay[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    let count = 0;
    for (const m of maps) count += m.get(key) ?? 0;
    out.push({ day: key, count });
  }
  return out;
}

// Local re-export of the lib classifier so the inner helpers don't need
// to plumb the import through every signature. Keeps the module's public
// surface small.
import { mimeToCategory as _mimeToCategory } from "../lib/mime-category.js";
function mimeToCategorySync(mime: string | null | undefined): MimeCategory {
  return _mimeToCategory(mime);
}

// ── Public API ──────────────────────────────────────────────────────────
//
// WARP-1394 — dual keys: `userId` is the local User UUID (scopes brain
// rows + the cache namespace), `ncUsername` is the Nextcloud username
// (scopes synced rows). In the dev shape the two are equal.

export async function getSummary(
  prisma: PrismaClient,
  userId: string,
  ncUsername: string,
): Promise<ContextStatsSummary> {
  return withSwrCache(summaryKey(userId), CACHE_TTL_SUMMARY_S, async () => {
    const [counts, ncCounts, brainRecent, ncRecent] = await Promise.all([
      fetchCounts(prisma, userId),
      fetchNcCounts(prisma, ncUsername),
      fetchRecentlyIndexed(prisma, userId, 10),
      fetchNcRecentlyIndexed(prisma, ncUsername, 10),
    ]);
    return {
      files: counts.files + ncCounts.files,
      chunks: counts.chunks + ncCounts.chunks,
      queued: counts.queued + ncCounts.indexing,
      failed: counts.failed + ncCounts.failed,
      // Brain uploads have no 'skipped' state — the brain pipeline records
      // a failure instead — so this is the Nextcloud count alone.
      skipped: ncCounts.skipped,
      recentlyIndexed: mergeRecentlyIndexed(brainRecent, ncRecent, 10),
    };
  });
}

export async function getFull(
  prisma: PrismaClient,
  userId: string,
  ncUsername: string,
): Promise<ContextStatsFull> {
  return withSwrCache(fullKey(userId), CACHE_TTL_FULL_S, async () => {
    const [
      counts,
      ncCounts,
      brainRecent,
      ncRecent,
      brainByCategory,
      ncByCategory,
      brainThroughput,
      ncThroughput,
      brainPipeline,
      ncPipeline,
    ] = await Promise.all([
      fetchCounts(prisma, userId),
      fetchNcCounts(prisma, ncUsername),
      fetchRecentlyIndexed(prisma, userId, 10),
      fetchNcRecentlyIndexed(prisma, ncUsername, 10),
      fetchByCategory(prisma, userId),
      fetchNcByCategory(prisma, ncUsername),
      fetchThroughput7dRows(prisma, userId),
      fetchNcThroughput7dRows(prisma, ncUsername),
      fetchPipelineHealth(prisma, userId),
      fetchNcPipelineHealth(prisma, ncUsername),
    ]);
    return {
      files: counts.files + ncCounts.files,
      chunks: counts.chunks + ncCounts.chunks,
      queued: counts.queued + ncCounts.indexing,
      failed: counts.failed + ncCounts.failed,
      // Brain uploads have no 'skipped' state — the brain pipeline records
      // a failure instead — so this is the Nextcloud count alone.
      skipped: ncCounts.skipped,
      bytesIndexed: counts.bytes + ncCounts.textBytes,
      recentlyIndexed: mergeRecentlyIndexed(brainRecent, ncRecent, 10),
      byCategory: mergeByCategory(brainByCategory, ncByCategory),
      throughput7d: denseThroughput7d([brainThroughput, ncThroughput]),
      // Sources stay separate rows: timing only exists for the brain
      // pipeline, and per-extractor health genuinely differs per source.
      // Array.sort is stable, so brain rows lead on equal file counts.
      pipelineHealth: [...brainPipeline, ...ncPipeline].sort(
        (a, b) => b.files - a.files,
      ),
    };
  });
}

export async function getQueued(
  prisma: PrismaClient,
  userId: string,
  ncUsername: string,
): Promise<QueuedItem[]> {
  return withSwrCache(queuedKey(userId), CACHE_TTL_QUEUED_S, async () => {
    const [brain, nc] = await Promise.all([
      fetchQueued(prisma, userId),
      fetchNcQueued(prisma, ncUsername),
    ]);
    return [...brain, ...nc].sort((a, b) =>
      a.uploadedAt.localeCompare(b.uploadedAt),
    );
  });
}

export async function getFailed(
  prisma: PrismaClient,
  userId: string,
  ncUsername: string,
): Promise<FailedItem[]> {
  return withSwrCache(failedKey(userId), CACHE_TTL_FAILED_S, async () => {
    const [brain, nc] = await Promise.all([
      fetchFailed(prisma, userId),
      fetchNcFailed(prisma, ncUsername),
    ]);
    // Newest attempt first; never-attempted brain rows (null) sink last.
    return [...brain, ...nc].sort((a, b) =>
      (b.lastAttemptedAt ?? "").localeCompare(a.lastAttemptedAt ?? ""),
    );
  });
}

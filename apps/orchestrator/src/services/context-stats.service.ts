/**
 * WARP-225 — per-user context-meter service.
 *
 * Backs the dashboard's home-page <ContextWidget /> + dedicated /context
 * page. All aggregates are scoped by `userId` at the SQL layer; cross-user
 * leakage is structurally impossible (every query has WHERE "userId" = $1).
 *
 * Caching strategy (per spec §Data layer):
 *   - context-stats:<userId>:summary  → 30s   (stat cards + recently indexed)
 *   - context-stats:<userId>:full     → 60s   (deep-dive aggregates)
 *   - context-stats:<userId>:queued   → 5min  (queued drill-down)
 *   - context-stats:<userId>:failed   → 5min  (failed drill-down)
 *
 * Cache invalidation lives in src/services/context-stats-invalidation.ts —
 * it subscribes to `droplet/context-stats/invalidate` MQTT messages from
 * the file-indexer and DELs `context-stats:<userId>:*`.
 *
 * Why TS-side aggregates and not Prisma `groupBy`: the donut and bytes-bar
 * both group by `mime_to_category("mimeType")`, which Prisma's typed query
 * builder can't express. Using $queryRaw keeps the per-query budget at one
 * round-trip and lets the planner fold the IMMUTABLE function inline.
 */

import type { PrismaClient } from "@prisma/client";
import { withSwrCache } from "./cache.service.js";
import { CATEGORY_ORDER, type MimeCategory } from "../lib/mime-category.js";

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

export interface ContextStatsSummary {
  files: number;
  chunks: number;
  queued: number;
  failed: number;
  recentlyIndexed: RecentlyIndexedItem[];
}

export interface RecentlyIndexedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  indexedAt: string; // ISO
  chunkCount: number;
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
  /** null when no row of this category has reached 'ready'. */
  avgSecondsToReady: number | null;
  failed: number;
}

export interface ContextStatsFull extends ContextStatsSummary {
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
}

export interface FailedItem {
  id: string;
  filename: string;
  mimeType: string | null;
  category: MimeCategory;
  failureReason: string | null;
  lastAttemptedAt: string | null;
  recentAttemptCount: number;
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

// ── Aggregate queries ───────────────────────────────────────────────────

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
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT count(*)::bigint AS c
          FROM "FileContentChunk"
         WHERE "userId" = ${userId}`,
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

async function fetchThroughput7d(
  prisma: PrismaClient,
  userId: string,
): Promise<ThroughputDay[]> {
  // Sparse time series — Postgres doesn't synthesize zero-count days, so
  // we backfill on the JS side. The dashboard expects a dense 7-element
  // array (oldest first) for a clean sparkline.
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
  const out: ThroughputDay[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
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
  }));
}

// Local re-export of the lib classifier so the inner helpers don't need
// to plumb the import through every signature. Keeps the module's public
// surface small.
import { mimeToCategory as _mimeToCategory } from "../lib/mime-category.js";
function mimeToCategorySync(mime: string | null | undefined): MimeCategory {
  return _mimeToCategory(mime);
}

// ── Public API ──────────────────────────────────────────────────────────

export async function getSummary(
  prisma: PrismaClient,
  userId: string,
): Promise<ContextStatsSummary> {
  return withSwrCache(summaryKey(userId), CACHE_TTL_SUMMARY_S, async () => {
    const [counts, recentlyIndexed] = await Promise.all([
      fetchCounts(prisma, userId),
      fetchRecentlyIndexed(prisma, userId, 10),
    ]);
    return {
      files: counts.files,
      chunks: counts.chunks,
      queued: counts.queued,
      failed: counts.failed,
      recentlyIndexed,
    };
  });
}

export async function getFull(
  prisma: PrismaClient,
  userId: string,
): Promise<ContextStatsFull> {
  return withSwrCache(fullKey(userId), CACHE_TTL_FULL_S, async () => {
    const [counts, recentlyIndexed, byCategory, throughput7d, pipelineHealth] =
      await Promise.all([
        fetchCounts(prisma, userId),
        fetchRecentlyIndexed(prisma, userId, 10),
        fetchByCategory(prisma, userId),
        fetchThroughput7d(prisma, userId),
        fetchPipelineHealth(prisma, userId),
      ]);
    return {
      files: counts.files,
      chunks: counts.chunks,
      queued: counts.queued,
      failed: counts.failed,
      bytesIndexed: counts.bytes,
      recentlyIndexed,
      byCategory,
      throughput7d,
      pipelineHealth,
    };
  });
}

export async function getQueued(
  prisma: PrismaClient,
  userId: string,
): Promise<QueuedItem[]> {
  return withSwrCache(queuedKey(userId), CACHE_TTL_QUEUED_S, () =>
    fetchQueued(prisma, userId),
  );
}

export async function getFailed(
  prisma: PrismaClient,
  userId: string,
): Promise<FailedItem[]> {
  return withSwrCache(failedKey(userId), CACHE_TTL_FAILED_S, () =>
    fetchFailed(prisma, userId),
  );
}

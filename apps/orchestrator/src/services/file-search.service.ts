/**
 * file-search.service — shared module for the LLM-tool path AND the
 * dashboard `/knowledge` API.
 *
 * Why shared: the spec (§8) calls out that the LLM tool's
 * `search_content` result and the dashboard's `/knowledge` page MUST
 * use the same shape and the same filters so behavior can't drift.
 * One module, two callers.
 *
 * Schema notes:
 *   - `source`, `pageNumber`, `brainItemId`, and `[userId, source,
 *     indexedAt]` columns/index are added in the WARP-203 migration
 *     (`20260428000000_brain_memory`). This service uses those names —
 *     it'll be inert until WARP-203 lands the migration. The unit tests
 *     mock `$queryRawUnsafe` so they don't depend on the live DB shape.
 *   - We use `$queryRawUnsafe` with parameter binding (NOT string
 *     interpolation) for the user-controlled values. The pgvector
 *     literal is interpolated because pg's parameter binder doesn't
 *     accept `vector` as a parameter type — the values themselves are
 *     server-generated floats, not user input.
 */

import type { PrismaClient } from "@prisma/client";

export type FileContentSource = "nextcloud" | "brain";

export interface SearchHit {
  source: FileContentSource;
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  score: number;
  snippet: string;
  brainItemId: string | null;
  /**
   * WARP-214: free-form per-chunk metadata. Carries `chain[]` (recursion
   * breadcrumbs from email/archive extractors) and `subtitle_source`
   * (from the video extractor). Null for legacy rows that pre-date the
   * jsonb column.
   */
  metadata: Record<string, unknown> | null;
}

export interface SearchByVectorParams {
  /** Nextcloud username — the per-user RBAC boundary. */
  userId: string;
  /** Embedding vector. Length must match `FileContentChunk.embedding` (384 for all-MiniLM-L6-v2). */
  vector: number[];
  /** Maximum rows to return (caller-clamped). */
  limit: number;
  /** Cosine-similarity floor. Hits below this are filtered post-query. */
  minSimilarity: number;
  /** Optional: restrict to one source. */
  source?: FileContentSource;
  /** Optional: only chunks indexed at-or-after this timestamp. */
  since?: Date;
}

interface RawSearchRow {
  source: FileContentSource;
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  brainItemId: string | null;
  score: number;
  snippet: string;
  metadata: Record<string, unknown> | null;
}

export async function searchByVector(
  prisma: PrismaClient,
  params: SearchByVectorParams,
): Promise<SearchHit[]> {
  const vec = `[${params.vector.join(",")}]`;
  const where: string[] = [`"userId" = $1`];
  const args: unknown[] = [params.userId];
  let p = 2;
  if (params.source !== undefined) {
    where.push(`source = $${p}::"FileContentSource"`);
    args.push(params.source);
    p++;
  }
  if (params.since !== undefined) {
    where.push(`"indexedAt" >= $${p}`);
    args.push(params.since);
    p++;
  }
  const limitParam = p;
  args.push(params.limit);

  const sql = `
    SELECT source,
           path,
           "chunkIdx",
           "pageNumber",
           "brainItemId",
           LEFT(text, 280) AS snippet,
           metadata,
           1 - (embedding <=> '${vec}'::vector) AS score
    FROM "FileContentChunk"
    WHERE ${where.join(" AND ")}
    ORDER BY embedding <=> '${vec}'::vector
    LIMIT $${limitParam}
  `;
  const rows = await (
    prisma as unknown as {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<RawSearchRow[]>;
    }
  ).$queryRawUnsafe(sql, ...args);

  return rows
    .filter((r) => Number.isFinite(r.score) && r.score >= params.minSimilarity)
    .map((r) => ({
      source: r.source,
      path: r.path,
      chunkIdx: r.chunkIdx,
      pageNumber: r.pageNumber,
      brainItemId: r.brainItemId,
      score: r.score,
      snippet: r.snippet,
      metadata: r.metadata ?? null,
    }));
}

export interface ListRecentParams {
  userId: string;
  limit: number;
  /** Cursor for pagination — return only chunks indexed BEFORE this timestamp. */
  before?: Date;
  source?: FileContentSource;
}

export interface RecentItem {
  source: FileContentSource;
  path: string;
  indexedAt: Date;
  brainItemId: string | null;
  snippet: string;
}

interface RawRecentRow {
  source: FileContentSource;
  path: string;
  indexedAt: Date;
  brainItemId: string | null;
  snippet: string;
}

/**
 * List the most-recently-indexed chunks, deduplicated by `(source, path)`
 * so each file appears once with its newest chunk's snippet. Sorted
 * newest-first.
 *
 * The DISTINCT ON + ORDER BY combination is the canonical Postgres
 * "groupwise maximum" pattern: pick the most recent chunk per file.
 */
export async function listRecent(
  prisma: PrismaClient,
  params: ListRecentParams,
): Promise<RecentItem[]> {
  const where: string[] = [`"userId" = $1`];
  const args: unknown[] = [params.userId];
  let p = 2;
  if (params.before !== undefined) {
    where.push(`"indexedAt" < $${p}`);
    args.push(params.before);
    p++;
  }
  if (params.source !== undefined) {
    where.push(`source = $${p}::"FileContentSource"`);
    args.push(params.source);
    p++;
  }
  const limitParam = p;
  args.push(params.limit);

  const sql = `
    SELECT DISTINCT ON (source, path)
      source,
      path,
      "indexedAt",
      "brainItemId",
      LEFT(text, 280) AS snippet
    FROM "FileContentChunk"
    WHERE ${where.join(" AND ")}
    ORDER BY source, path, "indexedAt" DESC
    LIMIT $${limitParam}
  `;
  const rows = await (
    prisma as unknown as {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<RawRecentRow[]>;
    }
  ).$queryRawUnsafe(sql, ...args);

  // The DISTINCT ON ordering above groups by file; we re-sort by
  // indexedAt DESC for the dashboard's "newest first" expectation,
  // since DISTINCT ON's ORDER BY is for partitioning, not display order.
  return [...rows].sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
}

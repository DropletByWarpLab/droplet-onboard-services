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

import { createHash } from "node:crypto";

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
  /** WARP-437: optional case-sensitive substring match on `path` (SQL LIKE). */
  filenameContains?: string;
}

export interface SearchByLexicalParams {
  /** Nextcloud username — the per-user RBAC boundary. */
  userId: string;
  /** Raw user query string. `websearch_to_tsquery` handles punctuation safely. */
  query: string;
  /** Maximum rows to return (caller-clamped). */
  limit: number;
  /** Optional: restrict to one source. */
  source?: FileContentSource;
  /** Optional: only chunks indexed at-or-after this timestamp. */
  since?: Date;
  /** WARP-437: optional case-sensitive substring match on `path` (SQL LIKE). */
  filenameContains?: string;
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
  if (params.filenameContains !== undefined) {
    where.push(`path LIKE $${p}`);
    args.push(`%${params.filenameContains}%`);
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

/**
 * Lexical (BM25-style) search via Postgres native FTS.
 * Uses `websearch_to_tsquery` (forgiving query parser) and `ts_rank_cd`
 * with normalization flag 32 (mean-of-distance-between-matches) — the
 * closest native-FTS analog to BM25's length-normalization.
 *
 * WARP-286: paired with `searchByVector` and fused via
 * `reciprocalRankFusion` in `searchHybrid`. The interface lets us
 * swap to pg_search (Tantivy) later without changing callers.
 */
export async function searchByLexical(
  prisma: PrismaClient,
  params: SearchByLexicalParams,
): Promise<SearchHit[]> {
  const where: string[] = [
    `"userId" = $1`,
    `"text_tsv" @@ websearch_to_tsquery('english', $2)`,
  ];
  const args: unknown[] = [params.userId, params.query];
  let p = 3;
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
  if (params.filenameContains !== undefined) {
    where.push(`path LIKE $${p}`);
    args.push(`%${params.filenameContains}%`);
    p++;
  }
  const limitParam = p;
  args.push(params.limit);

  const sql = `SELECT
       source, path, "chunkIdx", "pageNumber", "brainItemId", metadata,
       LEFT(text, 280) AS snippet,
       ts_rank_cd("text_tsv", websearch_to_tsquery('english', $2), 32) AS score
     FROM "FileContentChunk"
     WHERE ${where.join(" AND ")}
     ORDER BY score DESC
     LIMIT $${limitParam}`;
  const rows = await (
    prisma as unknown as {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<RawSearchRow[]>;
    }
  ).$queryRawUnsafe(sql, ...args);
  return rows.map((r) => ({
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

/**
 * RRF constant `k`. Cormack et al. 2009 use `k=60` as the canonical
 * value; raising k flattens the rank-decay curve (favors consensus
 * across retrievers), lowering it sharpens it (favors highly-ranked
 * outliers). Tuning knob documented in `docs/RAG_RETRIEVAL.md`.
 */
export const RRF_DEFAULT_K = 60;

/**
 * Reciprocal rank fusion (Cormack et al., 2009). Combines two ranked
 * lists into a single list ordered by the sum of `1 / (k + rank)`
 * contributions from each list. Default k=60 is the canonical value
 * from the original paper.
 *
 * Deduplicates by (source, path, chunkIdx). A chunk in both inputs
 * gets the sum of its two contributions, which is what makes RRF
 * elevate items strongly endorsed by multiple retrievers.
 *
 * WARP-286: bridge between BM25 (lexical) and ANN (vector). The
 * returned `score` field is the RRF score, not the original similarity.
 */
export function reciprocalRankFusion(
  vectorHits: SearchHit[],
  lexicalHits: SearchHit[],
  k: number = RRF_DEFAULT_K,
): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();

  for (const [rank, h] of vectorHits.entries()) {
    const key = `${h.source}:${h.path}:${h.chunkIdx}`;
    scores.set(key, { hit: h, score: 1 / (k + rank) });
  }
  for (const [rank, h] of lexicalHits.entries()) {
    const key = `${h.source}:${h.path}:${h.chunkIdx}`;
    const prev = scores.get(key);
    scores.set(key, {
      hit: prev?.hit ?? h,
      score: (prev?.score ?? 0) + 1 / (k + rank),
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}

export interface RerankerLike {
  rerank(args: {
    query: string;
    passages: string[];
    model?: string;
  }): Promise<{ scores: number[] }>;
}

export interface RedisLike {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<unknown>;
}

export interface RerankPassagesParams {
  query: string;
  hits: SearchHit[];
  /** Redis-like client; abstracted so unit tests can mock without ioredis. */
  redis: RedisLike;
  /** Reranker client (gRPC wrapper) — abstracted so unit tests can mock. */
  reranker: RerankerLike;
  /** Cap per-passage length; bigger values cost more tokens at the model. */
  maxPassageChars?: number;
  /** Cache TTL in seconds. Default `RERANK_DEFAULT_CACHE_TTL_SEC`. */
  cacheTtlSec?: number;
}

/**
 * Max characters of each passage sent to the reranker. Matches the
 * BGE-reranker-base tokenizer's max_length (~512 tokens ≈ 2k chars,
 * but we cap conservatively to keep the wire payload small + the
 * tokenizer truncation step cheap). See `services/ai-gateway/reranker.py`
 * for the model-side constant.
 */
export const RERANK_DEFAULT_MAX_PASSAGE_CHARS = 512;
/**
 * Rerank cache TTL. 5 minutes is the spec value — long enough to absorb
 * a single user's burst of typing/refinement on the same query; short
 * enough that newly-indexed chunks become visible promptly.
 */
export const RERANK_DEFAULT_CACHE_TTL_SEC = 300;
/**
 * How many RRF top candidates to send to the reranker by default.
 * Spec §Pipeline: top-50 of the fused list. Anything beyond is
 * unlikely to be in the answer-set.
 */
export const RERANK_DEFAULT_CANDIDATES = 50;

/**
 * WARP-286 — rerank a set of hits via a cross-encoder.
 *
 * Cached in Redis by `sha256(query || '::' || chunk-id-list)`, TTL
 * `RERANK_DEFAULT_CACHE_TTL_SEC` by default. The cache key includes the
 * chunk-id list so it auto-invalidates when the underlying RRF
 * candidate set changes (e.g. new files indexed).
 *
 * On any error path (Redis down, reranker down, malformed payload) the
 * input hits are returned unchanged so the caller still gets results,
 * just unreranked. This makes a degraded reranker non-fatal.
 *
 * Cryptography note: SHA-256 is a FIPS-approved digest algorithm; the
 * use here is non-security (cache key derivation, not authentication
 * or integrity).
 */
export async function rerankPassages(
  params: RerankPassagesParams,
): Promise<SearchHit[]> {
  const { query, hits, redis, reranker } = params;
  if (hits.length === 0) return [];
  const maxChars = params.maxPassageChars ?? RERANK_DEFAULT_MAX_PASSAGE_CHARS;
  const ttl = params.cacheTtlSec ?? RERANK_DEFAULT_CACHE_TTL_SEC;

  const ids = hits
    .map((h) => `${h.source}:${h.path}:${h.chunkIdx}`)
    .join("|");
  // SHA-256: FIPS-approved digest used as a non-cryptographic cache key.
  const cacheKey =
    "rerank:" +
    createHash("sha256").update(query + "::" + ids).digest("hex");

  // Cache lookup is best-effort — Redis down should not break search.
  let cached: string | null = null;
  try {
    cached = await redis.get(cacheKey);
  } catch {
    cached = null;
  }
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === hits.length &&
        parsed.every((n) => typeof n === "number")
      ) {
        const scores = parsed as number[];
        return hits
          .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
          .sort((a, b) => b.score - a.score);
      }
    } catch {
      // Cache entry malformed — fall through to live call.
    }
  }

  let scores: number[];
  try {
    const passages = hits.map((h) => h.snippet.slice(0, maxChars));
    const resp = await reranker.rerank({ query, passages });
    if (
      !resp ||
      !Array.isArray(resp.scores) ||
      resp.scores.length !== hits.length
    ) {
      return hits;
    }
    scores = resp.scores;
  } catch {
    return hits; // reranker unavailable; pass-through unsorted
  }

  // Cache write is best-effort.
  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(scores));
  } catch {
    // Redis down — return successfully without caching.
  }

  return hits
    .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

export interface SearchHybridRerankOption {
  redis: RedisLike;
  reranker: RerankerLike;
  /** Pre-rerank candidate count from the RRF list. Default `RERANK_DEFAULT_CANDIDATES`. */
  candidates?: number;
  /** Per-passage character cap forwarded to `rerankPassages`. */
  maxPassageChars?: number;
  /** Cache TTL forwarded to `rerankPassages`. */
  cacheTtlSec?: number;
}

/**
 * WARP-437 — query enhancement bundle. When omitted (the default),
 * `searchHybrid` behaves byte-for-byte like the pre-WARP-437 pipeline.
 * Callers (orchestrator's agent loop) own the LLM calls + embedding —
 * by the time these vectors land here they are already computed.
 */
export interface QueryEnhancementOption {
  /**
   * Embedding of a HyDE (hypothetical document) passage. When provided
   * AND length matches `params.vector.length`, the vector arm uses the
   * element-wise mean of `[params.vector, hydeVector]`. Length mismatch
   * silently drops the HyDE term to avoid a dimensional surprise.
   */
  hydeVector?: number[];
  /**
   * Additional query embeddings to run parallel vector arms for. The
   * lexical arm still runs once against `params.query`. Vector arms RRF-
   * fuse together before fusing with lexical.
   */
  extraQueryVectors?: number[][];
  /**
   * Class-derived metadata filter applied to BOTH arms. Today only
   * `filenameContains` is supported.
   */
  metadataFilter?: {
    filenameContains?: string;
  };
}

export interface SearchHybridParams {
  /** Nextcloud username — the per-user RBAC boundary. */
  userId: string;
  /** Embedding vector for the query. */
  vector: number[];
  /** Raw query text for the lexical arm. */
  query: string;
  /** Final result count (caller-clamped). Default `SEARCH_HYBRID_DEFAULT_LIMIT`. */
  limit?: number;
  /** Cosine-similarity floor for the vector arm. Default `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY`. */
  minSimilarity?: number;
  /** How many to pull from each retriever before fusion. Default `SEARCH_HYBRID_DEFAULT_PER_ARM_K`. */
  perArmK?: number;
  source?: FileContentSource;
  since?: Date;
  /**
   * Optional reranker pipe. When omitted, `searchHybrid` returns RRF
   * top-K. When provided, the RRF top-`candidates` is reranked via the
   * cross-encoder and the top-K of that is returned.
   */
  rerank?: SearchHybridRerankOption;
  /** WARP-437 enhancement bundle. Omit for pre-WARP-437 behaviour. */
  queryEnhancement?: QueryEnhancementOption;
}

/**
 * Default candidate count fetched from each retrieval arm (vector + lexical)
 * before RRF fusion. WARP-286 §Pipeline: 100 keeps recall high without
 * blowing up rerank cost (top-50 of fused is reranked downstream).
 */
export const SEARCH_HYBRID_DEFAULT_PER_ARM_K = 100;
/** Caller-facing default result count. */
export const SEARCH_HYBRID_DEFAULT_LIMIT = 10;
/** Cosine-similarity floor for the vector arm of `searchHybrid`. */
export const SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY = 0.3;

/**
 * Hybrid retrieval: parallel BM25 + vector, fused via RRF.
 *
 * WARP-286: this is the v1 caller-facing entrypoint. The reranker
 * step lives in a separate commit (Task 5); for now this returns the
 * RRF top-K. Tests verify the wiring; the eval harness (Task 7)
 * measures quality.
 */
export async function searchHybrid(
  prisma: PrismaClient,
  params: SearchHybridParams,
): Promise<SearchHit[]> {
  const perArmK = params.perArmK ?? SEARCH_HYBRID_DEFAULT_PER_ARM_K;
  const limit = params.limit ?? SEARCH_HYBRID_DEFAULT_LIMIT;

  // WARP-437: HyDE averaging — element-wise mean when dimensions match.
  // Length mismatch silently drops the HyDE term (CLAUDE.md "no guessing":
  // we don't pad/truncate behind the caller's back).
  const enhancement = params.queryEnhancement;
  const effectiveVector =
    enhancement?.hydeVector &&
    enhancement.hydeVector.length === params.vector.length
      ? params.vector.map(
          (v, i) => (v + (enhancement.hydeVector as number[])[i]!) / 2,
        )
      : params.vector;

  // WARP-437: multi-query fan-out. One vector arm per query (raw + extras);
  // single lexical arm against `params.query`.
  const vectorQueries: number[][] = [
    effectiveVector,
    ...(enhancement?.extraQueryVectors ?? []),
  ];
  const filenameContains = enhancement?.metadataFilter?.filenameContains;

  const [vectorHitLists, lexicalHits] = await Promise.all([
    Promise.all(
      vectorQueries.map((vec) =>
        searchByVector(prisma, {
          userId: params.userId,
          vector: vec,
          limit: perArmK,
          minSimilarity:
            params.minSimilarity ?? SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY,
          source: params.source,
          since: params.since,
          filenameContains,
        }),
      ),
    ),
    searchByLexical(prisma, {
      userId: params.userId,
      query: params.query,
      limit: perArmK,
      source: params.source,
      since: params.since,
      filenameContains,
    }),
  ]);

  // Fuse vector arms together first, then fuse the result with lexical.
  // Single-arm fan-out collapses to "RRF of one list vs empty list" — which
  // assigns 1/(k+rank) to every hit, identical to the pre-WARP-437 path.
  const vectorFused = vectorHitLists.reduce(
    (acc, list) => reciprocalRankFusion(acc, list),
    [] as SearchHit[],
  );
  const fused = reciprocalRankFusion(vectorFused, lexicalHits);

  if (params.rerank) {
    const candidatesN =
      params.rerank.candidates ?? RERANK_DEFAULT_CANDIDATES;
    const candidates = fused.slice(0, candidatesN);
    const reranked = await rerankPassages({
      query: params.query,
      hits: candidates,
      redis: params.rerank.redis,
      reranker: params.rerank.reranker,
      maxPassageChars: params.rerank.maxPassageChars,
      cacheTtlSec: params.rerank.cacheTtlSec,
    });
    return reranked.slice(0, limit);
  }
  return fused.slice(0, limit);
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

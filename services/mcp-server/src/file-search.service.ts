/**
 * WARP-286 — hybrid retrieval used by the MCP `search_content` tool.
 *
 * Functionally mirrors `apps/orchestrator/src/services/file-search.service.ts`:
 * the orchestrator's `/knowledge` route and the mcp-server's
 * `search_content` tool consume the same logic. Duplicated (intentionally)
 * because the mcp-server is a standalone process — same rationale as
 * `embedding.client.ts`'s duplication note.
 *
 * Pipeline (when invoked with a reranker pipe):
 *   1. embed(query)              → 384-dim vector
 *   2. parallel:
 *        - vector_search (cosine, k=`perArmK`)
 *        - lexical_search (ts_rank_cd, k=`perArmK`)
 *   3. RRF fusion (k=`RRF_DEFAULT_K`)
 *   4. rerank top-`candidates` via ai-gateway gRPC Rerank
 *   5. return top-K (caller-clamped, default `SEARCH_HYBRID_DEFAULT_LIMIT`)
 *
 * Per-user RBAC is enforced in the SQL itself (`WHERE "userId" = $1`).
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
  metadata: Record<string, unknown> | null;
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

export interface SearchByVectorParams {
  userId: string;
  vector: number[];
  limit: number;
  minSimilarity: number;
  source?: FileContentSource;
  since?: Date;
  /** WARP-437: optional case-sensitive substring match on `path` (SQL LIKE). */
  filenameContains?: string;
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

export interface SearchByLexicalParams {
  userId: string;
  query: string;
  limit: number;
  source?: FileContentSource;
  since?: Date;
  /** WARP-437: optional case-sensitive substring match on `path` (SQL LIKE). */
  filenameContains?: string;
}

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

/** Canonical RRF constant from Cormack et al. 2009. */
export const RRF_DEFAULT_K = 60;

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
  redis: RedisLike;
  reranker: RerankerLike;
  maxPassageChars?: number;
  cacheTtlSec?: number;
}

export const RERANK_DEFAULT_MAX_PASSAGE_CHARS = 512;
export const RERANK_DEFAULT_CACHE_TTL_SEC = 300;
export const RERANK_DEFAULT_CANDIDATES = 50;

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
      // malformed cache entry — fall through
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
    return hits;
  }

  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(scores));
  } catch {
    // Redis down — return ranked output anyway
  }

  return hits
    .map((h, i) => ({ ...h, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
}

export const SEARCH_HYBRID_DEFAULT_PER_ARM_K = 100;
export const SEARCH_HYBRID_DEFAULT_LIMIT = 10;
export const SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY = 0.3;

export interface SearchHybridRerankOption {
  redis: RedisLike;
  reranker: RerankerLike;
  candidates?: number;
  maxPassageChars?: number;
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
  userId: string;
  vector: number[];
  query: string;
  limit?: number;
  minSimilarity?: number;
  perArmK?: number;
  source?: FileContentSource;
  since?: Date;
  rerank?: SearchHybridRerankOption;
  /** WARP-437 enhancement bundle. Omit for pre-WARP-437 behaviour. */
  queryEnhancement?: QueryEnhancementOption;
}

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

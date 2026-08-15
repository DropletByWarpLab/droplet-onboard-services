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
 * Per-user RBAC is enforced in the SQL itself (`WHERE "userId" = $1`,
 * expanding to `"userId" IN (...)` when the caller passes extra owner
 * keys — see `additionalUserIds`).
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { decryptColumn, isEncryptedColumn } from "./column-crypto.service.js";
import { getDeksByIds } from "./document-key.service.js";

export type FileContentSource = "nextcloud" | "brain";

/** Snippet width shared by the SQL LEFT() arm and the post-decrypt truncate. */
export const CHUNK_SNIPPET_CHARS = 280;

/**
 * WARP-242 — snippet projection that survives encryption-at-rest. Brain
 * chunks (sensitivity=sensitive) hold a dcv1 AES-256-GCM blob in `text`;
 * truncating ciphertext destroys it, so encrypted rows are selected whole
 * and re-truncated app-side after decrypt-on-read. Plaintext rows keep the
 * cheap LEFT() snippet. Mirrors the orchestrator's file-search.service.ts.
 */
const SNIPPET_SQL = `CASE WHEN "sensitivity" = 'sensitive' THEN text ELSE LEFT(text, ${CHUNK_SNIPPET_CHARS}) END AS snippet`;

/**
 * WARP-242 — decrypt-on-read for retrieval hits (DEKs keyed
 * `brain:<brainItemId>`). Rows whose ciphertext cannot be read (DEK
 * crypto-shredded — e.g. a restored backup carrying chunks for a deleted
 * document — or an authentication failure) are DROPPED with a warn log:
 * surfacing base64 garbage to the LLM would be worse than one fewer hit.
 */
async function decryptSnippets(
  prisma: PrismaClient,
  rows: SearchHit[],
): Promise<SearchHit[]> {
  const encrypted = rows.filter((r) => isEncryptedColumn(r.snippet));
  if (encrypted.length === 0) return rows;
  const keyIds = [
    ...new Set(
      encrypted.flatMap((r) => (r.brainItemId ? [`brain:${r.brainItemId}`] : [])),
    ),
  ];
  const deks = await getDeksByIds(prisma, keyIds);
  const out: SearchHit[] = [];
  for (const r of rows) {
    if (!isEncryptedColumn(r.snippet)) {
      out.push(r);
      continue;
    }
    const keyId = r.brainItemId ? `brain:${r.brainItemId}` : null;
    const dek = keyId ? deks.get(keyId) : undefined;
    if (!dek) {
      console.warn("chunk.unreadable.dek_missing", { path: r.path, keyId });
      continue;
    }
    try {
      out.push({
        ...r,
        snippet: decryptColumn(dek, r.snippet, keyId!).slice(0, CHUNK_SNIPPET_CHARS),
      });
    } catch (e) {
      console.warn("chunk.unreadable.decrypt_failed", {
        path: r.path,
        keyId,
        error: String(e),
      });
    }
  }
  return out;
}

/**
 * Defense-in-depth guard for the ONE string-interpolated fragment in these
 * queries: the pgvector literal `'[...]'::vector` is built by joining the
 * embedding array (everything else — query text, filename filter, limit —
 * is parameterized). Today `vector` is always embedder-produced floats, so
 * this is not currently attacker-controlled — but there is no compile-time
 * guarantee that every element is finite. A `NaN`/`Infinity`/non-number
 * slipping in from a malformed embedder response, or a future caller wiring
 * a less-trusted source into the enhancement vectors, would land directly
 * in raw SQL. Reject before we ever build the literal. (TOOLS-09)
 */
function assertFiniteVector(vec: number[], label = "vector"): void {
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error(`file-search: ${label} must be a non-empty number[]`);
  }
  for (let i = 0; i < vec.length; i++) {
    if (typeof vec[i] !== "number" || !Number.isFinite(vec[i])) {
      throw new Error(
        `file-search: ${label}[${i}] is not a finite number — refusing to interpolate into SQL`,
      );
    }
  }
}

/**
 * WARP-1603 — the scale a `SearchHit.score` is expressed in.
 *
 *   - "similarity" — bounded in [0, 1]: a cosine similarity, an RRF fusion
 *     weight, or a reranker score already normalized by `rerankPassages`.
 *   - "logit"      — an unbounded cross-encoder output. Reserved for
 *     producers that deliberately emit raw logits; nothing in this file
 *     does any more.
 *
 * The field exists so consumers stop INFERRING the scale from the value.
 * The dashboard used to guess "> 1 means logit", which silently clamped
 * BGE-reranker-base's (mostly negative) logits to a 0% relevance chip.
 */
export type ScoreKind = "logit" | "similarity";

export interface SearchHit {
  source: FileContentSource;
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  score: number;
  /**
   * WARP-1603 — scale of `score`. OPTIONAL for backward compatibility:
   * hits produced before this field existed (and any consumer that
   * predates it) must keep working, so absent means "unknown, fall back
   * to the consumer's inference".
   */
  scoreKind?: ScoreKind;
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

/**
 * WARP-1014 — build the `"userId"` predicate for one-or-more chunk-owner
 * keys. A single owner keeps the historical `"userId" = $1` shape;
 * multiple owners expand to an `IN ($1, $2, …)` list with one bind
 * parameter per id. Returns the SQL fragment and the next free parameter
 * position. Mirrors the orchestrator's WARP-1140 helper
 * (`apps/orchestrator/src/services/file-search.service.ts`).
 */
function buildUserIdPredicate(
  userId: string,
  additionalUserIds: string[] | undefined,
  args: unknown[],
): { predicate: string; nextParam: number } {
  const ids = [userId, ...(additionalUserIds ?? [])];
  const placeholders = ids.map((_, i) => `$${i + 1}`);
  args.push(...ids);
  const predicate =
    ids.length === 1
      ? `"userId" = $1`
      : `"userId" IN (${placeholders.join(", ")})`;
  return { predicate, nextParam: ids.length + 1 };
}

export interface SearchByVectorParams {
  userId: string;
  /**
   * WARP-1014: extra chunk-owner keys to search IN ADDITION to `userId`.
   * The `search_content` shim passes the caller's other post-WARP-493
   * key shape (username ⟷ User.id UUID — see `chunk-owner.ts`) so brain
   * and nextcloud chunks stay visible side by side. Identity is resolved
   * by the caller, never here.
   */
  additionalUserIds?: string[];
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
  assertFiniteVector(params.vector);
  const vec = `[${params.vector.join(",")}]`;
  const args: unknown[] = [];
  const { predicate, nextParam } = buildUserIdPredicate(
    params.userId,
    params.additionalUserIds,
    args,
  );
  const where: string[] = [predicate];
  let p = nextParam;
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
           ${SNIPPET_SQL},
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

  const hits = rows
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
  // WARP-242: decrypt-on-read BEFORE fusion/rerank so every downstream
  // consumer (RRF, cross-encoder passages, LLM tool result) sees plaintext.
  return decryptSnippets(prisma, hits);
}

export interface SearchByLexicalParams {
  userId: string;
  /** WARP-1014: extra chunk-owner keys (see SearchByVectorParams.additionalUserIds). */
  additionalUserIds?: string[];
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
  const args: unknown[] = [];
  const { predicate, nextParam } = buildUserIdPredicate(
    params.userId,
    params.additionalUserIds,
    args,
  );
  const queryParam = nextParam;
  const where: string[] = [
    predicate,
    `"text_tsv" @@ websearch_to_tsquery('english', $${queryParam})`,
  ];
  args.push(params.query);
  let p = queryParam + 1;
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
       ${SNIPPET_SQL},
       ts_rank_cd("text_tsv", websearch_to_tsquery('english', $${queryParam}), 32) AS score
     FROM "FileContentChunk"
     WHERE ${where.join(" AND ")}
     ORDER BY score DESC
     LIMIT $${limitParam}`;
  const rows = await (
    prisma as unknown as {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<RawSearchRow[]>;
    }
  ).$queryRawUnsafe(sql, ...args);
  const hits = rows.map((r) => ({
    source: r.source,
    path: r.path,
    chunkIdx: r.chunkIdx,
    pageNumber: r.pageNumber,
    brainItemId: r.brainItemId,
    score: r.score,
    snippet: r.snippet,
    metadata: r.metadata ?? null,
  }));
  // WARP-242: encrypted chunks have a NULL text_tsv (generated column) so
  // they can't match this arm — the decrypt pass is defensive parity with
  // searchByVector, not a hot path.
  return decryptSnippets(prisma, hits);
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

/**
 * WARP-1603 — logistic squash applied to raw cross-encoder logits.
 *
 * ai-gateway's `reranker.py` returns `outputs.logits` verbatim (no
 * sigmoid), and BGE-reranker-base emits NEGATIVE logits for all but a
 * strong match. Handing that raw number to a UI that expects a 0-1
 * relevance is what made every chat citation chip read 0%.
 *
 * Normalizing here rather than in the renderer:
 *   - the scale is a property of the MODEL, and this is the only place
 *     that knows which model produced the number;
 *   - sigmoid is strictly monotonic, so the rerank ORDER is untouched —
 *     `sort` below produces the identical ranking either way;
 *   - every downstream consumer (the `search_content` tool payload, the
 *     chat citation chips, /knowledge) gets one comparable scale instead
 *     of each guessing independently.
 */
export function normalizeRerankScore(logit: number): number {
  if (!Number.isFinite(logit)) return 0;
  return 1 / (1 + Math.exp(-logit));
}

/**
 * WARP-1603 — stamp `scoreKind: "similarity"` on hits whose score is
 * already bounded in [0, 1] (cosine hits, RRF fusion output, and the
 * rerank-failure pass-through). Pure tagging: the numbers are untouched.
 */
function tagSimilarity(hits: SearchHit[]): SearchHit[] {
  return hits.map((h) => ({ ...h, scoreKind: "similarity" as const }));
}

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
        // WARP-1603: the cache holds RAW logits (that's what the reranker
        // returned and what `setex` below still writes), so entries
        // written by a pre-WARP-1603 build stay readable — normalization
        // happens on the way out, exactly once.
        return hits
          .map((h, i) => ({
            ...h,
            // WARP-1637: `?? -Infinity`, not `?? 0`. The branch is
            // unreachable while the length check above holds, but a MISSING
            // score normalized from 0 would read as a confident 50%.
            // -Infinity normalizes to 0, so a gap fails quietly-low rather
            // than quietly-plausible.
            score: normalizeRerankScore(scores[i] ?? -Infinity),
            scoreKind: "similarity" as const,
          }))
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
      // Rerank unusable — the incoming RRF scores stand. They are already
      // bounded small positives, so tag them as such (WARP-1603).
      return tagSimilarity(hits);
    }
    scores = resp.scores;
  } catch {
    return tagSimilarity(hits);
  }

  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(scores));
  } catch {
    // Redis down — return ranked output anyway
  }

  return hits
    .map((h, i) => ({
      ...h,
      // WARP-1603: raw logit → 0-1 relevance. Monotonic, so the sort
      // below yields the same order the raw logits would have.
      // WARP-1637: `-Infinity` for a gap — see the cached branch above.
      score: normalizeRerankScore(scores[i] ?? -Infinity),
      scoreKind: "similarity" as const,
    }))
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
  /** WARP-1014: extra chunk-owner keys (see SearchByVectorParams.additionalUserIds). */
  additionalUserIds?: string[];
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
  // TOOLS-09: validate the enhancement vectors at the boundary so a bad
  // input fails with context here rather than deep inside searchByVector's
  // SQL-literal build. (searchByVector also guards its own input as the
  // load-bearing check, covering every other caller.)
  if (enhancement?.hydeVector) assertFiniteVector(enhancement.hydeVector, "hydeVector");
  (enhancement?.extraQueryVectors ?? []).forEach((v, i) =>
    assertFiniteVector(v, `extraQueryVectors[${i}]`),
  );
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
          additionalUserIds: params.additionalUserIds,
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
      additionalUserIds: params.additionalUserIds,
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
  // WARP-1603 — no rerank arm: RRF weights are already bounded 0-1, so
  // tag them rather than leaving the consumer to infer the scale.
  return tagSimilarity(fused.slice(0, limit));
}

// ── whole-document read ────────────────────────────────────────────────

/**
 * Row cap per call. The char budget is the real limiter, but it can only
 * be applied AFTER decrypt (ciphertext length tells you nothing about
 * plaintext length), so SQL needs its own bound to keep a 500-page scan
 * from being materialized in one go.
 */
const READ_DOC_MAX_ROWS = 200;
/** Pessimistic chars-per-chunk used to turn a char budget into a row
 *  limit. Deliberately low: over-fetching a few rows is cheap, while
 *  under-fetching would silently short a caller who asked for more. */
const READ_DOC_MIN_CHUNK_CHARS = 100;

export interface ReadDocumentTextParams {
  userId: string;
  /** WARP-1014: extra chunk-owner keys (see SearchByVectorParams.additionalUserIds). */
  additionalUserIds?: string[];
  path: string;
  /** 0-based chunk index to resume from. */
  startChunk: number;
  /** Approximate character budget; whole chunks are always returned. */
  maxChars: number;
}

export interface ReadDocumentTextResult {
  source: FileContentSource;
  chunks: Array<{
    chunkIdx: number;
    pageNumber: number | null;
    text: string;
    warnings: string[];
  }>;
  /** Total chunks for this path, ignoring the window. 0 ⇒ not indexed. */
  totalChunks: number;
  /** Chunks dropped in this window because their DEK is gone or failed auth. */
  unreadableChunks: number;
  /**
   * Where a follow-up call should resume, or null when the document is
   * exhausted. Computed HERE, not by the caller, because only this
   * function knows which rows the window actually examined.
   *
   * The distinction matters when every row in a window is undecryptable:
   * `chunks` comes back empty, and a caller deriving "resume after the
   * last returned chunk" would hand back the offset it was already given
   * and spin on that window forever.
   */
  nextChunk: number | null;
}

interface RawChunkRow {
  source: FileContentSource;
  chunkIdx: number;
  pageNumber: number | null;
  brainItemId: string | null;
  text: string;
  warnings: string[] | null;
}

/**
 * Ordered whole-document read backing the `read_document_text` tool.
 *
 * Same RBAC predicate and same decrypt-on-read as the search arms — which
 * is the point of putting it in this file rather than in the tool handler.
 * It differs from those arms in one way that matters: it selects `text`
 * WHOLE. `SNIPPET_SQL` truncates to 280 chars for a citation chip, which
 * is precisely wrong when the caller's purpose is to read the document, so
 * this path must not reuse it (nor `decryptSnippets`, which re-truncates
 * after decrypt).
 *
 * `totalChunks` is counted independently of the window so the caller can
 * tell apart three states an empty `chunks` array would otherwise blur:
 * not indexed at all (0), a valid but exhausted window, and a window whose
 * every row was undecryptable.
 */
export async function readDocumentText(
  prisma: PrismaClient,
  params: ReadDocumentTextParams,
): Promise<ReadDocumentTextResult> {
  const countArgs: unknown[] = [];
  const { predicate: countPredicate, nextParam: countNext } = buildUserIdPredicate(
    params.userId,
    params.additionalUserIds,
    countArgs,
  );
  countArgs.push(params.path);
  const countRows = await (
    prisma as unknown as {
      $queryRawUnsafe: (
        sql: string,
        ...p: unknown[]
      ) => Promise<Array<{ count: bigint | number }>>;
    }
  ).$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS count FROM "FileContentChunk"
     WHERE ${countPredicate} AND path = $${countNext}`,
    ...countArgs,
  );
  const totalChunks = Number(countRows[0]?.count ?? 0);
  if (totalChunks === 0) {
    return {
      source: "nextcloud",
      chunks: [],
      totalChunks: 0,
      unreadableChunks: 0,
      nextChunk: null,
    };
  }

  const args: unknown[] = [];
  const { predicate, nextParam } = buildUserIdPredicate(
    params.userId,
    params.additionalUserIds,
    args,
  );
  let p = nextParam;
  const pathParam = p++;
  args.push(params.path);
  const startParam = p++;
  args.push(params.startChunk);
  const limitParam = p++;
  args.push(
    Math.min(
      READ_DOC_MAX_ROWS,
      Math.ceil(params.maxChars / READ_DOC_MIN_CHUNK_CHARS) + 1,
    ),
  );

  const sql = `
    SELECT source,
           "chunkIdx",
           "pageNumber",
           "brainItemId",
           text,
           warnings
    FROM "FileContentChunk"
    WHERE ${predicate} AND path = $${pathParam} AND "chunkIdx" >= $${startParam}
    ORDER BY "chunkIdx" ASC
    LIMIT $${limitParam}
  `;
  const rows = await (
    prisma as unknown as {
      $queryRawUnsafe: (sql: string, ...p: unknown[]) => Promise<RawChunkRow[]>;
    }
  ).$queryRawUnsafe(sql, ...args);

  // WARP-242: decrypt-on-read, keeping the FULL plaintext. Rows whose DEK
  // is missing or fails authentication are dropped and counted — handing
  // the model base64 garbage would be worse than a reported hole.
  const encrypted = rows.filter((r) => isEncryptedColumn(r.text));
  const deks = encrypted.length
    ? await getDeksByIds(prisma, [
        ...new Set(
          encrypted.flatMap((r) => (r.brainItemId ? [`brain:${r.brainItemId}`] : [])),
        ),
      ])
    : new Map<string, Buffer>();

  const chunks: ReadDocumentTextResult["chunks"] = [];
  let unreadableChunks = 0;
  let used = 0;
  // The chunkIdx of the last row this window CONSUMED — admitted or
  // dropped. Not the same as the last row returned: a window whose rows
  // were all undecryptable consumes them and returns none, and resuming
  // from the last *returned* chunk would replay the same window forever.
  let consumedThrough: number | null = null;
  for (const r of rows) {
    let text = r.text;
    if (isEncryptedColumn(text)) {
      const keyId = r.brainItemId ? `brain:${r.brainItemId}` : null;
      const dek = keyId ? deks.get(keyId) : undefined;
      if (!dek) {
        console.warn("chunk.unreadable.dek_missing", { path: params.path, keyId });
        unreadableChunks++;
        consumedThrough = r.chunkIdx;
        continue;
      }
      try {
        text = decryptColumn(dek, text, keyId!);
      } catch (e) {
        console.warn("chunk.unreadable.decrypt_failed", {
          path: params.path,
          keyId,
          error: String(e),
        });
        unreadableChunks++;
        consumedThrough = r.chunkIdx;
        continue;
      }
    }
    // Budget check AFTER decrypt, and always admit the first chunk: a
    // single chunk larger than the whole budget must still make progress,
    // or a caller paging with `next_chunk` would loop on it forever.
    if (chunks.length > 0 && used + text.length > params.maxChars) break;
    chunks.push({
      chunkIdx: r.chunkIdx,
      pageNumber: r.pageNumber,
      text,
      warnings: r.warnings ?? [],
    });
    used += text.length;
    consumedThrough = r.chunkIdx;
  }

  // An empty row set means the window found nothing at or past startChunk,
  // so there is nothing further to resume from even though totalChunks > 0
  // (reachable when chunkIdx numbering is sparse). Terminate rather than
  // hand back an offset that would return empty again.
  const nextChunk =
    consumedThrough !== null && consumedThrough + 1 < totalChunks
      ? consumedThrough + 1
      : null;

  return {
    source: rows[0]?.source ?? "nextcloud",
    chunks,
    totalChunks,
    unreadableChunks,
    nextChunk,
  };
}

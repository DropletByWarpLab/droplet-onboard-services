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

import { AnchorSchema, type Anchor } from "@droplet/shared-types";

import { createLogger } from "../lib/logger.js";
import { decryptColumn, isEncryptedColumn } from "./column-crypto.service.js";
import { getDeksByIds } from "./document-key.service.js";

const logger = createLogger("file-search");

export type FileContentSource = "nextcloud" | "brain";

/** Snippet width shared by the SQL LEFT() arm and the post-decrypt truncate. */
export const CHUNK_SNIPPET_CHARS = 280;

/**
 * WARP-242 — snippet projection that survives encryption-at-rest. Brain
 * chunks (sensitivity=sensitive) hold a dcv1 AES-256-GCM blob in `text`;
 * truncating ciphertext destroys it, so encrypted rows are selected whole
 * and re-truncated app-side after decrypt-on-read. Plaintext rows keep the
 * cheap LEFT() snippet.
 */
const SNIPPET_SQL = `CASE WHEN "sensitivity" = 'sensitive' THEN text ELSE LEFT(text, ${CHUNK_SNIPPET_CHARS}) END AS snippet`;

/**
 * WARP-242 — batch-fetch the per-document DEKs needed to read a row set.
 * Chunk DEKs are keyed `brain:<brainItemId>` (see DocumentEncryptionKey).
 */
async function deksForRows(
  prisma: PrismaClient,
  rows: Array<{ brainItemId: string | null }>,
): Promise<Map<string, Buffer>> {
  const keyIds = [
    ...new Set(
      rows.flatMap((r) => (r.brainItemId ? [`brain:${r.brainItemId}`] : [])),
    ),
  ];
  return getDeksByIds(prisma, keyIds);
}

/**
 * WARP-242 — decrypt-on-read for retrieval hits. Rows whose ciphertext
 * cannot be read (DEK crypto-shredded — e.g. a restored backup carrying
 * chunks for a deleted document — or an authentication failure) are DROPPED
 * with a warn log: surfacing base64 garbage to the LLM/dashboard would be
 * worse than one fewer hit.
 */
async function decryptSnippets<
  T extends { snippet: string; brainItemId: string | null; path: string },
>(prisma: PrismaClient, rows: T[]): Promise<T[]> {
  const encrypted = rows.filter((r) => isEncryptedColumn(r.snippet));
  if (encrypted.length === 0) return rows;
  const deks = await deksForRows(prisma, encrypted);
  const out: T[] = [];
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
 * WARP-242 — decrypt-on-read for full chunk rows (`text` column), shared by
 * the /knowledge list route and the chat attachment-context builder. Same
 * drop-unreadable semantics as {@link decryptSnippets}, without truncation.
 */
export async function decryptChunkRows<
  T extends { text: string; brainItemId: string | null; path: string },
>(prisma: PrismaClient, rows: T[]): Promise<T[]> {
  const encrypted = rows.filter((r) => isEncryptedColumn(r.text));
  if (encrypted.length === 0) return rows;
  const deks = await deksForRows(prisma, encrypted);
  const out: T[] = [];
  for (const r of rows) {
    if (!isEncryptedColumn(r.text)) {
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
      out.push({ ...r, text: decryptColumn(dek, r.text, keyId!) });
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
 * The scale a `SearchHit.score` is expressed in.
 *   - "similarity" — already bounded in [0, 1] (cosine, RRF fusion output,
 *     or a source-normalized reranker relevance). Rendered as-is.
 *   - "logit"      — an unbounded cross-encoder output. Reserved for
 *     producers that deliberately emit raw logits; nothing in this file
 *     does any more.
 *
 * WARP-1637: mirrors `ScoreKind` in `services/mcp-server/src/file-search.service.ts`
 * and `packages/tools-core/src/types.ts`. This copy of the service never got
 * WARP-1603's normalization, so `/knowledge` kept shipping raw logits
 * untagged and the renderer kept guessing — a logit of 0.0 renders as 0%,
 * the exact complaint WARP-1603 was raised to fix.
 */
export type ScoreKind = "logit" | "similarity";

export interface SearchHit {
  source: FileContentSource;
  path: string;
  chunkIdx: number;
  pageNumber: number | null;
  score: number;
  /**
   * WARP-1637 — scale of `score`. OPTIONAL for backward compatibility: hits
   * produced before this field existed (and any consumer that predates it)
   * must keep working, so absent means "unknown, fall back to the consumer's
   * inference" (`inferScoreKind` in the dashboard's `lib/relevance.ts`).
   */
  scoreKind?: ScoreKind;
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
  /**
   * WARP-1140: extra index owners to search IN ADDITION to `userId`. Two
   * caller classes today: the Files search route passes the `__household__`
   * sentinel (shared groupfolder corpus) after confirming the requesting user
   * actually has the shared space mounted, and the `/knowledge` search route
   * passes the caller's `User.id` UUID (WARP-1014 dual-shape reads — brain
   * chunks are UUID-keyed post-WARP-493). Membership/identity is checked by
   * the caller, never here.
   */
  additionalUserIds?: string[];
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
  /**
   * WARP-2193: optional observer for the candidate funnel. See
   * {@link VectorCandidateStats} — the same numbers go out as a `debug`
   * log line on every call, this is for callers that want to assert on
   * them or feed them to the eval harness.
   */
  onCandidates?: (stats: VectorCandidateStats) => void;
}

/**
 * WARP-2193 — how many candidates survived each stage of the vector arm.
 *
 * The arm fetches `limit` rows and then discards everything below
 * `minSimilarity` in JS, so from outside "12 results" looks identical
 * whether it came from 12 candidates or from 100. That makes a recall change
 * unmeasurable, which is how the missing index went unnoticed for four
 * months. These four counts are the whole funnel.
 */
export interface VectorCandidateStats {
  /** Rows the SQL LIMIT asked for — `perArmK` when the caller is `searchHybrid`. */
  requested: number;
  /** Rows Postgres actually returned. Short of `requested` means the corpus ran out. */
  returned: number;
  /** Survivors of the client-side `minSimilarity` floor. */
  aboveFloor: number;
  /** Survivors after decrypt-on-read drops rows whose DEK is gone (WARP-242). */
  readable: number;
  /** The `hnsw.ef_search` this query ran under. */
  efSearch: number;
  /** The floor that produced `aboveFloor`, echoed so a log line stands alone. */
  minSimilarity: number;
}

export interface SearchByLexicalParams {
  /** Nextcloud username — the per-user RBAC boundary. */
  userId: string;
  /** WARP-1140: extra index owners (see SearchByVectorParams.additionalUserIds). */
  additionalUserIds?: string[];
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

/**
 * WARP-1140 — build the `"userId"` predicate for one-or-more index owners.
 * Single owner keeps the historical `"userId" = $1` shape; multiple owners
 * expand to an `IN ($1, $2, …)` list with one bind parameter per id (no
 * driver-specific array binding). Returns the SQL fragment and the next free
 * parameter position.
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
 * WARP-2193 — the floor for `hnsw.ef_search`.
 *
 * `ef_search` is the size of the dynamic candidate list pgvector's HNSW walk
 * keeps as it descends the graph. Recall collapses when it is smaller than
 * the number of rows the query asks for, because the walk has nowhere to hold
 * them. pgvector's default is 40 and this arm asks for
 * `SEARCH_HYBRID_DEFAULT_PER_ARM_K` (100) rows per call, so the default would
 * quietly cap the vector arm at less than half the candidates it requested.
 *
 * 100 rather than 40 as a floor, matching the arm's own default budget: a
 * caller asking for fewer rows still benefits from a wider walk, and the cost
 * of a slightly larger candidate list on a corpus this size is noise.
 */
export const HNSW_EF_SEARCH_FLOOR = 100;

/**
 * pgvector rejects `hnsw.ef_search` above 1000 (`ERROR: 1001 is outside the
 * valid range for parameter "hnsw.ef_search"`). Clamping here turns a caller
 * asking for an absurd `limit` into a slightly-less-exhaustive search rather
 * than a failed query.
 */
export const HNSW_EF_SEARCH_CEILING = 1000;

/**
 * WARP-2193 — size `hnsw.ef_search` off the caller's own row budget rather
 * than hardcoding it. `limit` IS `perArmK` when the caller is `searchHybrid`,
 * so raising `perArmK` widens the graph walk to match instead of silently
 * asking for more rows than the walk can produce.
 *
 * Total function on purpose: the result is interpolated into SQL (see
 * `searchByVector`), so it must be incapable of returning anything but an
 * integer inside pgvector's range, for any input.
 */
export function hnswEfSearchFor(limit: number): number {
  const wanted = Number.isFinite(limit)
    ? Math.trunc(limit)
    : HNSW_EF_SEARCH_FLOOR;
  return Math.min(
    HNSW_EF_SEARCH_CEILING,
    Math.max(HNSW_EF_SEARCH_FLOOR, wanted),
  );
}

/**
 * WARP-2193 — the transaction the vector arm's SELECT runs in.
 *
 * ## No isolation level, deliberately
 *
 * `lib/prisma-tx.ts` exports two levels and says every call site should name
 * one. Neither describes this transaction, and it is worth being exact about
 * why rather than picking the nearest:
 *
 *   - the serializable one is for CHECK-THEN-WRITE mutations. This writes
 *     nothing at all.
 *   - the repeatable-read one is for MULTI-STATEMENT READS that compose one
 *     answer, where a commit landing between two of them yields a view that
 *     never existed. There is exactly ONE read in here.
 *
 * With a single statement, READ COMMITTED and REPEATABLE READ take the same
 * snapshot and are indistinguishable. This transaction exists ONLY to give
 * `SET LOCAL` a scope — SET LOCAL outside a transaction block is a no-op, see
 * `searchByVector` — not to protect an invariant. Naming a level would assert
 * a guarantee that is not load-bearing, and it would pull four suites into
 * the WARP-1570 seam gate, one of which (`department-security.suite.test.ts`)
 * mocks this module out entirely and can never reach this code path.
 *
 * The two constants are described rather than spelled out on purpose: that
 * gate (`__tests__/prisma-tx-seam-adoption.test.ts`) derives its scope by
 * matching those identifiers ANYWHERE in a module's text, so writing them
 * here — in the comment explaining why they do NOT apply — would put this
 * module in scope on the strength of a comment. Go read `lib/prisma-tx.ts`;
 * it is short and it is the one home for both.
 *
 * If a second read ever joins this transaction, that changes: take the
 * repeatable-read constant then, and migrate the suites the gate names.
 *
 * ## Why the explicit timeouts
 *
 * They PRESERVE the pre-WARP-2193 behaviour rather than change it. The SELECT
 * used to be a bare `$queryRawUnsafe` with no cap at all; Prisma's
 * interactive-transaction defaults (maxWait 2s, timeout 5s) would have turned
 * a slow-but-succeeding search on a large corpus into a P2028 abort.
 */
const VECTOR_SEARCH_TX = {
  maxWait: 5_000,
  timeout: 30_000,
} as const;

export async function searchByVector(
  prisma: PrismaClient,
  params: SearchByVectorParams,
): Promise<SearchHit[]> {
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
  // WARP-2193 — the SELECT runs INSIDE an interactive transaction, and it has
  // to. Postgres treats `SET LOCAL` outside a transaction block as a no-op: it
  // emits a warning and moves on. Issued on the top-level client this
  // statement would be accepted, discarded, and the graph walk would keep
  // running at pgvector's default ef_search of 40 — the fix would read as
  // landed and do nothing.
  //
  // SET LOCAL rather than SET, so the setting dies with the transaction and
  // cannot leak onto the next borrower of this pooled connection.
  //
  // `efSearch` is interpolated because a GUC name/value is not a bindable
  // parameter position; `hnswEfSearchFor` is total and returns an integer in
  // [100, 1000] for every input, so nothing else can reach this string.
  const efSearch = hnswEfSearchFor(params.limit);
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    return tx.$queryRawUnsafe<RawSearchRow[]>(sql, ...args);
  }, VECTOR_SEARCH_TX);

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
  //
  // Deliberately OUTSIDE the transaction above: the DEK lookups and AES work
  // have nothing to do with the snapshot, and holding a pooled connection
  // through them would make the vector arm's connection cost proportional to
  // how much of the corpus is encrypted.
  const readable = await decryptSnippets(prisma, hits);

  // WARP-2193 — the candidate funnel, so a recall change is measurable rather
  // than assumed. `debug` level: silent at the default `info`, and the shape
  // is stable enough to grep when someone turns it up.
  const stats: VectorCandidateStats = {
    requested: params.limit,
    returned: rows.length,
    aboveFloor: hits.length,
    readable: readable.length,
    efSearch,
    minSimilarity: params.minSimilarity,
  };
  logger.debug(stats, "search.vector.candidates");
  params.onCandidates?.(stats);

  return readable;
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
  const rows = await prisma.$queryRawUnsafe<RawSearchRow[]>(sql, ...args);
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
/**
 * WARP-1637 (porting WARP-1603) — squash a raw cross-encoder logit into a
 * 0-1 relevance.
 *
 * Normalizing here rather than in the renderer:
 *   - the scale is a property of the MODEL, and this is the only place that
 *     knows which model produced the number;
 *   - sigmoid is strictly monotonic, so the rerank ORDER is untouched — the
 *     `sort` below produces the identical ranking either way;
 *   - every downstream consumer gets one comparable scale instead of each
 *     guessing independently.
 */
export function normalizeRerankScore(logit: number): number {
  if (!Number.isFinite(logit)) return 0;
  return 1 / (1 + Math.exp(-logit));
}

/**
 * WARP-1637 — stamp `scoreKind: "similarity"` on hits whose score is already
 * bounded in [0, 1] (cosine hits, RRF fusion output, and the rerank-failure
 * pass-throughs). Pure tagging: the numbers are untouched.
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
        // WARP-1637: the cache holds RAW logits (that's what the reranker
        // returned and what `setex` below still writes), so entries written
        // by a pre-fix build stay readable — normalization happens on the way
        // out, exactly once.
        //
        // `?? -Infinity` (not `?? 0`): the branch is unreachable while the
        // length check above holds, but a MISSING score normalized from 0
        // would read as a confident 50%. -Infinity normalizes to 0, so a
        // gap fails quietly-low instead of quietly-plausible.
        return hits
          .map((h, i) => ({
            ...h,
            score: normalizeRerankScore(scores[i] ?? -Infinity),
            scoreKind: "similarity" as const,
          }))
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
      // Rerank unusable — the incoming RRF scores stand. They are already
      // bounded small positives, so tag them as such (WARP-1637).
      return tagSimilarity(hits);
    }
    scores = resp.scores;
  } catch {
    // reranker unavailable; pass-through unsorted
    return tagSimilarity(hits);
  }

  // Cache write is best-effort.
  try {
    await redis.setex(cacheKey, ttl, JSON.stringify(scores));
  } catch {
    // Redis down — return successfully without caching.
  }

  return hits
    .map((h, i) => ({
      ...h,
      // WARP-1637: raw logit → 0-1 relevance. Monotonic, so the sort below
      // yields the same order the raw logits would have. `-Infinity` for a
      // gap — see the cached branch above.
      score: normalizeRerankScore(scores[i] ?? -Infinity),
      scoreKind: "similarity" as const,
    }))
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
  /** WARP-1140: extra index owners (see SearchByVectorParams.additionalUserIds). */
  additionalUserIds?: string[];
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
  // WARP-1637 — no-rerank arm: RRF weights are already bounded 0-1, so tag
  // them rather than leaving the consumer to infer the scale.
  return tagSimilarity(fused.slice(0, limit));
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
      ${SNIPPET_SQL}
    FROM "FileContentChunk"
    WHERE ${where.join(" AND ")}
    ORDER BY source, path, "indexedAt" DESC
    LIMIT $${limitParam}
  `;
  const rows = await prisma.$queryRawUnsafe<RawRecentRow[]>(sql, ...args);

  // WARP-242: decrypt-on-read (brain rows carry dcv1 ciphertext).
  const readable = await decryptSnippets(prisma, rows);

  // The DISTINCT ON ordering above groups by file; we re-sort by
  // indexedAt DESC for the dashboard's "newest first" expectation,
  // since DISTINCT ON's ORDER BY is for partitioning, not display order.
  return [...readable].sort((a, b) => b.indexedAt.getTime() - a.indexedAt.getTime());
}

/**
 * WARP-287 — route-layer hit shape that exposes per-chunk `anchor` to API
 * consumers (LLM `search_content` result, dashboard `/knowledge` search).
 *
 * Distinct from {@link SearchHit} (the internal retrieval-pipeline shape):
 *   - Carries the full `chunkText` rather than a `LEFT(text, 280)` snippet.
 *   - Carries `ncFileId` so callers can build a canonical reference.
 *   - Surfaces `anchor` extracted from `metadata.anchor` via Zod, so the
 *     wire shape stays typed even though the column is `jsonb`.
 *
 * The retrieval functions in this module still return `SearchHit`. Routes
 * that want to publish the anchored shape join the chunk rows back to the
 * FileContentChunk table (or pass through raw rows) and call
 * {@link shapeHitsForResponse}.
 */
export interface FileSearchHit {
  ncFileId: string;
  chunkIdx: number;
  score: number;
  chunkText: string;
  source: FileContentSource;
  path: string;
  pageNumber: number | null;
  brainItemId: string | null;
  /** Free-form metadata as stored on the chunk (incl. `anchor` JSON). */
  metadata: Record<string, unknown> | null;
  /**
   * Per-chunk anchor decoded from `metadata.anchor` via {@link AnchorSchema}.
   * `null` when the column is missing (legacy rows pre-WARP-287) or
   * malformed (logged at warn level, hit kept so a single bad row never
   * drops a result).
   */
  anchor: Anchor | null;
}

/**
 * Raw input rows for {@link shapeHitsForResponse}.
 *
 * Loose-typed so callers can pass through either the watcher-shaped row
 * or a route-layer DTO without an upstream cast — the helper only reads
 * the fields it surfaces.
 */
interface FileSearchHitRow {
  ncFileId: string;
  chunkIdx: number;
  score: number;
  chunkText: string;
  source: FileContentSource;
  path: string;
  pageNumber: number | null;
  brainItemId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * WARP-287 — surface a validated `anchor` on each hit.
 *
 * Failure modes:
 *   - `metadata.anchor` missing / `null` → `anchor: null` silently
 *     (legacy rows; common during migration).
 *   - `metadata.anchor` present but malformed → `anchor: null`, single
 *     `console.warn` per offending chunk. The hit IS kept; one bad row
 *     must not drop a result, that would be a worse UX than a missing
 *     citation.
 *
 * Cross-cutting note: the warning includes the chunk id so log readers
 * can backtrack to the producer (extractor or chunker) that emitted the
 * malformed anchor without grepping for textual content.
 */
export function shapeHitsForResponse(rows: FileSearchHitRow[]): FileSearchHit[] {
  return rows.map((r) => {
    const rawAnchor = (r.metadata as Record<string, unknown> | null)?.anchor;
    let anchor: Anchor | null = null;
    if (rawAnchor !== undefined && rawAnchor !== null) {
      const parsed = AnchorSchema.safeParse(rawAnchor);
      if (parsed.success) {
        anchor = parsed.data;
      } else {
        console.warn("anchor.validation.failed", {
          chunkId: `${r.ncFileId}:${r.chunkIdx}`,
          rawAnchor,
          error: parsed.error.issues,
        });
      }
    }
    return {
      ncFileId: r.ncFileId,
      chunkIdx: r.chunkIdx,
      score: r.score,
      chunkText: r.chunkText,
      source: r.source,
      path: r.path,
      pageNumber: r.pageNumber,
      brainItemId: r.brainItemId,
      metadata: r.metadata ?? null,
      anchor,
    };
  });
}

/**
 * WARP-204 — `/knowledge` dashboard view backend.
 *
 * This router exposes the two endpoints that drive the dashboard's
 * `/knowledge` page:
 *
 *   GET /api/files/knowledge/recent
 *     Cursor-paginated list of FileContentChunk rows for the authed
 *     user, newest first. The dashboard groups the flat list into
 *     "Today / Yesterday / This week / This month / Earlier" buckets;
 *     this route stays shape-agnostic so the same data can power a
 *     mobile client later.
 *
 *   GET /api/files/knowledge/search
 *     Semantic search over the same chunks. Delegates to the shared
 *     `services/file-search.service.ts` module that WARP-202 introduces.
 *     Until that lands, this route returns `503 search-not-yet-available`
 *     so the dashboard can render a graceful "search will be online soon"
 *     state instead of crashing.
 *
 * # Path namespace
 *
 * The original spec / plan example used `/api/files/recent` and
 * `/api/files/search`. Those collide with two long-standing Nextcloud-
 * filename routes in `routes/files.ts` (`/files/recents` and
 * `/files/search`) that the dashboard's Recents tab + global file
 * search bar already consume. To keep both surfaces alive we mount the
 * new endpoints under `/files/knowledge/*`. The dashboard's `/knowledge`
 * tabs target this namespace; nothing else should.
 *
 * # RBAC
 *
 * Both routes scope every Prisma query to the authed user's OWN chunk
 * keys (`where.userId IN (<username>, <User.id UUID>)` — see
 * `chunkOwnerKeys`). Both shapes come off `req.user` (populated by the
 * auth middleware), never from the request, so cross-user retrieval is
 * impossible by construction. See spec §12.
 */

import { Router } from "express";
import { PrismaClient, type Prisma, type FileContentChunk } from "@prisma/client";

import { AnchorSchema, type Anchor } from "@droplet/shared-types";
import { createLogger } from "../lib/logger.js";
import { decryptChunkRows } from "../services/file-search.service.js";

const logger = createLogger("files-knowledge-route");

// Hard upper bounds — keep both routes from being used as a denial-of-
// service amplifier (large `take` => big Postgres scan + big JSON body).
const RECENT_LIMIT_MAX = 50;
const RECENT_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 20;
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_MIN_QUERY_LENGTH = 2;
/**
 * Cosine floor for the dashboard's knowledge search, deliberately a little
 * more permissive than `SEARCH_HYBRID_DEFAULT_MIN_SIMILARITY`.
 *
 * WARP-2196: 0.25 -> 0.63. Same recalibration as the hybrid default, same
 * reason — the old value was tuned to all-MiniLM-L6-v2's score distribution,
 * and under bge-small-en-v1.5 nothing in the measured corpus scores below
 * 0.344, so 0.25 filtered exactly nothing. 0.63 is the measured
 * bge-equivalent of MiniLM's 0.25 by irrelevant-pair selectivity (15.6% vs
 * 16.3%), which preserves the intended "looser than the default" posture.
 * See services/similarity-floors.test.ts for the distributions.
 */
const SEARCH_MIN_SIMILARITY = 0.63;
const SNIPPET_MAX_CHARS = 240;

type SourceFilter = "nextcloud" | "brain";

function parseSource(raw: unknown): SourceFilter | undefined {
  if (raw === "nextcloud" || raw === "brain") return raw;
  return undefined;
}

/**
 * WARP-1014 — the authed user's FileContentChunk owner keys, BOTH shapes.
 *
 * The WARP-493 cutover left `FileContentChunk.userId` deliberately
 * split by source: brain-sourced rows key on the local `User.id` UUID,
 * while nextcloud-watcher rows stay keyed by Nextcloud username
 * (`services/file-indexer/watcher.py` derives owners from filesystem
 * paths — by design, do not "fix"). This surface spans both sources, so
 * it reads with both keys: dual-shape reads (Option 1 of the WARP-493
 * follow-up decision; precedent is the ChatSession transition note in
 * `routes/llm.ts`). The rejected alternative — unifying the watcher on
 * UUIDs — would push an auth-directory dependency into the indexer's
 * path-derived bookkeeping for no read-side gain.
 *
 * Username first so the single-shape case (dev stub, service
 * principals, id === username) keeps the historical binding order.
 */
function chunkOwnerKeys(user: { id?: string; username?: string }): string[] {
  return [
    ...new Set(
      [user.username, user.id].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ),
  ];
}

/** Truncate text to a fixed width — cheap snippet for list cards. */
function snippet(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > SNIPPET_MAX_CHARS
    ? trimmed.slice(0, SNIPPET_MAX_CHARS - 1) + "…"
    : trimmed;
}

/**
 * Coerce BigInt + Date fields into JSON-friendly types. Prisma returns
 * `id` as `BigInt` (autoincrement column on `FileContentChunk`) and
 * `JSON.stringify` throws on BigInt — so the route MUST stringify it
 * explicitly. Same goes for `indexedAt` (Date → ISO string) so the
 * dashboard's `new Date(...)` in the bucket function works without
 * further massaging.
 */
function serializeChunk(row: any) {
  return {
    id: typeof row.id === "bigint" ? row.id.toString() : String(row.id),
    userId: row.userId,
    ncFileId: row.ncFileId,
    path: row.path,
    chunkIdx: row.chunkIdx,
    snippet: snippet(row.text),
    indexedAt:
      row.indexedAt instanceof Date ? row.indexedAt.toISOString() : row.indexedAt,
    // Phase-2 columns — present once WARP-203's migration applies. We
    // surface them when present so the dashboard can render the source
    // badge without an extra fetch, but never assume they exist.
    source: row.source ?? "nextcloud",
    brainItemId: row.brainItemId ?? null,
    pageNumber: row.pageNumber ?? null,
    // WARP-214: free-form per-chunk metadata for breadcrumbs (chain[])
    // + source-channel badge (subtitle_source). Returns null when the
    // row is from before the WARP-214 migration / extractor backfill.
    metadata: row.metadata ?? null,
  };
}

/**
 * Best-effort dynamic import of the shared file-search service. Returns
 * `null` when the module is missing (e.g. WARP-202 hasn't merged yet) so
 * the route can return 503 instead of throwing through to a 500.
 *
 * The cache prevents repeated `import()` round-trips on hot paths.
 */
let searchServiceCache: { mod: any | null; loaded: boolean } | null = null;
async function loadSearchService(): Promise<any | null> {
  if (searchServiceCache?.loaded) return searchServiceCache.mod;
  try {
    // @ts-ignore — module resolves at runtime once WARP-202 lands.
    const mod = await import("../services/file-search.service.js");
    searchServiceCache = { mod, loaded: true };
    return mod;
  } catch (err) {
    logger.info(
      { err: (err as Error)?.message },
      "file-search.service not available — search route will return 503"
    );
    searchServiceCache = { mod: null, loaded: true };
    return null;
  }
}

/**
 * Same idea for the embedding client. Different module so a future
 * WARP-202 split (where embeddings live in a separate file) doesn't
 * force me to rewrite this.
 */
async function loadEmbeddingClient(): Promise<any | null> {
  try {
    // @ts-ignore — module resolves at runtime once WARP-202 lands.
    const mod = await import("../services/embedding.client.js");
    return mod;
  } catch {
    return null;
  }
}

/**
 * WARP-286 — assemble the rerank pipe (Redis + gRPC reranker client)
 * for the `/knowledge` search route. Returns `undefined` when either
 * dependency is unconfigured / unavailable; `searchHybrid` then falls
 * back to RRF top-K without reranking.
 *
 * Both pieces are imported lazily so the module load order can't make
 * route registration fail on a fresh device where the reranker stack
 * hasn't run yet.
 */
let rerankPipeSingleton:
  | {
      redis: { get(k: string): Promise<string | null>; setex(k: string, ttl: number, v: string): Promise<unknown> };
      reranker: { rerank(args: { query: string; passages: string[]; model?: string }): Promise<{ scores: number[] }> };
    }
  | null
  | undefined = undefined;
async function buildRerankPipe(): Promise<
  | {
      redis: { get(k: string): Promise<string | null>; setex(k: string, ttl: number, v: string): Promise<unknown> };
      reranker: { rerank(args: { query: string; passages: string[]; model?: string }): Promise<{ scores: number[] }> };
    }
  | undefined
> {
  if (rerankPipeSingleton !== undefined) {
    return rerankPipeSingleton ?? undefined;
  }
  try {
    if (!process.env.REDIS_URL) {
      rerankPipeSingleton = null;
      return undefined;
    }
    const [{ getRedis }, { RerankerClient }] = await Promise.all([
      import("../services/cache.service.js"),
      import("../services/reranker.client.js"),
    ]);
    const aiGatewayGrpcUrl =
      process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
    rerankPipeSingleton = {
      redis: getRedis() as unknown as {
        get(k: string): Promise<string | null>;
        setex(k: string, ttl: number, v: string): Promise<unknown>;
      },
      reranker: new RerankerClient({ url: aiGatewayGrpcUrl }),
    };
    return rerankPipeSingleton;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message },
      "rerank pipe unavailable; serving RRF top-K without rerank",
    );
    rerankPipeSingleton = null;
    return undefined;
  }
}

export function createFilesKnowledgeRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────────────
  // GET /api/files/knowledge/recent
  // ─────────────────────────────────────────────────────────────────────
  router.get("/files/knowledge/recent", async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "auth_required" });
        return;
      }

      const limitRaw = parseInt(String(req.query.limit ?? RECENT_LIMIT_DEFAULT), 10);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(RECENT_LIMIT_MAX, limitRaw)
          : RECENT_LIMIT_DEFAULT;

      const before = req.query.before ? new Date(String(req.query.before)) : undefined;
      // Reject obviously bad cursors but don't crash — drop the cursor.
      const validBefore =
        before && !Number.isNaN(before.getTime()) ? before : undefined;

      const source = parseSource(req.query.source);

      // Build the `where` defensively. WARP-203 adds `source` (+
      // `brainItemId`, `pageNumber`) to FileContentChunk; before that
      // migration applies, Prisma rejects the field with P2009/P2016.
      // We retry without the column on those errors so the route
      // degrades gracefully on partial deploys.
      const baseWhere: Prisma.FileContentChunkWhereInput = {
        userId: { in: chunkOwnerKeys(user) },
      };
      if (validBefore) baseWhere.indexedAt = { lt: validBefore };
      const fullWhere: Prisma.FileContentChunkWhereInput = source
        ? { ...baseWhere, source }
        : baseWhere;

      let rows: FileContentChunk[] = [];
      try {
        rows = await prisma.fileContentChunk.findMany({
          where: fullWhere,
          orderBy: { indexedAt: "desc" },
          take: limit,
        });
      } catch (err: any) {
        const msg = err?.message || "";
        const isUnknownArg =
          err?.code === "P2009" ||
          err?.code === "P2016" ||
          /Unknown arg|Unknown field|Unknown column/.test(msg);
        if (isUnknownArg && source) {
          // Retry without the source filter — schema column not yet present.
          logger.warn(
            { err: msg },
            "FileContentChunk.source not in schema yet — retrying without filter"
          );
          rows = await prisma.fileContentChunk.findMany({
            where: baseWhere,
            orderBy: { indexedAt: "desc" },
            take: limit,
          });
        } else {
          throw err;
        }
      }

      // WARP-242: brain rows hold dcv1 ciphertext at rest — decrypt before
      // snippetting (unreadable rows are dropped by the shared helper).
      const readable = await decryptChunkRows(prisma, rows);
      const items = readable.map(serializeChunk);
      // Cursor for the next page — caller passes the last item's `indexedAt`
      // back as `?before=`. We expose it as `nextBefore` so clients don't
      // have to reach into the array.
      const nextBefore =
        items.length === limit ? items[items.length - 1].indexedAt : null;

      res.json({ items, nextBefore });
    } catch (err) {
      next(err);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // GET /api/files/knowledge/search
  // ─────────────────────────────────────────────────────────────────────
  router.get("/files/knowledge/search", async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        res.status(401).json({ error: "auth_required" });
        return;
      }

      const q = String(req.query.q ?? "").trim();
      if (!q) {
        res.status(400).json({ error: "query_required" });
        return;
      }
      if (q.length < SEARCH_MIN_QUERY_LENGTH) {
        res.status(400).json({ error: "query_too_short" });
        return;
      }

      const limitRaw = parseInt(String(req.query.limit ?? SEARCH_LIMIT_DEFAULT), 10);
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0
          ? Math.min(SEARCH_LIMIT_MAX, limitRaw)
          : SEARCH_LIMIT_DEFAULT;

      const since = req.query.since ? new Date(String(req.query.since)) : undefined;
      const validSince =
        since && !Number.isNaN(since.getTime()) ? since : undefined;
      const source = parseSource(req.query.source);

      // WARP-202 dependency. Until both `embedding.client` and
      // `file-search.service` are in tree, we surface a deterministic
      // 503 so the dashboard can show "search will be online soon"
      // without falling into a generic 500.
      const [embedding, search] = await Promise.all([
        loadEmbeddingClient(),
        loadSearchService(),
      ]);
      if (!embedding || !search) {
        res
          .status(503)
          .json({ error: "search-not-yet-available", retryAfterSeconds: 30 });
        return;
      }

      // WARP-202 exports an `EmbeddingClient` class (not a top-level
      // `embed()`); instantiate per request — the gRPC channel inside is
      // lazy so this is effectively free, and it keeps the route
      // stateless. URL falls back to the same default the MCP server
      // uses (`ai-gateway:50051`) so dev + Compose stay in sync.
      const aiGatewayGrpcUrl =
        process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
      const client = new embedding.EmbeddingClient({ url: aiGatewayGrpcUrl });
      let vector: number[] | undefined;
      try {
        vector = (await client.embed([q]))[0];
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message },
          "embedding rpc failed — returning 502"
        );
        res.status(502).json({ error: "embedding_failed" });
        return;
      }
      if (!Array.isArray(vector)) {
        res.status(502).json({ error: "embedding_failed" });
        return;
      }

      // WARP-286: switch from vector-only to hybrid (BM25 + vector + RRF
      // + cross-encoder reranker). The rerank pipe is wired below; on
      // any backend failure (Redis down, ai-gateway down, model not
      // cached) `searchHybrid` / `rerankPassages` pass-through to the
      // RRF top-K so the dashboard stays usable.
      const rerankPipe = await buildRerankPipe();
      // WARP-1014 dual-shape reads — the UUID rides as an additional
      // index owner (WARP-1140 predicate) so brain-sourced chunks stay
      // visible next to the username-keyed watcher chunks.
      const [primaryOwnerKey, ...additionalOwnerKeys] = chunkOwnerKeys(user);
      const hits = await search.searchHybrid(prisma, {
        userId: primaryOwnerKey,
        additionalUserIds:
          additionalOwnerKeys.length > 0 ? additionalOwnerKeys : undefined,
        vector,
        query: q,
        limit,
        minSimilarity: SEARCH_MIN_SIMILARITY,
        source,
        since: validSince,
        rerank: rerankPipe,
      });

      // WARP-214: surface free-form metadata (chain[], subtitle_source) on the
      // wire so the dashboard's Breadcrumbs + SourceChannelBadge can render
      // without an extra fetch. `metadata` is null on legacy rows; the
      // dashboard treats null/undefined the same.
      //
      // WARP-287: surface a validated `anchor` field on each hit so the
      // dashboard's <CitationCard> can render deep-link viewers. Malformed
      // anchors fall back to `null` with a single warn-level log; the hit
      // is never dropped (one bad chunk shouldn't suppress a result).
      res.json({
        hits: (hits as Array<Record<string, unknown>>).map((h) => {
          const metadata = (h.metadata as Record<string, unknown> | null) ?? null;
          const rawAnchor = metadata?.anchor;
          let anchor: Anchor | null = null;
          if (rawAnchor !== undefined && rawAnchor !== null) {
            const parsed = AnchorSchema.safeParse(rawAnchor);
            if (parsed.success) {
              anchor = parsed.data;
            } else {
              logger.warn(
                {
                  chunkId: `${(h as { path?: string }).path ?? ""}:${(h as { chunkIdx?: number }).chunkIdx ?? -1}`,
                  rawAnchor,
                  error: parsed.error.issues,
                },
                "anchor.validation.failed"
              );
            }
          }
          return {
            ...h,
            metadata,
            anchor,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

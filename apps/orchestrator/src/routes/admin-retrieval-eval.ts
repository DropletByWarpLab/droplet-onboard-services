/**
 * WARP-286 — eval endpoint. Lets `tests/retrieval-eval/run.ts` call
 * each of the three retrieval pipelines (vector-only / RRF / full
 * hybrid) directly so it can compute NDCG@10 per-pipeline.
 *
 * Mount policy: this endpoint is admin-grade scaffolding for an
 * offline gate, NOT a public surface. It returns `404 not_found` unless
 * `RAG_EVAL_ENABLED` is explicitly on (WARP-3609) — an explicit positive flag
 * written for boxes that run the rag-eval profile, NOT `NODE_ENV`, which the
 * orchestrator container never sets and which WARP-2551 will arm for every
 * box (the old gate was both dead today and would have 404'd the scheduled
 * eval the day it armed).
 *
 * Auth: WARP-449 — previously piggybacked on `authMiddleware` alone (any
 * authenticated user could hit the endpoint, scoped to their own userId
 * via the per-arm `WHERE userId = $1` filter). The route name and mount
 * point live under `/admin/*`, so per ADR-004 §3 / WARP-449 AC #4 it now
 * carries the same owner/admin posture as the other `admin-*` route files —
 * this is eval-only tooling (404s unless RAG_EVAL_ENABLED) and every sibling
 * admin router already gates on role. RAGAS eval-runner auth additionally
 * admits the `_service:rag-eval` service principal (the rag-eval
 * container's ragas_runner.py), which must name its eval target user via
 * `?user=` — and may name ONLY the one configured eval account
 * (`RAGAS_EVAL_USER`), see `resolveEvalAccess` below.
 */
import { Router, type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { requireRoleOrService } from "../middleware/auth.js";
import { resolveActiveModel } from "../services/active-model.service.js";

const logger = createLogger("admin-retrieval-eval");

interface SearchResultWire {
  source: "nextcloud" | "brain";
  path: string;
  chunkIdx: number;
  score: number;
  /**
   * WARP-436: chunk snippet text. Required by the RAGAS eval harness
   * (`tests/retrieval-eval/ragas/ragas_runner.py`) so the LLM judge can
   * score faithfulness / context-relevance against the actual retrieved
   * text, not just metadata. Kept on the same admin-only endpoint
   * because exposing chunk text via a public surface would bypass the
   * per-user RBAC story; this endpoint is already 404 unless RAG_EVAL_ENABLED.
   */
  snippet: string;
}

/**
 * WARP-3609 — the gate shared by every route here. Writes the error response
 * and returns null when the request must not proceed; otherwise returns the
 * username whose corpus the request may read.
 *
 *   1. `RAG_EVAL_ENABLED` off → 404, before anything else is revealed.
 *   2. Human owner/admin → their OWN username; `?user=` is ignored entirely,
 *      so this never becomes a way to search someone else's files.
 *   3. The `_service:rag-eval` principal owns no corpus, so it names its
 *      target via `?user=` (EXPLICIT config, never guessed → 400 when absent)
 *      and may name ONLY the one configured eval account `RAGAS_EVAL_USER`.
 *      Any other name — or no configured account at all — is a 403, so a
 *      holder of the service token cannot read an employee's private
 *      Nextcloud or brain-memory chunks by naming them.
 *
 * Resolved BEFORE the heavy lazy imports in the handlers, so a misconfigured
 * runner gets a crisp 4xx instead of a 500 from half-initialised retrieval.
 */
function resolveEvalAccess(req: Request, res: Response): string | null {
  if (!config.RAG_EVAL_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "auth_required" });
    return null;
  }
  if (user.id !== "_service:rag-eval") return user.username;
  const requested = String(req.query.user ?? "").trim();
  if (!requested) {
    res.status(400).json({ error: "eval_user_required" });
    return null;
  }
  const allowed = (config.RAGAS_EVAL_USER ?? "").trim();
  if (!allowed || requested !== allowed) {
    logger.warn(
      { requested },
      "retrieval-eval: rag-eval principal named a user other than RAGAS_EVAL_USER — refused (WARP-3609)",
    );
    res.status(403).json({ error: "eval_user_forbidden" });
    return null;
  }
  return allowed;
}

export function createAdminRetrievalEvalRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/admin/retrieval-eval/search",
    requireRoleOrService("_service:rag-eval", "owner", "admin"),
    async (req, res) => {
    const evalUsername = resolveEvalAccess(req, res);
    if (evalUsername === null) return;
    const variant = String(req.query.variant ?? "hybrid") as
      | "vector"
      | "rrf"
      | "hybrid"
      | "hybrid-enhanced";
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "query_required" });
      return;
    }
    const limitRaw = parseInt(String(req.query.limit ?? "10"), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(50, limitRaw))
      : 10;

    try {
      // Lazy imports — the eval endpoint must not crash module load on
      // a fresh device where file-search.service / embedding.client /
      // reranker.client are still being installed.
      const [search, embedMod, rerankMod, cacheMod] = await Promise.all([
        import("../services/file-search.service.js"),
        import("../services/embedding.client.js"),
        import("../services/reranker.client.js"),
        import("../services/cache.service.js"),
      ]);

      const aiGatewayGrpcUrl = config.AI_GATEWAY_GRPC_URL;
      const embedClient = new embedMod.EmbeddingClient({ url: aiGatewayGrpcUrl });
      const [vector] = await embedClient.embed([query]);
      if (!vector) {
        res.status(503).json({ error: "embedding_unavailable" });
        return;
      }

      // Reuse the canonical SearchHit type from file-search.service so
      // we always see whatever fields the underlying retriever exposes
      // (snippet, metadata, pageNumber, …). WARP-436: snippet is what
      // the RAGAS runner consumes.
      let hits: Awaited<ReturnType<typeof search.searchByVector>>;

      if (variant === "vector") {
        // minSimilarity=0 so we don't pre-filter the baseline — let the
        // eval ranker see what vector-only would surface.
        hits = await search.searchByVector(prisma, {
          userId: evalUsername,
          vector,
          limit,
          minSimilarity: 0.0,
        });
      } else if (variant === "rrf") {
        // No rerank pipe — searchHybrid returns RRF top-K.
        hits = await search.searchHybrid(prisma, {
          userId: evalUsername,
          vector,
          query,
          limit,
        });
      } else if (variant === "hybrid") {
        // Full hybrid + reranker. Redis is optional; rerankPassages
        // gracefully degrades if it's unconfigured.
        const redisInstance = process.env.REDIS_URL
          ? cacheMod.getRedis()
          : null;
        const rerankerClient = new rerankMod.RerankerClient({
          url: aiGatewayGrpcUrl,
        });
        hits = await search.searchHybrid(prisma, {
          userId: evalUsername,
          vector,
          query,
          limit,
          rerank: redisInstance
            ? {
                redis: redisInstance as unknown as {
                  get(k: string): Promise<string | null>;
                  setex(k: string, ttl: number, v: string): Promise<unknown>;
                },
                reranker: rerankerClient,
              }
            : undefined,
        });
      } else {
        // WARP-437: end-to-end enhanced retrieval used by the per-class
        // eval. Classify → preset → HyDE/multi-query → embed → searchHybrid.
        // Lazy-imported so the eval route doesn't break module load on a
        // fresh device where the WARP-437 wiring is incomplete.
        const redisInstance = process.env.REDIS_URL
          ? cacheMod.getRedis()
          : null;
        const rerankerClient = new rerankMod.RerankerClient({
          url: aiGatewayGrpcUrl,
        });

        const [classifierMod, enhMod, agentMod] = await Promise.all([
          import("../services/query-classifier.client.js"),
          import("../services/query-enhancement.service.js"),
          import("../services/llm-agent.service.js"),
        ]);
        const classifierClient = new classifierMod.QueryClassifierClient({
          url: aiGatewayGrpcUrl,
        });

        // The production path uses Redis for the classifier cache; the eval
        // is one-shot per query so an in-memory cache is fine here.
        const inMemoryCache = makeInMemoryClassifierCache();
        const { cls } = await enhMod.classifyQuery({
          query,
          rpc: (args) => classifierClient.classify(args),
          cache: inMemoryCache,
        });
        const preset = agentMod.presetForClass(cls, query);
        // WARP-3047 — the eval measures the model the box actually answers
        // with (and never loads a second one next to it on DMR).
        const chat = makeAdminEvalChatAdapter(await resolveActiveModel(prisma));

        let hydeVector: number[] | undefined;
        let extraQueryVectors: number[][] | undefined;
        if (preset.enhance?.hyde) {
          const passage = await enhMod.hydeRewrite({ query, chat });
          [hydeVector] = await embedClient.embed([passage]);
        }
        if (preset.enhance?.multiQuery) {
          const rewrites = await enhMod.multiQueryExpand({
            query,
            chat,
            n: preset.enhance.n,
          });
          if (rewrites.length > 0) {
            extraQueryVectors = await embedClient.embed(rewrites);
          }
        }

        const enhancementBundle =
          hydeVector || extraQueryVectors || preset.filenameContains
            ? {
                hydeVector,
                extraQueryVectors,
                metadataFilter: preset.filenameContains
                  ? { filenameContains: preset.filenameContains }
                  : undefined,
              }
            : undefined;

        hits = await search.searchHybrid(prisma, {
          userId: evalUsername,
          vector,
          query,
          limit,
          minSimilarity: preset.searchOverrides?.minSimilarity,
          perArmK: preset.searchOverrides?.perArmK,
          queryEnhancement: enhancementBundle,
          rerank: redisInstance
            ? {
                redis: redisInstance as unknown as {
                  get(k: string): Promise<string | null>;
                  setex(k: string, ttl: number, v: string): Promise<unknown>;
                },
                reranker: rerankerClient,
                candidates: preset.searchOverrides?.rerankCandidates,
              }
            : undefined,
        });
      }

      const wire: SearchResultWire[] = hits.map((h) => ({
        source: h.source,
        path: h.path,
        chunkIdx: h.chunkIdx,
        score: h.score,
        snippet: h.snippet,
      }));
      res.json({ results: wire });
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message, variant, query },
        "retrieval-eval search failed",
      );
      res.status(500).json({ error: "retrieval_eval_failed" });
    }
  });

  /**
   * WARP-1868 — corpus fingerprint, so the nightly RAGAS run can skip when
   * nothing changed.
   *
   * The eval is GPU-bound: a healthy pass pins the discrete card at 98-100%
   * for ~10 minutes. It fires eight times a night on a cron regardless of
   * whether a single file was indexed, so a quiet week costs ~56 GPU-hours
   * re-measuring an identical corpus. The load itself is not reducible —
   * inference saturates the card by design, and capping ragas' concurrency
   * only makes the run longer — so the only lever is whether it runs at all.
   *
   * Two fields, because neither is sufficient alone:
   *   - `chunks`          catches adds and deletes.
   *   - `latestIndexedAt` catches edits and re-indexes, which leave the
   *                       count identical.
   * A delete-plus-add of equal size still moves `latestIndexedAt` (the new
   * row is newer), and a pure delete moves `chunks`, so the pair covers the
   * cases that actually occur on an appliance.
   *
   * Scoped exactly like /search above — same auth, same RAG_EVAL_ENABLED 404,
   * same pinned `?user=` for the service principal, which owns no corpus. One
   * table covers both retrieval sources: FileContentChunk carries brain items
   * too (`source` column), so a new brain memory moves the fingerprint.
   */
  router.get(
    "/admin/retrieval-eval/corpus-fingerprint",
    requireRoleOrService("_service:rag-eval", "owner", "admin"),
    async (req, res) => {
      const evalUsername = resolveEvalAccess(req, res);
      if (evalUsername === null) return;

      try {
        // Aggregate rather than fetching rows: the corpus is tens of
        // thousands of chunks and this runs on a cron. Covered by
        // @@index([userId, source, indexedAt]).
        const agg = await prisma.fileContentChunk.aggregate({
          where: { userId: evalUsername },
          _count: { _all: true },
          _max: { indexedAt: true },
        });
        const chunks = agg._count._all;
        const latestIndexedAt = agg._max.indexedAt?.toISOString() ?? null;

        res.json({
          user: evalUsername,
          chunks,
          latestIndexedAt,
          // Composed server-side so both surfaces can never disagree on the
          // arithmetic, and so the client stores one opaque string rather
          // than re-deriving equality from parts.
          fingerprint: `v1:${chunks}:${latestIndexedAt ?? "none"}`,
        });
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, user: evalUsername },
          "corpus-fingerprint failed",
        );
        // 500, not an empty fingerprint. A caller that cannot read the
        // fingerprint must fall back to RUNNING the eval — failing toward
        // measuring, never toward silence — and it can only make that
        // choice if the failure is visible as a failure.
        res.status(500).json({ error: "corpus_fingerprint_failed" });
      }
    },
  );

  return router;
}

/**
 * WARP-437 — tiny per-request classifier cache for the `hybrid-enhanced`
 * eval variant. Production paths use Redis (TTL=24 h); the eval is
 * one-shot per query so an in-memory map is sufficient.
 */
function makeInMemoryClassifierCache() {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    async get(k: string): Promise<string | null> {
      const e = store.get(k);
      if (!e || e.exp < Date.now()) return null;
      return e.v;
    },
    async setex(k: string, ttl: number, v: string): Promise<unknown> {
      store.set(k, { v, exp: Date.now() + ttl * 1000 });
      return undefined;
    },
  };
}

/**
 * WARP-437 — wraps ai-gateway HTTP chat in the `ChatClient` shape expected
 * by `hydeRewrite` / `multiQueryExpand`. The HTTP route does not propagate
 * `priority`; the eval calls run at normal priority. That's fine for a
 * one-shot eval — production paths use the agent-loop's chat adapter.
 */
function makeAdminEvalChatAdapter(model: string | null) {
  return async (args: {
    prompt: string;
    temperature: number;
    maxTokens: number;
    priority: number;
  }): Promise<{ content: string }> => {
    // No resolvable model: an empty rewrite, which HyDE / multi-query
    // already treat as "use the raw query" — never a hardcoded tag the box
    // does not host.
    if (!model) return { content: "" };
    const ai = await import("../services/ai-gateway.client.js");
    const res = await ai.chat({
      model,
      messages: [{ role: "user", content: args.prompt }],
      stream: false,
      temperature: args.temperature,
      max_tokens: args.maxTokens,
    });
    if (!res.ok) return { content: "" };
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return { content: data.choices?.[0]?.message?.content ?? "" };
  };
}

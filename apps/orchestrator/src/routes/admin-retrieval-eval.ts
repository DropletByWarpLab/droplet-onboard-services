/**
 * WARP-286 — eval endpoint. Lets `tests/retrieval-eval/run.ts` call
 * each of the three retrieval pipelines (vector-only / RRF / full
 * hybrid) directly so it can compute NDCG@10 per-pipeline.
 *
 * Mount policy: this endpoint is admin-grade scaffolding for an
 * offline gate, NOT a public surface. It returns `404 not_found` when
 * `NODE_ENV === "production"` so the live appliance never exposes it.
 *
 * Auth: piggybacks on the existing authMiddleware — any authenticated
 * user can hit the endpoint and gets results scoped to their own
 * userId via the per-arm `WHERE userId = $1` filter (no cross-user
 * leak by construction).
 */
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { createLogger } from "../lib/logger.js";

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
   * per-user RBAC story; this endpoint is already 404 in production.
   */
  snippet: string;
}

export function createAdminRetrievalEvalRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/admin/retrieval-eval/search", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "auth_required" });
      return;
    }
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

      const aiGatewayGrpcUrl =
        process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
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
          userId: user.username,
          vector,
          limit,
          minSimilarity: 0.0,
        });
      } else if (variant === "rrf") {
        // No rerank pipe — searchHybrid returns RRF top-K.
        hits = await search.searchHybrid(prisma, {
          userId: user.username,
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
          userId: user.username,
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
        const chat = makeAdminEvalChatAdapter();

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
          userId: user.username,
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
function makeAdminEvalChatAdapter() {
  return async (args: {
    prompt: string;
    temperature: number;
    maxTokens: number;
    priority: number;
  }): Promise<{ content: string }> => {
    const ai = await import("../services/ai-gateway.client.js");
    const res = await ai.chat({
      // LLM_MODEL is the model the box actually hosts (single-box.sh
      // writes it to .env); the historic mistral fallback is not pulled
      // in production and would 404 upstream.
      model:
        process.env.DEFAULT_MODEL ??
        process.env.LLM_MODEL ??
        "mistral:7b-instruct",
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

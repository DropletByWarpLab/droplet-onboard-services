#!/usr/bin/env node
import Redis from "ioredis";

import { PrismaClient } from "@prisma/client";
import type { HttpClient } from "@droplet/tools-core";
import { assertFipsAtBootOrExit } from "@droplet/fips-selftest";
import { createServer } from "./server.js";
import { internalBaseUrl, internalFetch } from "./internal-tls.js";
import { redisConnectionOptions } from "./redis-tls.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import type { ContextDeps } from "./context.js";
import { EmbeddingClient } from "./embedding.client.js";
import { RerankerClient } from "./reranker.client.js";
import { readDocumentText, searchHybrid } from "./file-search.service.js";
import { resolveChunkOwnerIds } from "./chunk-owner.js";
import { createMatterController } from "./matter.controller.js";

// WARP-229: FIPS 140-3 boot self-test. Same gating as the orchestrator
// — `DROPLET_FIPS_REQUIRED` env, default-on in production. The
// mcp-server is the trust boundary for the LLM tool path; if the FIPS
// provider isn't loaded we want the container to refuse to start
// rather than handle tool calls under a broken cryptographic posture.
function runFipsBootSelfTest(): void {
  const required =
    process.env.DROPLET_FIPS_REQUIRED?.toLowerCase() === "true" ||
    process.env.DROPLET_FIPS_REQUIRED === "1" ||
    (process.env.DROPLET_FIPS_REQUIRED === undefined &&
      process.env.NODE_ENV === "production");
  if (!required) {
    // No-op; non-production / explicitly opted-out runs.
    return;
  }
  assertFipsAtBootOrExit("mcp-server");
}

function parseTransport(argv: string[]): "stdio" | "http" {
  const arg = argv.find((a) => a.startsWith("--transport="));
  const value = arg?.split("=")[1];
  if (value === "http") return "http";
  return "stdio";
}

type HttpTarget =
  | "routing"
  | "cameras"
  | "switchSvc"
  | "fileIndexer"
  | "nextcloud"
  | "orchestrator";

function baseUrlFor(target: HttpTarget): string {
  switch (target) {
    case "routing":
      return process.env.ROUTING_SERVICE_URL ?? "http://host.docker.internal:8080";
    case "cameras":
      // camera-discovery runs network_mode: host (binds privileged
      // sockets for ONVIF WS-Discovery + RTSP scan); other compose-net
      // containers can't resolve it by service DNS. Same pattern as
      // routing/switch — reach it through the host-gateway hostname
      // the orchestrator's `extra_hosts` already wires up. Real port
      // is 8085 per services/camera-discovery/Dockerfile.
      return process.env.CAMERA_DISCOVERY_URL ?? "http://host.docker.internal:8085";
    case "switchSvc":
      return process.env.SWITCH_SERVICE_URL ?? "http://host.docker.internal:8081";
    case "fileIndexer":
      // WARP-1144: the file-indexer's HTTP server listens on :8090
      // (FILE_INDEXER_HTTP_PORT default — see services/file-indexer/main.py
      // and the port table in docs/COMPONENTS.md). The previous :8000
      // fallback pointed at a port nothing listens on, so every call from a
      // handler using this target died as a raw "fetch failed" (compose
      // never sets FILE_INDEXER_URL, so the fallback is what actually runs).
      // Matches the orchestrator's own config default
      // (apps/orchestrator/src/config.ts FILE_INDEXER_URL).
      return process.env.FILE_INDEXER_URL ?? "http://file-indexer:8090";
    case "nextcloud":
      // WARP-861: despite the target's historical name, the files-domain
      // tools speak the ORCHESTRATOR's /api/files contract (JSON entries,
      // /download?path=, /mkdir, /move, …) — NOT raw Nextcloud (which is
      // WebDAV/XML and, behind the TLS gateway, redirects plain HTTP to an
      // unserved :443). Pointing this at NEXTCLOUD_URL is exactly the bug
      // that made every file tool fail in Docker. The orchestrator
      // validates the per-user X-Nextcloud-Token/-User headers for the
      // mcp service principal and proxies to Nextcloud itself.
      return (
        process.env.FILES_API_URL ?? "http://orchestrator:3000/api/files"
      );
    case "orchestrator":
      // WARP-102: Matter tool calls + audit-log + safety-tier proxy
      // back to the orchestrator's REST surface from here. Compose
      // wires ORCHESTRATOR_URL explicitly; the fallback keeps
      // off-compose dev runs working.
      return process.env.ORCHESTRATOR_URL ?? "http://orchestrator:3000";
  }
}

function joinUrl(base: string, path: string, params?: Record<string, unknown>): string {
  // WARP-861: resolve RELATIVE to the base so a base that carries a path
  // segment (the files API at http://orchestrator:3000/api/files) keeps it.
  // `new URL("/x", "http://h/api/files/")` would discard "/api/files";
  // stripping the leading slash makes "/x" resolve to "/api/files/x".
  // Host-only bases (every other target) resolve identically either way.
  const rel = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(rel, base.endsWith("/") ? base : `${base}/`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Real fetch-backed HttpClient. The MCP server is the only place that
 * crosses the orchestrator/service-pod boundary, so we resolve target
 * base URLs from env at process start.
 *
 * Per-call options carry a JSON body; we always set Content-Type when a body
 * is present to avoid silently sending text/plain to FastAPI services.
 */
function createHttpClient(target: HttpTarget): HttpClient {
  // WARP-236: rewrite the internal base URL to https:// and present the
  // mcp-server's client cert when DROPLET_INTERNAL_TLS=1 (identity when off).
  const base = internalBaseUrl(baseUrlFor(target));
  // WARP-339: when the target is the orchestrator, attach the
  // service-principal bearer the orchestrator's authMiddleware
  // recognises (matchServiceToken → `_service:mcp` AuthUser). The
  // shared-secret pattern mirrors what voice-io already does for
  // /api/llm/chat — see scripts/lib/secrets.sh SERVICE_TOKEN_MCP +
  // apps/orchestrator/src/middleware/auth.ts SERVICE_PRINCIPALS.
  //
  // The token is read once at client-construction time rather than
  // per-request; rotation requires a container restart on both the
  // orchestrator and the mcp-server (compose wires them to the same
  // ${SERVICE_TOKEN_MCP} value). Other targets (routing, switch,
  // file-indexer) carry their own service tokens that handlers pass
  // via opts.headers, so this hook only fires for the orchestrator path.
  //
  // WARP-861: the "nextcloud" target now points at the orchestrator's
  // /api/files surface, so it needs the same service bearer — the
  // per-user X-Nextcloud-Token/-User headers ride alongside it and the
  // files routes only honor them for this trusted principal.
  const orchestratorToken =
    target === "orchestrator" || target === "nextcloud"
      ? (process.env.ORCHESTRATOR_TOKEN ?? "").trim() || null
      : null;
  if (target === "orchestrator" && !orchestratorToken) {
    // Loud at construction so a misconfigured deployment surfaces
    // before any handler tries to use the client. Matches the
    // voice-io pattern (services/voice-io/voice/llm.py line ~441).
    // Don't crash — local dev with AUTH_ENABLED=false still works,
    // and a noisy log is more useful than a failed boot.
    console.warn(
      "[mcp-server] ORCHESTRATOR_TOKEN is empty — outbound calls to " +
        "the orchestrator (/api/matter/*, /api/audit-log/*, ...) will " +
        "401 when AUTH_ENABLED=true. Set ORCHESTRATOR_TOKEN to the " +
        "orchestrator's SERVICE_TOKEN_MCP value before going live.",
    );
  }
  const injectAuth = (h: Record<string, string> = {}): Record<string, string> => {
    if (!orchestratorToken) return h;
    if (h.Authorization || h.authorization) return h;
    return { ...h, Authorization: `Bearer ${orchestratorToken}` };
  };
  return {
    async get(path, opts) {
      return internalFetch(joinUrl(base, path, opts?.params), {
        method: "GET",
        headers: injectAuth(opts?.headers),
        signal: opts?.signal, // WARP-887: honour caller-supplied abort deadlines
      });
    },
    async post(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return internalFetch(joinUrl(base, path), {
        method: "POST",
        headers: injectAuth(headers),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: opts?.signal, // WARP-887
      });
    },
    async patch(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return internalFetch(joinUrl(base, path), {
        method: "PATCH",
        headers: injectAuth(headers),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: opts?.signal, // WARP-887
      });
    },
    async delete(path, opts) {
      return internalFetch(joinUrl(base, path), {
        method: "DELETE",
        headers: injectAuth(opts?.headers),
        signal: opts?.signal, // WARP-887
      });
    },
  };
}

async function main(): Promise<void> {
  runFipsBootSelfTest();

  const transport = parseTransport(process.argv.slice(2));

  // The Prisma client is generated in the orchestrator workspace
  // (`npm run -w @droplet/orchestrator db:generate`). Both the orchestrator
  // and mcp-server resolve `@prisma/client` from the shared root
  // `node_modules`, so a single generation step covers both. The mcp-server
  // postinstall warns if the client isn't generated yet.
  const prisma = new PrismaClient();

  // Singleton embedding client. The mcp-server is the trust boundary
  // for the LLM tool path, so it owns the gRPC channel to ai-gateway —
  // each `search_content` call reuses this stub. WARP-202.
  //
  // The channel is built lazily on the first `embed()` call (see
  // EmbeddingClient.getStub), so a missing or temporarily unreachable
  // ai-gateway at boot does not block stdio startup. `embed()` will
  // throw `UNAVAILABLE` when the ai-gateway is down and `search_content`
  // translates that into the user-facing `EMBEDDING_UNAVAILABLE` error.
  const aiGatewayGrpcUrl = process.env.AI_GATEWAY_GRPC_URL ?? "ai-gateway:50051";
  const embeddingClient = new EmbeddingClient({ url: aiGatewayGrpcUrl });

  // WARP-286: a second gRPC stub for the BGE-reranker-base Rerank RPC.
  // Same lazy-connect / channel-reuse / SHUTDOWN-recover semantics as
  // the embedding stub.
  const rerankerClient = new RerankerClient({ url: aiGatewayGrpcUrl });

  // WARP-286: Redis for the rerank result cache. lazyConnect so a missing
  // / temporarily-unreachable cache does not block stdio startup;
  // `rerankPassages` swallows Redis errors and falls back to live rerank
  // calls without caching.
  const redisUrl = process.env.REDIS_URL;
  // WARP-234: rediss:// (TLS-only cache) pins trust to the internal CA.
  const redis = redisUrl
    ? new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        // ioredis 6 defaults to RESP3 and throws (no fallback) when HELLO 3 is
        // refused. Pin the v5 wire protocol so the bump stays behaviour-
        // identical — matches apps/orchestrator/src/services/cache.service.ts.
        protocol: 2,
        ...redisConnectionOptions(redisUrl),
      })
    : null;

  // Connect lazily — the stdio child process should not block the parent's
  // boot path on a database that may not be reachable (in-process orchestrator
  // tests, dry-run roundtrips). Tools that touch Prisma will trigger the
  // first connection on demand.
  const deps: ContextDeps = {
    prisma,
    // WARP-102 (resolved 2026-05-15): the Matter fabric lives inside
    // the orchestrator process (matter.js + /data/matter-storage
    // volume), so we DO NOT dual-host a controller here. The
    // mcp-server proxies every Matter tool call back to
    // `http://orchestrator:3000/matter/*` via the shared HttpClient
    // factory. See `matter.controller.ts` for the route mapping.
    matter: createMatterController(createHttpClient("orchestrator")),
    httpFactory: createHttpClient,
    embedText: (texts) => embeddingClient.embed(texts),
    // WARP-286: hybrid retrieval shim consumed by the `search_content`
    // tool. We materialize the embedding here, then hand the full pipe
    // (vector, lexical, RRF, rerank) to `searchHybrid`. If Redis is
    // unconfigured we still serve hybrid results without the rerank
    // cache (every call hits ai-gateway).
    searchHybrid: async ({ userId, query, limit, _enhancement }) => {
      const vectors = await embeddingClient.embed([query]);
      const vector = vectors[0];
      if (!vector || vector.length === 0) {
        throw new Error("embedding_service_returned_no_vector");
      }
      // WARP-1014: FileContentChunk rows carry two key shapes since the
      // WARP-493 cutover (nextcloud → username, brain → User.id UUID),
      // and the caller key here is single-shape (stdio `_meta.userId` =
      // username, http `claims.sub` = UUID). Resolve the counterpart so
      // search_content spans both corpora — dual-shape reads (see
      // chunk-owner.ts for the decision record).
      const ownerIds = await resolveChunkOwnerIds(prisma, userId);
      // WARP-437: thread orchestrator-injected enhancement into the
      // searchHybrid pipeline. `queryEnhancement` carries the precomputed
      // HyDE vector / paraphrase vectors / soft filename filter;
      // `minSimilarity` / `perArmK` / `rerank.candidates` are per-call
      // overrides for adaptive routing (factual, analytical, conversational,
      // navigational presets — see llm-agent.service.ts:presetForClass).
      return searchHybrid(prisma, {
        userId: ownerIds[0],
        additionalUserIds:
          ownerIds.length > 1 ? ownerIds.slice(1) : undefined,
        vector,
        query,
        limit,
        minSimilarity: _enhancement?.searchOverrides?.minSimilarity,
        perArmK: _enhancement?.searchOverrides?.perArmK,
        queryEnhancement: _enhancement
          ? {
              hydeVector: _enhancement.hydeVector,
              extraQueryVectors: _enhancement.extraQueryVectors,
              metadataFilter: _enhancement.metadataFilter,
            }
          : undefined,
        // Rerank ALWAYS runs; Redis only caches the scores. When
        // REDIS_URL is unset, substitute a no-op cache (every call
        // hits ai-gateway) instead of dropping the rerank stage —
        // gating rerank on the cache handle silently degraded results
        // to RRF-only ordering. `rerankPassages` already tolerates
        // cache and reranker failures internally, so this is safe in
        // every environment.
        rerank: {
          redis: redis
            ? (redis as unknown as {
                get(k: string): Promise<string | null>;
                setex(k: string, ttl: number, v: string): Promise<unknown>;
              })
            : { get: async () => null, setex: async () => undefined },
          reranker: rerankerClient,
          candidates: _enhancement?.searchOverrides?.rerankCandidates,
        },
      });
    },
    // Ordered whole-document read backing `read_document_text`. No
    // embedding step — this arm addresses a document by path, not by
    // similarity — but it resolves owner keys through the SAME
    // dual-shape helper as search: a document uploaded through chat is
    // keyed by User.id UUID while its Nextcloud twin is keyed by
    // username, so a single-shape predicate here would report a
    // perfectly well-indexed file as NOT_INDEXED.
    readDocumentText: async ({ userId, path, startChunk, maxChars }) => {
      const ownerIds = await resolveChunkOwnerIds(prisma, userId);
      return readDocumentText(prisma, {
        userId: ownerIds[0],
        additionalUserIds: ownerIds.length > 1 ? ownerIds.slice(1) : undefined,
        path,
        startChunk,
        maxChars,
      });
    },
  };

  // Disconnect cleanly when the parent SIGTERMs us. Without this the
  // PrismaClient connection pool would leak across the stdio child boundary,
  // and the gRPC channel to ai-gateway would stay half-open.
  const shutdown = async () => {
    embeddingClient.close();
    rerankerClient.close();
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* best-effort */
      }
    }
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (transport === "stdio") {
    // stdio: one server per process, deliberately the trusted in-process
    // orchestrator child. Trust is declared explicitly via the
    // `local-trusted` posture (WARP-563) — never inferred from absent claims.
    const server = createServer(deps, { kind: "local-trusted" });
    await startStdio(server);
  } else {
    // http: per-request server with JWT-derived claims. JWT_SECRET is
    // required — without it we can't verify Bearer tokens, and starting
    // the listener anyway would silently accept everything if the verify
    // function ever changed.
    const port = Number(process.env.MCP_PORT ?? 9090);
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      console.error("JWT_SECRET is required for the http transport");
      process.exit(2);
    }
    startHttp({
      port,
      jwtSecret,
      // http: untrusted network transport. verifyJwt produces verified claims
      // for every request; wrap them in the explicit `authenticated` posture
      // so RBAC is always applied (WARP-563).
      buildServer: (claims) => createServer(deps, { kind: "authenticated", claims }),
    });
    console.error(`mcp-server listening on :${port} (http, JWT-auth)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

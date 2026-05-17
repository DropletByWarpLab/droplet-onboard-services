#!/usr/bin/env node
import Redis from "ioredis";

import { PrismaClient } from "@prisma/client";
import type { HttpClient } from "@droplet/tools-core";
import { assertFipsAtBootOrExit } from "@droplet/fips-selftest";
import { createServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import type { ContextDeps } from "./context.js";
import { EmbeddingClient } from "./embedding.client.js";
import { RerankerClient } from "./reranker.client.js";
import { searchHybrid } from "./file-search.service.js";
import { mintInternalToken } from "./auth/jwt.js";

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

type HttpTarget = "routing" | "cameras" | "switchSvc" | "fileIndexer" | "nextcloud";

function baseUrlFor(target: HttpTarget): string {
  switch (target) {
    case "routing":
      return process.env.ROUTING_SERVICE_URL ?? "http://host.docker.internal:8080";
    case "cameras":
      return process.env.CAMERA_DISCOVERY_URL ?? "http://camera-discovery:8000";
    case "switchSvc":
      return process.env.SWITCH_SERVICE_URL ?? "http://host.docker.internal:8081";
    case "fileIndexer":
      return process.env.FILE_INDEXER_URL ?? "http://file-indexer:8000";
    case "nextcloud":
      return process.env.NEXTCLOUD_URL ?? "http://nextcloud";
  }
}

function joinUrl(base: string, path: string, params?: Record<string, unknown>): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base.endsWith("/") ? base : `${base}/`);
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
  const base = baseUrlFor(target);
  // When the target is the orchestrator, every request needs a Bearer
  // token the orchestrator's auth middleware will accept. The mcp-server
  // shares JWT_SECRET with the orchestrator, so we mint a short-lived
  // service-principal access token here. Other targets (routing, switch)
  // use their own service-token envs that callers pass via opts.headers.
  // See ./auth/jwt.ts:mintInternalToken for the claims shape + rationale.
  const injectAuth = (h: Record<string, string> = {}): Record<string, string> => {
    if (target !== "orchestrator") return h;
    if (h.Authorization || h.authorization) return h;
    const secret = process.env.JWT_SECRET;
    if (!secret) return h;
    return { ...h, Authorization: `Bearer ${mintInternalToken(secret)}` };
  };
  return {
    async get(path, opts) {
      return fetch(joinUrl(base, path, opts?.params), {
        method: "GET",
        headers: injectAuth(opts?.headers),
      });
    },
    async post(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return fetch(joinUrl(base, path), {
        method: "POST",
        headers: injectAuth(headers),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    async patch(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return fetch(joinUrl(base, path), {
        method: "PATCH",
        headers: injectAuth(headers),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    async delete(path, opts) {
      return fetch(joinUrl(base, path), {
        method: "DELETE",
        headers: injectAuth(opts?.headers),
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
  const redis = redisUrl
    ? new Redis(redisUrl, { maxRetriesPerRequest: 3, lazyConnect: true })
    : null;

  // Connect lazily — the stdio child process should not block the parent's
  // boot path on a database that may not be reachable (in-process orchestrator
  // tests, dry-run roundtrips). Tools that touch Prisma will trigger the
  // first connection on demand.
  const deps: ContextDeps = {
    prisma,
    // Matter stub stays minimal until WARP-102 decides whether the
    // mcp-server hosts its own Matter controller or proxies HTTP back to
    // the orchestrator. WARP-101 only exercises tools that don't touch
    // Matter, so a no-op shim is the safest default.
    matter: {
      listDevices: async () => ({}),
      getDevice: async () => ({}),
      sendCommand: async () => ({}),
      discover: async () => ({}),
      commission: async () => ({}),
      getAuditLog: async () => ({}),
    },
    httpFactory: createHttpClient,
    embedText: (texts) => embeddingClient.embed(texts),
    // WARP-286: hybrid retrieval shim consumed by the `search_content`
    // tool. We materialize the embedding here, then hand the full pipe
    // (vector, lexical, RRF, rerank) to `searchHybrid`. If Redis is
    // unconfigured we still serve hybrid results without the rerank
    // cache (every call hits ai-gateway).
    searchHybrid: async ({ userId, query, limit }) => {
      const vectors = await embeddingClient.embed([query]);
      const vector = vectors[0];
      if (!vector || vector.length === 0) {
        throw new Error("embedding_service_returned_no_vector");
      }
      return searchHybrid(prisma, {
        userId,
        vector,
        query,
        limit,
        rerank: redis
          ? {
              redis: redis as unknown as {
                get(k: string): Promise<string | null>;
                setex(k: string, ttl: number, v: string): Promise<unknown>;
              },
              reranker: rerankerClient,
            }
          : undefined,
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
    // stdio: one server per process, no claims (the orchestrator is the
    // trusted principal). MCP_TRUSTED=1 is the explicit signal the
    // orchestrator sets in the spawn env, but functionally we just don't
    // gate auth on this transport.
    const server = createServer(deps);
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
      buildServer: (claims) => createServer(deps, claims),
    });
    console.error(`mcp-server listening on :${port} (http, JWT-auth)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

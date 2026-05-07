#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import type { HttpClient } from "@droplet/tools-core";
import { createServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import type { ContextDeps } from "./context.js";
import { EmbeddingClient } from "./embedding.client.js";

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
  return {
    async get(path, opts) {
      return fetch(joinUrl(base, path, opts?.params), {
        method: "GET",
        headers: opts?.headers,
      });
    },
    async post(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return fetch(joinUrl(base, path), {
        method: "POST",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    async patch(path, body, opts) {
      const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
      if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return fetch(joinUrl(base, path), {
        method: "PATCH",
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    async delete(path, opts) {
      return fetch(joinUrl(base, path), {
        method: "DELETE",
        headers: opts?.headers,
      });
    },
  };
}

async function main(): Promise<void> {
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
  };

  // Disconnect cleanly when the parent SIGTERMs us. Without this the
  // PrismaClient connection pool would leak across the stdio child boundary,
  // and the gRPC channel to ai-gateway would stay half-open.
  const shutdown = async () => {
    embeddingClient.close();
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

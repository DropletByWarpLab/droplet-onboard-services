import type { PrismaClient } from "@prisma/client";
import type {
  ToolContext,
  MatterController,
  HttpClient,
  PrivateEnhancement,
} from "@droplet/tools-core";
// `Claims` is canonically defined in `auth/jwt.ts` (the only place that
// produces them, by verifying a Bearer JWT). Re-export it from here so
// the existing `import { type Claims } from "./context.js"` callers
// (server.ts, transports/*) keep working without duplicating the type.
import type { Claims } from "./auth/jwt.js";
export type { Claims } from "./auth/jwt.js";

export interface ContextDeps {
  prisma: PrismaClient;
  matter: MatterController;
  httpFactory: (target:
    | "routing"
    | "cameras"
    | "switchSvc"
    | "fileIndexer"
    | "nextcloud"
    | "orchestrator"
  ) => HttpClient;
  /**
   * Optional embedding RPC. Wired in `index.ts` to a singleton gRPC
   * channel against the ai-gateway's `EmbedText` (WARP-202). Surfaces
   * in `ToolContext.embedText` so handlers like `search_content` can
   * vectorize a query without each one owning its own gRPC plumbing.
   *
   * Optional because:
   *   - In-process unit tests don't exercise the embedder.
   *   - On a fresh device the ai-gateway may be unreachable at boot;
   *     handlers must guard with `if (!ctx.embedText)` rather than
   *     crash. `search_content` returns `EMBEDDING_UNAVAILABLE` when
   *     missing and `EMBEDDING_FAILED` when the call throws.
   */
  embedText?: (texts: string[]) => Promise<number[][]>;
  /**
   * WARP-286 — hybrid retrieval shim wired in `index.ts`. The
   * `search_content` tool delegates here so the BM25 + vector + RRF +
   * reranker pipeline lives in one place (`file-search.service.ts` in
   * this workspace; mirrored in the orchestrator for `/knowledge`).
   *
   * Optional because:
   *   - In-process unit tests don't exercise the full search pipeline.
   *   - On a fresh device ai-gateway / redis may be unreachable at
   *     boot; the handler returns `SEARCH_UNAVAILABLE` when this is
   *     missing.
   *
   * Bound per-call with the calling user's id; never pass through
   * unauthenticated.
   */
  searchHybrid?: (args: {
    userId: string;
    query: string;
    limit: number;
    /**
     * WARP-437 — orchestrator-injected enhancement bundle (HyDE vector,
     * extra paraphrase vectors, metadata filter, search overrides). The
     * `index.ts` shim threads this into `searchHybrid`'s
     * `queryEnhancement` + `minSimilarity` / `perArmK` / rerank-candidates
     * knobs. Optional — when absent, baseline retrieval runs.
     */
    _enhancement?: PrivateEnhancement;
  }) => Promise<
    Array<{
      source: "nextcloud" | "brain";
      path: string;
      chunkIdx: number;
      pageNumber: number | null;
      brainItemId: string | null;
      score: number;
      snippet: string;
      metadata: Record<string, unknown> | null;
    }>
  >;
}

/**
 * Resolve `ctx.userId` from the available signals:
 *
 *   - HTTP transport — `claims.sub` is authoritative. `metaUserId` is
 *     ignored even if a malicious client tried to set `_meta.userId`,
 *     because the JWT-derived `claims.sub` is the trust boundary.
 *   - Stdio transport (trusted, `claims === undefined`) — fall back to
 *     `metaUserId` plumbed by the orchestrator's mcp-client. The
 *     orchestrator is the only producer here and synthesizes it from
 *     `req.user.username`, so the transitive trust comes from
 *     `apps/orchestrator/src/middleware/auth.ts` validating the
 *     dashboard cookie/Bearer token.
 */
export function buildContext(
  deps: ContextDeps,
  claims: Claims | undefined,
  signal: AbortSignal,
  ncToken?: string,
  metaUserId?: string,
  metaEnhancement?: PrivateEnhancement,
): ToolContext {
  const userId = claims?.sub ?? metaUserId;
  // WARP-286: bind the searchHybrid shim with the authenticated userId
  // baked in. The tool handler then calls ctx.searchHybrid({ query, limit })
  // without ever seeing (or being able to forge) a userId.
  //
  // WARP-437: also accept an optional `_enhancement` on the per-call args
  // (set by the search_content handler from `ctx._enhancement`). When the
  // handler doesn't pass one, fall back to whatever was plumbed via
  // `_meta._enhancement` (`metaEnhancement`) — both paths converge here so
  // the index.ts shim sees a single `_enhancement` field.
  const searchHybrid =
    deps.searchHybrid && userId
      ? async (args: {
          query: string;
          limit: number;
          enhance?: { hyde?: boolean; multiQuery?: boolean; n?: number };
          _enhancement?: PrivateEnhancement;
        }) =>
          deps.searchHybrid!({
            userId,
            query: args.query,
            limit: args.limit,
            _enhancement: args._enhancement ?? metaEnhancement,
          })
      : undefined;
  return {
    prisma: deps.prisma,
    matter: deps.matter,
    http: {
      routing: deps.httpFactory("routing"),
      cameras: deps.httpFactory("cameras"),
      switchSvc: deps.httpFactory("switchSvc"),
      fileIndexer: deps.httpFactory("fileIndexer"),
      nextcloud: deps.httpFactory("nextcloud"),
      orchestrator: deps.httpFactory("orchestrator"),
    },
    embedText: deps.embedText,
    searchHybrid,
    userId,
    role: claims?.role,
    ncToken,
    _enhancement: metaEnhancement,
    signal,
  };
}

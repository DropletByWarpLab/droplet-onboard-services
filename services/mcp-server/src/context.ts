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

/**
 * WARP-1975 — stamp the acting user on every orchestrator request.
 *
 * The orchestrator scopes camera reads to the acting human's per-camera
 * grants. A tool call arrives as the bare `_service:mcp` principal, which
 * holds no grants of its own, so it has to name the person behind it.
 *
 * Wrapping the client rather than editing 17 handlers is not just less
 * churn — a handler that forgets does not fail loudly. It silently gets an
 * empty result, which reads to the model as "there are no cameras" rather
 * than "you didn't say who you are". One binding cannot be forgotten.
 *
 * A per-call `headers` option still wins, so export_clip's existing
 * X-Nextcloud-Token/User pairing is untouched.
 */
function withActingUser(client: HttpClient, userId: string | undefined): HttpClient {
  if (!userId) return client;
  const acting = { "X-Nextcloud-User": userId };
  // The caller's own headers win, so an explicit per-call assertion (or a
  // paired X-Nextcloud-Token) is never clobbered by the default.
  function merge(opts?: { headers?: Record<string, string> }) {
    return { ...(opts ?? {}), headers: { ...acting, ...(opts?.headers ?? {}) } };
  }

  return {
    get: (path, opts) => client.get(path, merge(opts)),
    post: (path, body, opts) => client.post(path, body, merge(opts)),
    patch: (path, body, opts) => client.patch(path, body, merge(opts)),
    delete: (path, opts) => client.delete(path, merge(opts)),
  };
}
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
  /**
   * Ordered whole-document read shim wired in `index.ts`, backing the
   * `read_document_text` tool. Delegates to `file-search.service.ts` so
   * the RBAC predicate, decrypt-on-read and dual-shape chunk-owner
   * resolution stay in one place — same rationale as `searchHybrid`.
   *
   * Optional for the same reasons: unit tests don't exercise it, and on a
   * fresh device the corpus may be unreachable at boot. The handler
   * returns `DOCUMENT_READ_UNAVAILABLE` when missing.
   *
   * Bound per-call with the calling user's id; never pass through
   * unauthenticated.
   */
  readDocumentText?: (args: {
    userId: string;
    path: string;
    startChunk: number;
    maxChars: number;
  }) => Promise<{
    source: "nextcloud" | "brain";
    chunks: Array<{
      chunkIdx: number;
      pageNumber: number | null;
      text: string;
      warnings: string[];
    }>;
    totalChunks: number;
    unreadableChunks: number;
  }>;
}

/**
 * Resolve `ctx.userId` from the available signals:
 *
 *   - HTTP transport — `claims.sub` is authoritative. `metaUserId` is
 *     ignored even if a malicious client tried to set `_meta.userId`,
 *     because the JWT-derived `claims.sub` is the trust boundary.
 *   - Stdio transport (trusted, `local-trusted` posture → `claims` is
 *     `undefined`) — fall back to
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
  metaUserRole?: string,
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
  // Same binding discipline as searchHybrid: the authenticated userId is
  // baked in here, so the tool handler names a path and never sees (or
  // can forge) an owner key.
  const readDocumentText =
    deps.readDocumentText && userId
      ? async (args: { path: string; startChunk: number; maxChars: number }) =>
          deps.readDocumentText!({ userId, ...args })
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
      // WARP-1975 — assert WHO the assistant is acting for.
      //
      // Camera reads in the orchestrator are scoped to the acting human's
      // per-camera grants. A tool call arrives as the bare `_service:mcp`
      // principal, which holds no grants of its own, so every orchestrator
      // request must name the person behind it. Same `X-Nextcloud-User`
      // header `middleware/space.ts` already uses for department access,
      // and which export_clip/share_clip were already sending by hand.
      //
      // Bound HERE rather than in each handler on purpose: 17 camera
      // handlers cannot all be relied on to remember, and a handler that
      // forgets does not fail loudly — it silently gets an empty result,
      // which reads as "no cameras" rather than "you didn't say who you
      // are". One binding cannot be forgotten.
      //
      // A per-call `headers` option still wins, so export_clip's
      // X-Nextcloud-Token pairing is untouched.
      orchestrator: withActingUser(deps.httpFactory("orchestrator"), userId),
    },
    embedText: deps.embedText,
    searchHybrid,
    readDocumentText,
    userId,
    // HTTP: the JWT claim is authoritative. Stdio (no claims): the
    // orchestrator forwards the caller's role via _meta.userRole
    // (WARP-845) — validated against the Role union, anything else
    // drops to undefined (handlers then use the guest view).
    role:
      claims?.role ??
      (metaUserRole &&
      ["owner", "admin", "family", "guest", "service"].includes(metaUserRole)
        ? (metaUserRole as import("@droplet/tools-core").Role)
        : undefined),
    ncToken,
    _enhancement: metaEnhancement,
    signal,
  };
}

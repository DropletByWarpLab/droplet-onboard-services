import type { PrismaClient } from "@prisma/client";
import type { PrivateEnhancement } from "./private-enhancement.js";

export type Role = "owner" | "admin" | "family" | "guest" | "service";

/**
 * WARP-1611 — the scale a retrieval `score` is expressed in.
 *
 *   - "similarity" — already a bounded 0-1 relevance (a cosine, or a
 *     reranker logit the producer already squashed). Rendered as-is.
 *   - "logit"      — an unbounded cross-encoder output that still needs
 *     a logistic squash before it means anything as a percentage.
 *
 * Mirrors `ScoreKind` in `services/mcp-server/src/file-search.service.ts`
 * (the producer) and `apps/web-dashboard/src/lib/relevance.ts` (the
 * renderer).
 *
 * ALWAYS optional on the wire. Absent means "the producer didn't say",
 * and every consumer falls back to inferring the scale from the value
 * (`inferScoreKind`: inside [0, 1] ⇒ bounded relevance, outside ⇒
 * logit). That fallback is what keeps payloads from older producers —
 * and clients that predate the tag — rendering exactly as they do
 * today. The tag exists so a renderer that CAN be told stops guessing:
 * the guess is only correct while every producer normalizes, and a
 * silently mis-binned scale is what made citation chips read 0% in
 * WARP-859 / WARP-1603.
 */
export type ScoreKind = "logit" | "similarity";

export interface HttpClient {
  // WARP-887: `signal` lets callers (e.g. callOrch's 8s deadline) abort the
  // in-flight request so a slow/unresponsive target doesn't leak an open
  // socket. Optional + backward-compatible — callers without a deadline omit it.
  get(path: string, opts?: { params?: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
  post(path: string, body?: unknown, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
  patch(path: string, body?: unknown, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
  delete(path: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<Response>;
}

export interface MatterController {
  listDevices(): Promise<unknown>;
  getDevice(nodeId: string): Promise<unknown>;
  sendCommand(nodeId: string, command: string, data?: unknown): Promise<unknown>;
  discover(): Promise<unknown>;
  commission(pairingCode: string): Promise<unknown>;
  /** WARP-1447 — unpair a device from the fabric (remove_device tool). */
  decommission(nodeId: string): Promise<unknown>;
  getAuditLog(opts: { entityId?: string; limit?: number }): Promise<unknown>;
}

export interface ToolContext {
  prisma: PrismaClient;
  http: {
    routing: HttpClient;
    cameras: HttpClient;
    switchSvc: HttpClient;
    fileIndexer: HttpClient;
    nextcloud: HttpClient;
    /**
     * The orchestrator's own REST surface (`http://orchestrator:3000`).
     * Use for handlers that need data the orchestrator already
     * aggregates (e.g. `/api/cameras` wraps camera-discovery + Frigate
     * state into a single canonical shape; `/api/matter/*` exposes the
     * Matter fabric). The mcp-server's `createHttpClient` auto-injects
     * a service-principal Bearer JWT on every call to this target.
     */
    orchestrator: HttpClient;
  };
  matter: MatterController;
  /** Embed one or more texts. Used by `search_content` to vectorize the
   *  query before the pgvector lookup. The MCP server wires this to the
   *  orchestrator's gRPC client to ai-gateway; on stdio in-proc this is
   *  a direct call. May be undefined when the embedder is unavailable —
   *  handlers should fall through to a clean error in that case. */
  embedText?: (texts: string[]) => Promise<number[][]>;
  /**
   * WARP-286 / WARP-437 — hybrid retrieval shim. Orchestrator binds this
   * to `file-search.service.ts`'s `searchHybrid`. The optional `enhance`
   * block is the LLM-facing knob for HyDE / multi-query; the orchestrator
   * may also inject pre-computed enhancement data via a private field
   * (see Task 8). Returns results already filtered by RBAC. When absent
   * (embedder unavailable at context-build time) the handler returns
   * `SEARCH_UNAVAILABLE`.
   */
  searchHybrid?: (args: {
    query: string;
    limit: number;
    enhance?: { hyde?: boolean; multiQuery?: boolean; n?: number };
    /**
     * WARP-437 — orchestrator-injected enhancement bundle. NOT settable by
     * the LLM (the tool's JSON schema rejects unknown args via
     * `additionalProperties: false`). Routed via MCP `_meta._enhancement`
     * and stashed on `ctx._enhancement`; the handler forwards it here.
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
      /**
       * WARP-1611 — optional scale tag for `score`. mcp-server's
       * `rerankPassages` stamps "similarity" because it normalizes the
       * BGE logit at the source (WARP-1603); a producer that hands back
       * a raw cross-encoder output would stamp "logit".
       *
       * Optional so a shim written before the tag existed stays
       * assignable to this signature unchanged, and so hits that arrive
       * without it keep flowing through as untagged.
       */
      scoreKind?: ScoreKind;
      snippet: string;
      metadata: Record<string, unknown> | null;
    }>
  >;
  /**
   * Ordered whole-document read shim, bound per-call with the caller's
   * userId — the retrieval-side counterpart to {@link searchHybrid}.
   * Orchestrator/mcp-server binds this to `file-search.service.ts`'s
   * `readDocumentText`.
   *
   * Lives here as an injected shim rather than a prisma query inside the
   * handler for the same reason `searchHybrid` does: decrypt-on-read
   * (WARP-242), dual-shape chunk-owner resolution (WARP-1014) and the
   * RBAC predicate are server-side concerns, and a second copy in a
   * handler is a second copy free to drift.
   *
   * `totalChunks === 0` means the path has NO extracted text at all —
   * the handler turns that into a loud `NOT_INDEXED` rather than an empty
   * success, because a silently-skipped extraction is indistinguishable
   * from an empty document at every layer above this one.
   *
   * When absent (file index unreachable at context-build time) the
   * handler returns `DOCUMENT_READ_UNAVAILABLE`.
   */
  readDocumentText?: (args: {
    path: string;
    /** 0-based chunk index to resume from. */
    startChunk: number;
    /** Approximate character budget; whole chunks are always returned. */
    maxChars: number;
  }) => Promise<{
    source: "nextcloud" | "brain";
    chunks: Array<{
      chunkIdx: number;
      pageNumber: number | null;
      text: string;
      warnings: string[];
    }>;
    /** Total chunks for this path, ignoring the window. 0 ⇒ not indexed. */
    totalChunks: number;
    /** Chunks dropped in the window because their DEK is missing or
     *  authentication failed — surfaced, never silently swallowed. */
    unreadableChunks: number;
  }>;
  userId?: string;
  /** Caller's role. HTTP transport: from JWT claims. Stdio: forwarded by
   *  the orchestrator via `_meta.userRole` (WARP-845 role-scoped memory
   *  reads). Absent → role-scoped handlers use the most-restrictive
   *  guest view. */
  role?: Role;
  ncToken?: string;
  /**
   * WARP-437 — orchestrator-injected enhancement bundle plumbed through
   * MCP `_meta._enhancement`. Trusted-stdio-only; the HTTP transport
   * does not propagate this field. Handlers (currently only
   * `search_content`) forward it to `ctx.searchHybrid({ ..., _enhancement })`.
   */
  _enhancement?: PrivateEnhancement;
  signal: AbortSignal;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ToolError; status: "error" | "confirmation_required" };

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  requiresWrite: boolean;
  requiresConfirmation: boolean;
  handler: ToolHandler;
}

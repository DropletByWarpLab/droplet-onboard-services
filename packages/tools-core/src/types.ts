import type { PrismaClient } from "@prisma/client";

export type Role = "owner" | "admin" | "family" | "guest" | "service";

export interface HttpClient {
  get(path: string, opts?: { params?: Record<string, unknown>; headers?: Record<string, string> }): Promise<Response>;
  post(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  patch(path: string, body?: unknown, opts?: { headers?: Record<string, string> }): Promise<Response>;
  delete(path: string, opts?: { headers?: Record<string, string> }): Promise<Response>;
}

export interface MatterController {
  listDevices(): Promise<unknown>;
  getDevice(nodeId: string): Promise<unknown>;
  sendCommand(nodeId: string, command: string, data?: unknown): Promise<unknown>;
  discover(): Promise<unknown>;
  commission(pairingCode: string): Promise<unknown>;
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
  userId?: string;
  role?: Role;
  ncToken?: string;
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

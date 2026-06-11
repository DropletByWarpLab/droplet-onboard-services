import type { PrismaClient } from "@prisma/client";
import type { PrivateEnhancement } from "./private-enhancement.js";

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
      snippet: string;
      metadata: Record<string, unknown> | null;
    }>
  >;
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
  /**
   * WARP-860 — runtime-provisioned Plane service API token (the name
   * WARP-543's AC reserves). The orchestrator mints it through Plane's
   * session app API at boot/wizard time and forwards it per-call via
   * `_meta.pmToken` on the trusted stdio transport; the HTTP transport
   * ignores it (an HTTP client must not inject credentials). The `pm_*`
   * handlers forward it into every pm-client call; absent → the client
   * falls back to the legacy `DROPLET_PM_ADMIN_TOKEN` env var.
   */
  pmApiKey?: string;
  /**
   * WARP-860 — orchestrator-injected Plane workspace list, consumed by
   * `pm_list_workspaces` ONLY. Plane CE v0.24.1 has no
   * `/api/v1/workspaces/` endpoint (404), so the orchestrator resolves
   * the list through the session app API and injects it via
   * `_meta.pmWorkspaces` (trusted stdio only, same posture as
   * `pmApiKey`). Absent/empty → the handler falls through to the HTTP
   * call and surfaces the CE gap as PM_API_ERROR.
   */
  pmWorkspaces?: { id: string; slug: string; name: string }[];
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

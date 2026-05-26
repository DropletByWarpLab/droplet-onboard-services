/**
 * MCP stdio client for the orchestrator.
 *
 * Owns one long-lived `Client` connected to a child `mcp-server` process
 * over stdin/stdout. The orchestrator's agent loop borrows this singleton
 * (see `mcp-client.singleton.ts`) so we get one process per orchestrator
 * lifetime, not one per chat request.
 *
 * `tools/list` is cached for the process — the registry is static across
 * an mcp-server boot, so re-listing on every chat would be wasted RPC.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { PrivateEnhancement } from "@droplet/tools-core";

export interface McpClientOptions {
  command: string;
  args?: string[];
  /** Extra env vars merged on top of `process.env` for the spawned child. */
  env?: Record<string, string>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ToolCallResult {
  content: { type: string; text?: string }[];
  isError: boolean;
}

export class McpClientService {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private toolsCache: ToolDescriptor[] | null = null;

  constructor(private readonly opts: McpClientOptions) {}

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args ?? [],
      env: this.opts.env
        ? { ...(process.env as Record<string, string>), ...this.opts.env }
        : undefined,
    });
    this.client = new Client(
      { name: "droplet-orchestrator", version: "0.1.0" },
      { capabilities: {} },
    );
    await this.client.connect(this.transport);
  }

  async stop(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // best-effort: stop() runs from SIGTERM/test teardown so we should
      // never let a stale child block shutdown.
    }
    this.client = null;
    this.transport = null;
    this.toolsCache = null;
  }

  /**
   * Whether the underlying client has been started. Useful for the
   * orchestrator's agent loop so a route handler doesn't blow up if the
   * MCP child failed to boot — we can fall back to "no tools available."
   */
  get isStarted(): boolean {
    return this.client !== null;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (!this.client) throw new Error("MCP client not started");
    if (this.toolsCache) return this.toolsCache;
    const res = await this.client.listTools();
    this.toolsCache = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as object,
    }));
    return this.toolsCache;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context?: McpCallContext,
  ): Promise<ToolCallResult> {
    if (!this.client) throw new Error("MCP client not started");
    // Per-call session context is plumbed via the MCP `_meta` field
    // (reserved by the MCP spec for protocol metadata that should NOT
    // be forwarded to the tool itself). The mcp-server's
    // `CallToolRequestSchema` handler reads it and attaches the
    // resulting fields to the per-call `ToolContext`. Today this
    // carries `ncToken` so file-tool handlers can authenticate to
    // Nextcloud as the dashboard user. Stdio is in-process trusted, so
    // passing the user's session token here is safe.
    const params: {
      name: string;
      arguments: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    } = { name, arguments: args };
    if (context && Object.keys(context).length > 0) {
      params._meta = { ...context };
    }
    const res = await this.client.callTool(params);
    return {
      content: (res.content ?? []) as { type: string; text?: string }[],
      isError: Boolean(res.isError),
    };
  }
}

/**
 * Per-call session context plumbed through MCP `_meta`. Add fields here
 * as the agent grows new session-bound credentials (e.g. a future
 * device-side OAuth bearer for camera ops). Keep this narrow — anything
 * placed here is reachable by every handler in the registry, so don't
 * pile on unrelated context.
 */
export interface McpCallContext {
  /** Nextcloud session token for the calling user — required by file-tool handlers. */
  ncToken?: string;
  /**
   * Nextcloud username for the calling user. Forwarded as
   * `_meta.userId` to the stdio child so handlers gated on the per-user
   * RBAC boundary (e.g. `search_content`'s pgvector lookup, WARP-202)
   * can scope queries to this user's chunks. The mcp-server's HTTP
   * transport ignores `_meta.userId` — JWT claims (`claims.sub`) are
   * the authoritative trust boundary there.
   */
  userId?: string;
  /**
   * WARP-437 — adaptive-routing enhancement bundle (HyDE vector,
   * paraphrase vectors, filename filter, search overrides). Set by the
   * agent loop right before dispatching `search_content`. Routed via
   * MCP `_meta._enhancement` so it bypasses the tool's strict input
   * schema (`additionalProperties: false`); only the trusted-stdio
   * transport propagates it to handlers. Never set this from a user-
   * facing route — the trust boundary is the agent loop itself.
   */
  _enhancement?: PrivateEnhancement;
}

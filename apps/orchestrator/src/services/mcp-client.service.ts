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
import { recordActivity } from "./activity.singleton.js";
import {
  confirmationActivityParams,
  confirmedEvent,
  interceptorEventFromContent,
} from "./confirmation-audit.js";

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
    let res;
    let threw: unknown = null;
    try {
      res = await this.client.callTool(params);
    } catch (err) {
      threw = err;
      throw err;
    } finally {
      // WARP-456: signed audit row for the tool dispatch. Always
      // emitted — success, tool-reported failure, and SDK throw.
      // We omit the raw args because they may carry user secrets
      // (Nextcloud tokens for file tools); only the tool name +
      // outcome + caller identity make it into the chain.
      const isError =
        threw !== null || Boolean((res as { isError?: boolean } | undefined)?.isError);
      void recordActivity({
        kind: "tool_call",
        severity: isError ? "err" : "ok",
        sourceIcon: "wrench",
        what: isError ? `Tool ${name} failed` : `Tool ${name}`,
        sub: context?.userId ? `for ${context.userId}` : null,
        // WARP-181: agent-loop dispatch. context.userId is the caller's
        // USERNAME (WARP-202), not a canonical UUID — it stays in refs;
        // actorId stays null until a UUID is actually plumbed through.
        actor: { type: "ai", id: null },
        refs: stripUndefined({
          name,
          userId: context?.userId,
          ok: !isError,
        }),
      }).catch(() => {
        // Recorder already swallows internally; defence-in-depth.
      });

      // WARP-2352 — a SECOND, distinct row when the WARP-2305 interceptor
      // acted: a challenge issued, a token refused, a runtime deny, or a
      // confirmation consumed. The row above records that a dispatch
      // happened; this one records what the confirmation gate decided,
      // so an operator can answer "what was approved and what was
      // refused" without inferring it from tool names.
      //
      // Same single writer (`activity.service.ts` record()), no second
      // write path. Never carries tool arguments — see
      // `confirmation-audit.ts`.
      const content = (res as { content?: { type: string; text?: string }[] } | undefined)
        ?.content;
      const confirmationEvent =
        (content ? interceptorEventFromContent(content) : null) ??
        confirmedEvent({
          tool: name,
          presentedToken: typeof context?.confirmationToken === "string",
          isError,
        });
      if (confirmationEvent) {
        void recordActivity(
          confirmationActivityParams(confirmationEvent, { userId: context?.userId }),
        ).catch(() => {
          // Recorder already swallows internally; defence-in-depth.
        });
      }
    }
    return {
      content: (res!.content ?? []) as { type: string; text?: string }[],
      isError: Boolean(res!.isError),
    };
  }
}

function stripUndefined(
  o: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
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
   * WARP-845 — caller's role, forwarded as `_meta.userRole` so
   * role-scoped handlers (memory_recall's audience ladder) can filter
   * what the model may read. Stdio-trusted only; the HTTP transport
   * ignores it (restrictive guest default applies there).
   */
  userRole?: string;
  /**
   * WARP-2305 — a confirmation token minted by the dispatch-path
   * interceptor, forwarded as `_meta.confirmationToken`.
   *
   * `_meta` rather than a tool argument for the same reason `ncToken`
   * lives here: it is protocol metadata, not payload. That also keeps it
   * clear of every tool's `additionalProperties: false` input schema and
   * keeps the interceptor's argument-binding hash over untouched
   * arguments.
   *
   * DELIBERATELY NOT SET BY THE AGENT LOOP. The token is returned to the
   * caller in the challenge and comes back from the human approval
   * surface (the WARP-640 dashboard confirm chip). If the agent loop
   * re-attached a token it had just been handed, the model would be
   * approving its own writes — which is precisely the hole WARP-2305
   * closes. See `docs/tool-confirmation-contract.md`.
   */
  confirmationToken?: string;
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

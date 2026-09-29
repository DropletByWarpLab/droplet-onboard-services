/**
 * WARP-2391 — the seam between the agent loop and "an MCP server".
 *
 * WHY THIS EXISTS. `AgentDeps.mcp` was typed as the concrete
 * `McpClientService`, which is a **child-process supervisor**: it owns a
 * `StdioClientTransport`, spawns `services/mcp-server/dist/index.js`, and
 * caches that one child's `tools/list`. ADR-043 says the box will hold more
 * than one MCP session (`docs/ADR-043-outbound-mcp-client.md` §Follow-ups),
 * and the loop's dependency has to widen before any of that can be built —
 * otherwise every remote-session change lands as a change to the stdio
 * supervisor, which is the file with the fewest reasons to change in the tree.
 *
 * WHAT THE PORT IS. Exactly the three members the agent loop actually uses:
 * `isStarted`, `listTools()` and `callTool()`. Deliberately NOT `start()` /
 * `stop()`: those are process-lifecycle concerns owned by
 * `mcp-client.singleton.ts` and `index.ts`, and a remote session's lifecycle
 * is not a child process's (ADR-043 §4 — flipping the off-LAN channel off
 * tears sessions down; nothing tears a stdio child down that way). Keeping
 * them off the port is what stops the loop from acquiring an opinion about
 * either.
 *
 * WHAT IT IS NOT. It is not an abstraction over "a transport". The multiplexer
 * (`mcp-multiplexer.service.ts`) implements this port and composes N others,
 * which is only possible because the port says nothing about how a call is
 * carried. Adding a transport-shaped member here would break that.
 *
 * ADR-043 §5 BOUNDARY. This file names no transport and imports no SDK.
 * The orchestrator process must never hold a remote MCP socket; the port is
 * how it talks to one without holding it.
 */
import type { PrivateEnhancement } from "@droplet/tools-core";
import type { DashboardPage } from "@droplet/shared-types";

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
   * WARP-2177 — the durable agent run this dispatch belongs to. Lands on the
   * `tool_call` ActivityRow as `refs.agentRunId` so the Activity surface can
   * group a run's calls — no new activity kind (`KNOWN_KINDS` is a closed
   * allow-list that throws, the same reasoning ADR-014 gave for
   * `refs.targetDeviceId`). Rides `_meta` like every other field here; the
   * mcp-server ignores it.
   */
  agentRunId?: string;
  /**
   * WARP-2896 — the workshop workspace the run works in, when it has one.
   * Read by the `workspace_*` handlers to address their workspace; the
   * orchestrator route re-derives the binding from `agentRunId`, so this is
   * an address, never an authorisation. Stdio-trusted, like `agentRunId`.
   */
  workspaceId?: string;
  /**
   * WARP-3116 — the pages the calling dashboard can open, validated by the
   * chat route. Read by `find_dashboard_page` / `open_dashboard_page`;
   * stdio-trusted, and never a grant — the dashboard's own route guards and
   * the orchestrator's `requireRole` still decide what a page shows.
   */
  dashboardPages?: DashboardPage[];
  /**
   * WARP-2900 — the promoted extension that made this call, when an
   * extension called back into the box as its installing owner
   * (`POST /api/extensions/self/call`). Lands on the `tool_call` row as
   * `refs.extensionId` through `extensionAuditRefs`; never an authorisation
   * (the route resolved the owner and their reach before dispatching).
   * Rides `_meta` like every field here; the mcp-server ignores it.
   */
  extensionId?: string;
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

/**
 * One tool as the model will see it. Structurally the MCP `tools/list` entry
 * minus the fields ADR-043 §2 forbids reading — `annotations`
 * (`readOnlyHint` / `destructiveHint`) is absent BY CONSTRUCTION, not by
 * convention, so no implementation of this port can hand a server-supplied
 * privilege claim to a caller.
 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

/** The result of one dispatch. `isError` covers both a tool-reported failure
 *  and a refusal by a gate in front of the tool. */
export interface McpToolCallOutcome {
  content: { type: string; text?: string }[];
  isError: boolean;
}

/**
 * What the agent loop needs from "the MCP side of the box".
 *
 * Implementations on `stage` after WARP-2300:
 *   - `McpClientService`      — the one stdio child (`mcp-client.service.ts`).
 *   - `McpToolMultiplexer`    — that child plus N remotes
 *                               (`mcp-multiplexer.service.ts`).
 */
export interface McpClientPort {
  /**
   * Whether this port can serve calls. A route handler checks it so a failed
   * MCP boot degrades to "no tools available" rather than a 500.
   */
  readonly isStarted: boolean;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * `context` is per-call session metadata carried in MCP `_meta` — a
   * Nextcloud session token, the caller's username, a confirmation token.
   * It is TRUSTED-STDIO material: see `mcp-multiplexer.service.ts`, which
   * refuses to forward it to a remote server.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    context?: McpCallContext,
  ): Promise<McpToolCallOutcome>;
}

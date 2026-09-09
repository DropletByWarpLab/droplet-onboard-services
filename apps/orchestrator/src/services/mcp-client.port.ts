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
import type { McpCallContext } from "./mcp-client.service.js";

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

/**
 * WARP-2418 — the ONE client-side seam through which a runtime-discovered
 * tool becomes visible to tool selection, and the operator allowlist that
 * gates it.
 *
 * ## What "teach TOOLS / TOOL_CATALOG / TOOL_ROUTES about runtime tools" means
 *
 * It means the opposite of writing into them, and the distinction is the whole
 * design:
 *
 *   - **`TOOLS`** (`packages/tools-core/src/registry.ts`) is a frozen literal
 *     array of handlers compiled into the box. A remote tool has no handler of
 *     ours (ADR-043 §3), so it has nothing to put there. "Destructive actions
 *     are blocked" is implemented BY absence from that array
 *     (`__tests__/storage-pool-tools.test.ts`); injecting wire-sourced entries
 *     would make that guarantee mean something weaker without anyone editing
 *     the test that states it.
 *   - **`TOOL_CATALOG` / `DOMAIN_GROUPS`** are derived from `TOOLS` and
 *     CI-gated for completeness (`catalog.test.ts`). The catalog answers "what
 *     is installed on this box" for the dashboard `/tools` surface; a session
 *     to a vendor's server is not an installed capability, and a catalog that
 *     said so would be lying to the operator.
 *   - **`TOOL_ROUTES`** declares which orchestrator route each handler dials,
 *     so the admission suite can prove the `_service:mcp` principal reaches
 *     it. A remote tool dials no route of ours. A row would be a fiction the
 *     cross-check would then have to be taught to skip.
 *
 * So the seam is a PARALLEL layer: `runtime-tool-registry.service.ts` holds
 * the descriptors, `tool-selection.service.ts` reads both layers with the
 * static one winning, and this module is the only thing that writes to it.
 * `runtime-tool-registry.service.ts`'s own header carries the matching
 * rationale — this file is the writer it says WARP-2300 would bring.
 *
 * ## The allowlist ships EMPTY, and that is a budget decision as well as a
 * safety one
 *
 * ADR-043's Consequences are explicit: the context window is already
 * over-subscribed, the full local registry no longer fits `OLLAMA_CONTEXT_LENGTH`
 * at all, and per-turn selection (WARP-2348) gates any remote catalog reaching
 * default chat. Advertising a 50-tool Atlassian catalog on a box that has not
 * opted in makes the assistant worse at everything else it does. So
 * {@link parseRemoteMcpAllowlist} of an unset variable is the empty set, an
 * empty set allows no server, and nothing remote is advertised until an
 * operator names a server id.
 */
import { TOOLS, type ToolDomain } from "@droplet/tools-core";
import { createLogger } from "../lib/logger.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";
import {
  parseNamespacedToolName,
  type McpToolMultiplexer,
  type RemoteRejection,
} from "./mcp-multiplexer.service.js";
import {
  resolveRuntimeToolDomain,
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
  type RuntimeToolRegistry,
} from "./runtime-tool-registry.service.js";

const logger = createLogger("remote-mcp-servers");

/**
 * The operator's allowlist of remote MCP server ids.
 *
 * Comma-separated, whitespace-tolerant, case-normalised to lowercase (server
 * ids are lowercase by {@link McpToolMultiplexer}'s own pattern, so an
 * operator typing `Atlassian` gets the server they meant rather than a silent
 * miss).
 */
export const REMOTE_MCP_ALLOWLIST_ENV = "REMOTE_MCP_SERVER_ALLOWLIST";

/** Parse the allowlist. An unset / blank / all-separators value is EMPTY. */
export function parseRemoteMcpAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** Every tool name compiled into this box. The set a remote tool may not
 *  shadow — read off the live registry so it can never be a stale copy. */
export function localToolNames(): ReadonlySet<string> {
  return new Set(TOOLS.keys());
}

export interface RemoteCatalogSyncOptions {
  /** Operator-configured domain for this server. Wins over `serverDomain`. */
  operatorDomain?: ToolDomain;
  /** Domain the server declared for itself. A hint from outside the box. */
  serverDomain?: ToolDomain;
  /** Injectable for tests; defaults to the process-wide registry. */
  registry?: RuntimeToolRegistry;
}

export interface RemoteCatalogSyncResult {
  serverId: string;
  registered: RuntimeToolDescriptor[];
  /** Everything the multiplexer or this seam refused, so a caller can render
   *  "3 of 50 tools were not registered, and why" rather than a count. */
  rejected: readonly RemoteRejection[];
}

/**
 * Read one attached server's vetted catalog out of the multiplexer and
 * publish it to the runtime tool registry.
 *
 * The multiplexer has already namespaced the names and dropped collisions;
 * this adds the one thing selection needs and a wire catalog cannot supply —
 * a domain — and re-checks the local-shadowing rule at the registry boundary.
 * That re-check is not redundant: the two layers are written to be
 * independently sufficient, so removing either one has to turn a test red
 * (WARP-2420).
 */
export function syncRemoteCatalog(
  mux: McpToolMultiplexer,
  serverId: string,
  opts: RemoteCatalogSyncOptions = {},
): RemoteCatalogSyncResult {
  const registry = opts.registry ?? runtimeToolRegistry;
  const locals = localToolNames();
  const rejected: RemoteRejection[] = [];
  const registered: RuntimeToolDescriptor[] = [];

  for (const tool of mux.remoteCatalog(serverId)) {
    if (locals.has(tool.name)) {
      // Defence in depth for WARP-2420: the multiplexer refuses this too, but
      // a registry that trusted its caller would be one refactor away from
      // letting a wire-sourced name take a local tool's selection slot.
      rejected.push({
        code: "SHADOWS_LOCAL_TOOL",
        serverId,
        toolName: tool.name,
        message: `"${tool.name}" is a registered local tool; refusing to register it as remote.`,
      });
      continue;
    }
    registered.push(toRuntimeDescriptor(serverId, tool, opts));
  }

  registry.registerServerTools(serverId, registered);
  logger.info(
    { serverId, registered: registered.length, rejected: rejected.length },
    "remote_catalog_synced",
  );
  return { serverId, registered, rejected: [...rejected, ...mux.rejections()] };
}

/** Drop a server's runtime tools — the disconnect / allowlist-removal path. */
export function unregisterRemoteServer(
  serverId: string,
  registry: RuntimeToolRegistry = runtimeToolRegistry,
): void {
  registry.unregisterServer(serverId);
}

function toRuntimeDescriptor(
  serverId: string,
  tool: McpToolDescriptor,
  opts: RemoteCatalogSyncOptions,
): RuntimeToolDescriptor {
  const { domain, source } = resolveRuntimeToolDomain({
    toolName: tool.name,
    serverId,
    operatorDomain: opts.operatorDomain,
    serverDomain: opts.serverDomain,
  });
  return {
    name: tool.name,
    serverId,
    domain,
    domainSource: source,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
  };
}

/**
 * The namespaced-name reader the rest of the orchestrator should use to ask
 * "is this a remote tool, and whose?" — so nothing else re-derives the
 * separator convention.
 */
export function remoteServerIdOf(toolName: string): string | null {
  return parseNamespacedToolName(toolName)?.serverId ?? null;
}

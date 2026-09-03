/**
 * Process-wide MCP client singleton.
 *
 * One stdio child process per orchestrator process. Booted lazily during
 * Express startup (`ensureMcpStarted` from `index.ts`) and stopped on
 * SIGTERM/SIGINT. The agent loop in `/api/llm/chat` and any future
 * MCP-aware route just imports `mcpClient` and calls `listTools()` /
 * `callTool()`; the heavy lifting lives in `McpClientService`.
 *
 * WARP-2395 — `mcpClient` is now an `McpToolMultiplexer` wrapping that child
 * rather than the child itself. The child is still the only session a
 * shipping box has (the remote allowlist is empty), and the exported name,
 * type surface and behaviour are unchanged for every importer.
 *
 * The path resolution prefers an explicit `MCP_SERVER_BIN` env var (set
 * by Docker / dev scripts) and falls back to the workspace-relative
 * `services/mcp-server/dist/index.js`. The fallback uses `process.cwd()`
 * because the orchestrator's `package.json` does not set
 * `"type": "module"`, so `import.meta.url` would trip tsc.
 */
import path from "node:path";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { createAtlassianRemoteCallPolicy } from "./atlassian-tool-policy.js";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { McpClientService } from "./mcp-client.service.js";
import { DENY_ALL_REMOTE_TOOLS, McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
  parseRemoteMcpAllowlist,
  type AttachAtlassianDeps,
  type RemoteAttachResult,
} from "./remote-mcp-servers.js";
import type { RemoteMcpReconcilerDeps } from "./remote-mcp-reconciler.service.js";

const logger = createLogger("mcp-client-singleton");

const SERVER_BIN =
  process.env.MCP_SERVER_BIN ??
  path.resolve(process.cwd(), "../../services/mcp-server/dist/index.js");

/** The one stdio child. Still the only thing that exists on a shipping box —
 *  see {@link mcpClient} for why it is no longer what callers hold. */
const localClient = new McpClientService({
  command: process.execPath,
  args: [SERVER_BIN, "--transport=stdio"],
  // Pass MCP_TRUSTED so the future HTTP-transport child knows the parent
  // is the trusted principal (no JWT to verify) — see spec §7.2. Stdio
  // ignores it today, but flagging it now keeps the wiring explicit.
  //
  // ORCHESTRATOR_TOKEN: the child's network/tool handlers call BACK into
  // this orchestrator's /api surface and inject
  // `process.env.ORCHESTRATOR_TOKEN` as the bearer
  // (services/mcp-server/src/index.ts). Compose defines SERVICE_TOKEN_MCP on
  // the orchestrator container but never ORCHESTRATOR_TOKEN (that name is
  // only wired on the SIBLING http mcp-server container), so on a
  // provisioned box (AUTH_ENABLED=true) every chat-path tool call 401'd one
  // hop in — the exact failure class this PR fixes (review blocker). Hand
  // the service-principal token to the child explicitly.
  env: {
    MCP_TRUSTED: "1",
    ...(config.SERVICE_TOKEN_MCP
      ? { ORCHESTRATOR_TOKEN: config.SERVICE_TOKEN_MCP }
      : {}),
  },
});

/**
 * WARP-2395 — what every caller holds is the MULTIPLEXER, not the stdio
 * child. With no remote server attached it delegates every member straight
 * through, so this is byte-for-byte the previous behaviour; the point is that
 * attaching one later is a call to `attachRemote`, not a change to the twelve
 * modules that import this name.
 *
 * The allowlist is read once at module load and ships EMPTY
 * (`REMOTE_MCP_SERVER_ALLOWLIST`, config.ts), so on any box that has not been
 * configured `attachRemote` refuses every server.
 *
 * WARP-2316 — the remote call policy is no longer the bare deny-everything
 * default. It is the ATLASSIAN policy, layered OVER that default: a name in
 * `atlassian-tool-policy.ts`'s explicit read list is allowed, and everything
 * else — every Atlassian write, every Atlassian tool nobody classified, and
 * every tool of every other server — falls through to
 * {@link DENY_ALL_REMOTE_TOOLS}.
 *
 * That is ADR-043 §3 read as written rather than relaxed: *"Read-only
 * invocation of tools an operator has explicitly demoted to read status under
 * §2 may ship before those land. Writes may not."* The table §2 requires now
 * exists, in this repo, reviewed as a diff on
 * `docs/security/atlassian-mcp-tool-surface.json`. Writes stay blocked.
 *
 * The observable behaviour on a shipping box is UNCHANGED, because the
 * allowlist is empty and no server can attach — the policy only matters once
 * an operator opts in.
 */
const remoteAllowlist = parseRemoteMcpAllowlist(config.REMOTE_MCP_SERVER_ALLOWLIST);

export const mcpClient = new McpToolMultiplexer(localClient, {
  isServerAllowed: (serverId) => remoteAllowlist.has(serverId),
  // `api-token` because that is the only credential a v1 box can hold: ADR-043
  // §7 classifies Atlassian as the customer-created-credential model and the
  // OAuth endpoint (`/v1/mcp/authv2`) is an explicit non-goal. The mode is a
  // parameter rather than an assumption so the Compass half of the auth-mode
  // matrix is expressible and testable.
  remoteCallPolicy: createAtlassianRemoteCallPolicy({
    authMode: "api-token",
    fallback: DENY_ALL_REMOTE_TOOLS,
  }),
});

let started = false;

export async function ensureMcpStarted(): Promise<void> {
  if (started) return;
  await localClient.start();
  started = true;
}

export async function stopMcp(): Promise<void> {
  if (!started) return;
  await localClient.stop();
  started = false;
}

/**
 * WARP-2627 — attach the outbound Atlassian session, if this box is entitled.
 *
 * Called once from `index.ts` after the stdio child is up. On the SHIPPING
 * default — `REMOTE_MCP_SERVER_ALLOWLIST` empty — this returns
 * `not_allowlisted` having touched no network and constructed no client, so the
 * boot path is byte-identical to before this PR on every unconfigured box.
 *
 * The socket lives in `services/mcp-bridge` (ADR-043 §5); what is constructed
 * here is an HTTP client for it, wrapped by the gate → audit front.
 */
export async function ensureRemoteMcpAttached(
  prisma: AttachAtlassianDeps["prisma"],
  /** WARP-2651 — the catalog a previous attach vetted. Absent at boot: this
   *  process has vetted nothing yet, and an empty baseline is not the same
   *  claim as no baseline. */
  knownTools?: readonly string[],
): Promise<RemoteAttachResult> {
  const result = await attachAtlassianRemote({
    mux: mcpClient,
    prisma,
    allowlist: remoteAllowlist,
    createClient: () => createBridgeClient(ATLASSIAN_REMOTE_SERVER_ID),
    ...(knownTools !== undefined ? { knownTools } : {}),
  });
  if (result.attached) {
    logger.info(
      { serverId: result.serverId, tools: result.sync.registered.length },
      "remote_mcp_attached",
    );
  }
  return result;
}

/** One bridge client for a given server id. A factory rather than a singleton
 *  because the orphan sweep needs a client for an id this process never
 *  attached — the whole point of WARP-2651's failure (1). */
function createBridgeClient(serverId: string): McpBridgeClient {
  return new McpBridgeClient({
    baseUrl: config.MCP_BRIDGE_URL,
    serviceToken: config.MCP_BRIDGE_SERVICE_TOKEN,
    serverId,
  });
}

/**
 * WARP-2651 — the reconciler's production wiring.
 *
 * Every dependency is a thin adapter onto something that already exists: the
 * bridge client's `/health` and `DELETE`, the multiplexer's `detachRemote`, and
 * the SAME `attachAtlassianRemote` the boot path uses — so the re-open is not a
 * second, parallel implementation of "open a session" that could drift from the
 * gated one.
 */
export function remoteMcpReconcilerDeps(
  prisma: AttachAtlassianDeps["prisma"],
): RemoteMcpReconcilerDeps {
  return {
    health: () => createBridgeClient(ATLASSIAN_REMOTE_SERVER_ID).health(),
    closeSession: async (serverId) => {
      await createBridgeClient(serverId).close();
    },
    detach: (serverId) => {
      mcpClient.detachRemote(serverId);
    },
    // `serverId` is ignored because there is exactly one attachable server
    // today — `SESSION_FACTORIES` has one entry and `attachAtlassianRemote` is
    // Atlassian-specific by name. A second server is a second attach function
    // and a switch here, NOT a generic re-open that would silently re-open
    // Atlassian for whatever id the registry happened to hold.
    reattach: (_serverId, knownTools) => ensureRemoteMcpAttached(prisma, knownTools),
  };
}

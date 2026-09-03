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
import { McpClientService } from "./mcp-client.service.js";
import { McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import { parseRemoteMcpAllowlist } from "./remote-mcp-servers.js";

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
 * configured `attachRemote` refuses every server. The remote call policy is
 * left at its default — {@link McpToolMultiplexer}'s deny-everything — because
 * ADR-043 §3 forbids invoking a remote tool before WARP-2321's classification
 * table exists.
 */
const remoteAllowlist = parseRemoteMcpAllowlist(config.REMOTE_MCP_SERVER_ALLOWLIST);

export const mcpClient = new McpToolMultiplexer(localClient, {
  isServerAllowed: (serverId) => remoteAllowlist.has(serverId),
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

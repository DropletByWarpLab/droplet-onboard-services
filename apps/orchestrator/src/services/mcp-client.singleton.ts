/**
 * Process-wide MCP client singleton.
 *
 * One stdio child process per orchestrator process. Booted lazily during
 * Express startup (`ensureMcpStarted` from `index.ts`) and stopped on
 * SIGTERM/SIGINT. The agent loop in `/api/llm/chat` and any future
 * MCP-aware route just imports `mcpClient` and calls `listTools()` /
 * `callTool()`; the heavy lifting lives in `McpClientService`.
 *
 * The path resolution prefers an explicit `MCP_SERVER_BIN` env var (set
 * by Docker / dev scripts) and falls back to the workspace-relative
 * `services/mcp-server/dist/index.js`. The fallback uses `process.cwd()`
 * because the orchestrator's `package.json` does not set
 * `"type": "module"`, so `import.meta.url` would trip tsc.
 */
import path from "node:path";
import { McpClientService } from "./mcp-client.service.js";

const SERVER_BIN =
  process.env.MCP_SERVER_BIN ??
  path.resolve(process.cwd(), "../../services/mcp-server/dist/index.js");

export const mcpClient = new McpClientService({
  command: process.execPath,
  args: [SERVER_BIN, "--transport=stdio"],
  // Pass MCP_TRUSTED so the future HTTP-transport child knows the parent
  // is the trusted principal (no JWT to verify) — see spec §7.2. Stdio
  // ignores it today, but flagging it now keeps the wiring explicit.
  env: { MCP_TRUSTED: "1" },
});

let started = false;

export async function ensureMcpStarted(): Promise<void> {
  if (started) return;
  await mcpClient.start();
  started = true;
}

export async function stopMcp(): Promise<void> {
  if (!started) return;
  await mcpClient.stop();
  started = false;
}

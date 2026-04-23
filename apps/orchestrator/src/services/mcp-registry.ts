/**
 * Bridge between the MCP client and the orchestrator's TOOL_REGISTRY.
 *
 * On startup, `bootstrapRemoteMcpServers()` reads MCP_SERVERS from the
 * env, discovers each server's tools, and injects them into TOOL_REGISTRY
 * so the LLM agent loop sees them alongside the built-in tools. Failures
 * for any single server are logged and skipped — they don't prevent the
 * orchestrator from booting.
 *
 * Tool name shape: `<server-name>__<remote-name>`. The model sees these
 * as regular tools; the prefix tells the user (in tool descriptions and
 * audit logs) that they came from a remote MCP server.
 */

import pino from "pino";
import { TOOL_REGISTRY, type Tool } from "./llm-tools.js";
import {
  callRemoteTool,
  discoverRemoteTools,
  parseServerConfig,
  type RemoteServerConfig,
} from "./mcp-client.js";

const logger = pino({ name: "mcp-registry" });

/** Read MCP_SERVERS, discover each, and register their tools. Idempotent —
 *  re-registering the same prefixed name overwrites the previous handler
 *  without throwing. Returns the list of (server, count) pairs for logging. */
export async function bootstrapRemoteMcpServers(): Promise<
  Array<{ server: string; count: number; error?: string }>
> {
  const configs = parseServerConfig(process.env.MCP_SERVERS);
  if (configs.length === 0) {
    logger.debug("no MCP_SERVERS configured");
    return [];
  }
  logger.info({ count: configs.length }, "discovering remote MCP servers");

  const results: Array<{ server: string; count: number; error?: string }> = [];
  await Promise.all(
    configs.map(async (cfg) => {
      try {
        const tools = await discoverRemoteTools(cfg);
        for (const t of tools) {
          registerRemoteTool(cfg, t.remoteName, t.descriptor);
        }
        results.push({ server: cfg.name, count: tools.length });
        logger.info({ server: cfg.name, count: tools.length }, "registered remote tools");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ server: cfg.name, count: 0, error: msg });
        logger.warn({ server: cfg.name, err: msg }, "remote MCP server discovery failed");
      }
    }),
  );
  return results;
}

function registerRemoteTool(
  cfg: RemoteServerConfig,
  remoteName: string,
  descriptor: { name: string; description: string; inputSchema: Record<string, unknown> },
): void {
  // Prefix the description so the model knows where the tool comes from —
  // helps it explain to the user when behavior is surprising.
  const tool: Tool = {
    name: descriptor.name, // already prefixed
    description: `[remote: ${cfg.name}] ${descriptor.description}`,
    parameters: descriptor.inputSchema,
    handler: async (args, _ctx) => {
      try {
        return await callRemoteTool(cfg, remoteName, args);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
  TOOL_REGISTRY[descriptor.name] = tool;
}

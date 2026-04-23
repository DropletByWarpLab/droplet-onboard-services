/**
 * MCP client — connects to external Model Context Protocol servers and
 * surfaces their tools through the orchestrator's TOOL_REGISTRY.
 *
 * Use case: the operator wants to give the local LLM access to tools
 * that aren't built into the orchestrator (e.g. a web-search MCP server,
 * a GitHub MCP server, a vendor's domain-specific MCP server). Set:
 *
 *   MCP_SERVERS=name1=https://server1/jsonrpc,name2=https://server2/jsonrpc
 *
 * On startup, each server's `initialize` is called, then `tools/list` is
 * fetched, and each tool is registered in TOOL_REGISTRY with the prefix
 * `<server-name>__<tool-name>`. The handler shells out to the remote
 * server via tools/call.
 *
 * Auth: each server URL can carry a Bearer token via the standard URL
 * fragment trick — `https://server/jsonrpc#token=abc123`. The token is
 * stripped from the URL and used for the Authorization header. This
 * keeps env config simple (no parallel `MCP_SERVERS_TOKENS` var).
 *
 * Failure modes: a server that's down at startup logs a warning and the
 * orchestrator continues without its tools. Per-call failures surface
 * as `{ error: msg }` to the LLM (the same shape every other tool uses).
 */

import pino from "pino";
import {
  MCP_PROTOCOL_VERSION,
  type InitializeResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolDescriptor,
  type ToolsListResult,
  type ToolsCallResult,
} from "./mcp-protocol.js";

const logger = pino({ name: "mcp-client" });

export interface RemoteServerConfig {
  name: string;          // Stable id used as tool-name prefix
  url: string;           // POST endpoint (JSON-RPC over HTTP)
  bearerToken?: string;  // Optional auth
}

export interface RemoteToolHandle {
  serverName: string;
  remoteName: string;        // Original name on the remote server
  prefixedName: string;      // `<server>__<tool>` — what we register locally
  descriptor: ToolDescriptor;
}

const REQUEST_TIMEOUT_MS = 30_000;

let _nextRpcId = 1;
function nextRpcId(): number {
  return _nextRpcId++;
}

/** Parse the `MCP_SERVERS` env var. Format:
 *    name1=URL1,name2=URL2
 *  Each URL may carry a `#token=...` fragment which is stripped + used
 *  as the Bearer token. Empty entries are silently dropped so a trailing
 *  comma doesn't break startup. */
export function parseServerConfig(envValue: string | undefined): RemoteServerConfig[] {
  if (!envValue || envValue.trim() === "") return [];
  const out: RemoteServerConfig[] = [];
  for (const raw of envValue.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq < 0) {
      logger.warn({ entry }, "MCP_SERVERS entry missing '=' (expected name=url)");
      continue;
    }
    const name = entry.slice(0, eq).trim();
    let url = entry.slice(eq + 1).trim();
    if (!name || !url) continue;
    // Per-name validation — used as a tool-name prefix so it has to be
    // safe identifier characters only.
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name)) {
      logger.warn({ name }, "MCP_SERVERS entry name must be [a-zA-Z0-9_-]{1,32}");
      continue;
    }
    let bearerToken: string | undefined;
    const hashAt = url.indexOf("#");
    if (hashAt >= 0) {
      const fragment = url.slice(hashAt + 1);
      url = url.slice(0, hashAt);
      const m = /(?:^|&)token=([^&]+)/.exec(fragment);
      if (m) bearerToken = decodeURIComponent(m[1]);
    }
    if (!/^https?:\/\//i.test(url)) {
      logger.warn({ name, url }, "MCP_SERVERS url must be http(s)://");
      continue;
    }
    out.push({ name, url, bearerToken });
  }
  return out;
}

async function rpcCall(
  cfg: RemoteServerConfig,
  method: string,
  params?: unknown,
): Promise<JsonRpcResponse> {
  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextRpcId(),
    method,
    ...(params === undefined ? {} : { params }),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.bearerToken) headers.Authorization = `Bearer ${cfg.bearerToken}`;
  const resp = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`mcp ${cfg.name}: HTTP ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as JsonRpcResponse;
}

/** Initialize + tools/list against a remote server. Returns the server's
 *  tool descriptors so the caller can register them locally. */
export async function discoverRemoteTools(cfg: RemoteServerConfig): Promise<RemoteToolHandle[]> {
  const initResp = await rpcCall(cfg, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: { name: "droplet-orchestrator", version: "0.1.0" },
  });
  if ("error" in initResp) {
    throw new Error(`mcp ${cfg.name}: initialize failed: ${initResp.error.message}`);
  }
  const init = initResp.result as InitializeResult;
  logger.info(
    { server: cfg.name, version: init.serverInfo?.version, protocol: init.protocolVersion },
    "mcp server initialized",
  );

  const listResp = await rpcCall(cfg, "tools/list");
  if ("error" in listResp) {
    throw new Error(`mcp ${cfg.name}: tools/list failed: ${listResp.error.message}`);
  }
  const list = listResp.result as ToolsListResult;
  return (list.tools ?? []).map((t) => ({
    serverName: cfg.name,
    remoteName: t.name,
    prefixedName: `${cfg.name}__${t.name}`,
    descriptor: { ...t, name: `${cfg.name}__${t.name}` },
  }));
}

/** Invoke a tool on a remote server. Returns the unwrapped content text
 *  (or a JSON-parsed object if the content looks like JSON). */
export async function callRemoteTool(
  cfg: RemoteServerConfig,
  remoteName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const resp = await rpcCall(cfg, "tools/call", { name: remoteName, arguments: args });
  if ("error" in resp) {
    return { error: `mcp ${cfg.name}: ${resp.error.message}` };
  }
  const result = resp.result as ToolsCallResult;
  // MCP returns `content[]` of typed items. We collapse to the first
  // text item since that's the common case for tool returns. If the text
  // happens to be JSON, parse it back so the caller sees structured data.
  const first = result.content?.[0];
  if (!first || first.type !== "text") return result;
  const text = first.text;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to raw text
    }
  }
  if (result.isError) return { error: text };
  return text;
}

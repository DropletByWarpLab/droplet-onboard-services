/**
 * Model Context Protocol — JSON-RPC 2.0 message types + helpers.
 *
 * Hand-rolled (no @modelcontextprotocol/sdk dep) so the orchestrator can
 * speak MCP without pulling in another package. The protocol surface we
 * implement is intentionally minimal: enough to expose every TOOL_REGISTRY
 * entry to an external MCP client, and enough to consume tools from an
 * external MCP server.
 *
 * What we support:
 *   - `initialize` — handshake; the client/server agree on protocol version
 *     and exchange capabilities. We always advertise `tools` and nothing
 *     else (no resources, prompts, sampling, or roots in v1).
 *   - `tools/list` — return the catalogue of every tool the server offers.
 *   - `tools/call` — invoke a tool by name with an arguments object.
 *   - `ping` — liveness probe used by both sides to detect dead peers.
 *
 * What we deliberately skip in v1 (each is a follow-up):
 *   - Resources (server-pushed file/data URIs) — would need a parallel
 *     surface from the file-indexer.
 *   - Prompts (named prompt templates) — useful but orthogonal.
 *   - Sampling (server requesting completions FROM the client model) —
 *     advanced and rarely used.
 *   - Streaming responses for long-running tools — current TOOL_REGISTRY
 *     handlers all return synchronously; streaming would require a
 *     handler-level API change.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";

// ── JSON-RPC 2.0 envelope types ─────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;          // Notifications omit `id`; we never use them in v1
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Standard JSON-RPC 2.0 error codes
export const RpcCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP-specific
  TOOL_NOT_FOUND: -32001,
  TOOL_FAILED: -32002,
} as const;

// ── MCP-specific payloads ───────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: string;
  capabilities?: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;       // JSON Schema for the args
}

export interface ToolsListResult {
  tools: ToolDescriptor[];
}

export interface ToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolsCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function rpcSuccess(id: string | number, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Validate a parsed JSON value is a well-formed JSON-RPC 2.0 request.
 *  Returns the typed request on success, or a JsonRpcError on failure. */
export function parseJsonRpcRequest(raw: unknown): JsonRpcRequest | JsonRpcError {
  if (raw === null || typeof raw !== "object") {
    return rpcError(null, RpcCode.INVALID_REQUEST, "request must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    return rpcError(
      typeof obj.id === "string" || typeof obj.id === "number" ? obj.id : null,
      RpcCode.INVALID_REQUEST,
      "jsonrpc field must be '2.0'",
    );
  }
  if (typeof obj.method !== "string" || obj.method.length === 0) {
    return rpcError(
      typeof obj.id === "string" || typeof obj.id === "number" ? obj.id : null,
      RpcCode.INVALID_REQUEST,
      "method must be a non-empty string",
    );
  }
  if (typeof obj.id !== "string" && typeof obj.id !== "number") {
    return rpcError(null, RpcCode.INVALID_REQUEST, "id must be string or number");
  }
  return {
    jsonrpc: "2.0",
    id: obj.id,
    method: obj.method,
    params: obj.params,
  };
}

/** Wrap a tool result (any JSON-serializable value) in an MCP
 *  ToolsCallResult. The MCP spec wants `content[]` of typed items;
 *  for now we always emit one text item containing the JSON-stringified
 *  result, which is the pattern most MCP servers use for structured data. */
export function wrapToolResult(value: unknown, isError = false): ToolsCallResult {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

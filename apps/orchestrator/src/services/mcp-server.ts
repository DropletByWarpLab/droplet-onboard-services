/**
 * MCP server adapter — exposes the orchestrator's TOOL_REGISTRY as a
 * Model Context Protocol server. External clients (Claude Desktop, other
 * LLM agents, custom integrations) can connect to /api/mcp/jsonrpc and
 * use every Droplet tool.
 *
 * One handler — `handleMcpMessage` — does the entire dispatch. The HTTP
 * route in routes/mcp.ts just feeds POST bodies through here and returns
 * the result.
 *
 * Auth: same session/Bearer token as the rest of the protected API. The
 * MCP route is mounted behind the auth middleware so req.user is always
 * populated when this handler runs. Same WRITE_TOOLS gate from llm.ts is
 * applied on the way in — no privilege escalation by switching transports.
 */

import type { PrismaClient } from "@prisma/client";
import { TOOL_REGISTRY, dispatchTool } from "./llm-tools.js";
import {
  MCP_PROTOCOL_VERSION,
  RpcCode,
  parseJsonRpcRequest,
  rpcError,
  rpcSuccess,
  wrapToolResult,
  type InitializeResult,
  type JsonRpcResponse,
  type ToolDescriptor,
  type ToolsCallParams,
  type ToolsListResult,
} from "./mcp-protocol.js";

export interface McpRequestContext {
  prisma: PrismaClient;
  userId?: string;
  ncToken?: string;
  /** Names the caller is allowed to invoke. The /api/mcp/jsonrpc route
   *  pre-computes this from req.user.role + WRITE_TOOLS so the dispatch
   *  layer here doesn't need to know about roles. */
  allowedTools: Set<string>;
}

export async function handleMcpMessage(
  rawBody: unknown,
  ctx: McpRequestContext,
): Promise<JsonRpcResponse> {
  const parsed = parseJsonRpcRequest(rawBody);
  if ("error" in parsed) return parsed;

  switch (parsed.method) {
    case "initialize":
      return rpcSuccess(parsed.id, initialize());

    case "ping":
      return rpcSuccess(parsed.id, {});

    case "tools/list":
      return rpcSuccess(parsed.id, listTools(ctx));

    case "tools/call":
      return await callTool(parsed.id, parsed.params, ctx);

    default:
      return rpcError(parsed.id, RpcCode.METHOD_NOT_FOUND, `unknown method: ${parsed.method}`);
  }
}

function initialize(): InitializeResult {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false }, // tool set is static at runtime today
    },
    serverInfo: {
      name: "droplet-orchestrator",
      version: "0.1.0",
    },
  };
}

function listTools(ctx: McpRequestContext): ToolsListResult {
  const tools: ToolDescriptor[] = [];
  for (const tool of Object.values(TOOL_REGISTRY)) {
    // Hide tools the caller isn't allowed to invoke. Mirrors the pattern
    // in routes/llm.ts so unprivileged users don't even see write tools.
    if (!ctx.allowedTools.has(tool.name)) continue;
    tools.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    });
  }
  return { tools };
}

async function callTool(
  id: string | number,
  params: unknown,
  ctx: McpRequestContext,
): Promise<JsonRpcResponse> {
  if (params === null || typeof params !== "object") {
    return rpcError(id, RpcCode.INVALID_PARAMS, "params must be an object");
  }
  const p = params as ToolsCallParams;
  if (typeof p.name !== "string" || p.name.length === 0) {
    return rpcError(id, RpcCode.INVALID_PARAMS, "name must be a non-empty string");
  }
  if (!ctx.allowedTools.has(p.name)) {
    // Don't leak whether the tool exists at all to an unprivileged caller —
    // return TOOL_NOT_FOUND for both "doesn't exist" and "not allowed".
    return rpcError(id, RpcCode.TOOL_NOT_FOUND, `tool not found: ${p.name}`);
  }
  if (!TOOL_REGISTRY[p.name]) {
    return rpcError(id, RpcCode.TOOL_NOT_FOUND, `tool not found: ${p.name}`);
  }
  const args: Record<string, unknown> =
    p.arguments && typeof p.arguments === "object" ? p.arguments : {};

  try {
    const result = await dispatchTool(p.name, args, {
      prisma: ctx.prisma,
      userId: ctx.userId,
      ncToken: ctx.ncToken,
    });
    // dispatchTool returns `{ error: msg }` for tool failures rather than
    // throwing. Surface those as MCP `isError: true` results so the client
    // can distinguish from protocol errors.
    const isToolError =
      result !== null &&
      typeof result === "object" &&
      "error" in (result as Record<string, unknown>);
    return rpcSuccess(id, wrapToolResult(result, isToolError));
  } catch (err) {
    // dispatchTool catches handler throws, so reaching here means an
    // unexpected runtime error in MCP plumbing itself — return a real
    // JSON-RPC error.
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(id, RpcCode.INTERNAL_ERROR, `tool dispatch failed: ${msg}`);
  }
}

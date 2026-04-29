import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, type Tool, type ToolResult } from "@droplet/tools-core";
import { buildContext, type ContextDeps, type Claims } from "./context.js";
import { canCallTool, filterToolsForRole } from "./rbac.js";

const SERVER_INFO = { name: "droplet-mcp-server", version: "0.1.0" };

export function createServer(deps: ContextDeps, claims?: Claims) {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  // Trust is derived from transport selection, not from the role value.
  // `claims === undefined` ONLY happens on the stdio in-proc path — the
  // orchestrator agent spawning the mcp-server child does not pass any
  // claims. The HTTP transport always synthesizes a `Claims` object from
  // the verified JWT (even if `role` is undefined inside it), so an HTTP
  // request can never set `trustedPrincipal: true`.
  const trustedPrincipal = claims === undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Per spec §6.3 + §12 (WARP-103): tools/list is filtered by the
    // caller's role. Trusted principal (stdio in-proc agent) sees every
    // tool. owner/admin see every tool. family/guest (and any HTTP request
    // with a missing role) see read-only tools.
    const tools = filterToolsForRole(TOOLS.values(), claims?.role, {
      trustedPrincipal,
    }).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const tool: Tool | undefined = TOOLS.get(req.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `Unknown tool: ${req.params.name}` }) },
        ],
        isError: true,
      };
    }

    // Re-check on dispatch — tools/list cache could be stale, or a client
    // could try to call a write tool by name without listing it first.
    if (!canCallTool(tool, claims?.role, { trustedPrincipal })) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: {
                code: "forbidden_tool_for_role",
                message: `role '${claims?.role}' may not call '${tool.name}'`,
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // Per-call session context arrives via the MCP `_meta` field
    // (reserved by the spec for protocol metadata that must NOT be
    // forwarded as tool arguments). Today this carries `ncToken` so
    // file-tool handlers can authenticate to Nextcloud as the calling
    // user. On stdio (in-process trusted), the orchestrator passes
    // the dashboard user's session token; on HTTP, claims-based RBAC
    // is the auth surface and `_meta.ncToken` is unset.
    const meta = (req.params as { _meta?: Record<string, unknown> })._meta;
    const ncToken =
      meta && typeof meta.ncToken === "string" && meta.ncToken.length > 0
        ? meta.ncToken
        : undefined;
    const ctx = buildContext(deps, claims, extra.signal, ncToken);
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    let result: ToolResult;
    try {
      result = await tool.handler(args, ctx);
    } catch (err) {
      result = {
        ok: false,
        status: "error",
        error: { code: "HANDLER_THREW", message: err instanceof Error ? err.message : String(err) },
      };
    }
    return toolResultToContent(result);
  });

  return server;
}

export function toolResultToContent(result: ToolResult): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }],
      isError: false,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: result.status,
          error: result.error,
        }),
      },
    ],
    // confirmation_required is NOT a hard error from the model's perspective —
    // it's the expected outcome of calling a destructive tool without prior approval.
    isError: result.status === "error",
  };
}

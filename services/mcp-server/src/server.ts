import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, type Tool, type ToolResult } from "@droplet/tools-core";
import { buildContext, type ContextDeps, type Claims } from "./context.js";

const SERVER_INFO = { name: "droplet-mcp-server", version: "0.1.0" };

export function createServer(deps: ContextDeps, claims?: Claims) {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Array.from(TOOLS.values()).map((t) => ({
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
    const ctx = buildContext(deps, claims, extra.signal);
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

import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    node_id: { type: "string", description: "Optional: filter by Matter node ID." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 20." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const opts: { entityId?: string; limit?: number } = {};
  if (typeof args.node_id === "string") opts.entityId = `matter.${args.node_id}`;
  if (typeof args.limit === "number") {
    opts.limit = Math.max(1, Math.min(200, Math.floor(args.limit)));
  }
  const data = await ctx.matter.getAuditLog(opts);
  return { ok: true, data };
}

const tool: Tool = {
  name: "get_command_history",
  description:
    "View the recent command audit log for smart-home devices. Shows what commands were sent, whether they were auto-executed or required confirmation, and if any were blocked by safety rules.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

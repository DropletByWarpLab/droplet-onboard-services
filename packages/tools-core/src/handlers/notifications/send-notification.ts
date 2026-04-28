import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Headline (1-500 chars)." },
    body: { type: "string", description: "Optional longer message." },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > 500) return err("INVALID_ARGS", "title must be 1-500 chars");
  const created = (await ctx.prisma.notificationLog.create({
    data: {
      userId: ctx.userId,
      kind: "ai",
      title,
      body: typeof args.body === "string" ? args.body : null,
      // Delivery happens out-of-band (mqtt + push) by the orchestrator's
      // notifications service; tools-core only persists the log entry.
      channels: "",
    },
  })) as unknown as { id: string; createdAt: Date };
  return {
    ok: true,
    data: { id: created.id, queued_at: created.createdAt.toISOString() },
  };
}

const tool: Tool = {
  name: "send_notification",
  description:
    "Send an immediate in-app toast notification to the user. Appears on any open dashboard tab via the WebSocket bridge.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

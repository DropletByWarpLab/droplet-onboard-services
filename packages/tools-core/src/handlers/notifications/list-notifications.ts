import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
  additionalProperties: false,
} as const;

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
  const rows = (await ctx.prisma.notificationLog.findMany({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  })) as unknown as NotificationRow[];
  return {
    ok: true,
    data: {
      count: rows.length,
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        delivered: n.deliveredAt !== null,
        at: n.createdAt.toISOString(),
      })),
    },
  };
}

const tool: Tool = {
  name: "list_notifications",
  description:
    "List recent notifications sent to the user. Useful for 'what reminders did I get today?' or auditing what was dispatched.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

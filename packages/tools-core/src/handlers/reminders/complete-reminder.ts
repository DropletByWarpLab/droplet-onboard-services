import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    completed: { type: "boolean", description: "Default true." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) return err("INVALID_ARGS", "id is required");

  const existing = (await ctx.prisma.reminder.findUnique({
    where: { id },
  })) as unknown as { userId: string } | null;
  if (!existing) return err("NOT_FOUND", "reminder_not_found");
  if (existing.userId !== ctx.userId) return err("FORBIDDEN", "forbidden");

  const completed = args.completed !== false;
  await ctx.prisma.reminder.update({
    where: { id },
    data: { completedAt: completed ? new Date() : null },
  });
  return { ok: true, data: { id, completed } };
}

const tool: Tool = {
  name: "complete_reminder",
  description:
    "Mark a reminder as completed (or un-complete with completed=false). Completed reminders stop firing notifications.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

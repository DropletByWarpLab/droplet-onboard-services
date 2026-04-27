import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    include_completed: { type: "boolean", description: "Default false." },
    due_before: { type: "string", description: "ISO-8601 cutoff." },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
} as const;

interface ReminderRow {
  id: string;
  title: string;
  body: string | null;
  dueAt: Date;
  completedAt: Date | null;
}

function parseDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const dueBefore = parseDate(args.due_before);
  const where: Record<string, unknown> = { userId: ctx.userId };
  if (args.include_completed !== true) where.completedAt = null;
  if (dueBefore) where.dueAt = { lte: dueBefore };
  const rows = (await ctx.prisma.reminder.findMany({
    where,
    orderBy: [{ completedAt: "asc" }, { dueAt: "asc" }],
    take: limit,
  })) as unknown as ReminderRow[];
  return {
    ok: true,
    data: {
      count: rows.length,
      reminders: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        due_at: r.dueAt.toISOString(),
        completed: r.completedAt !== null,
      })),
    },
  };
}

const tool: Tool = {
  name: "list_reminders",
  description:
    "List the user's reminders. By default returns active (uncompleted) reminders sorted by due time. Pass include_completed=true to see all.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

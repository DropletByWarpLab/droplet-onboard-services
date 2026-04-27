import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short reminder text." },
    body: { type: "string", description: "Optional longer body." },
    due_at: { type: "string", description: "ISO-8601 due time." },
    calendar_event_id: { type: "string", description: "Optional event UUID to link to." },
  },
  required: ["title", "due_at"],
  additionalProperties: false,
} as const;

function parseDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return err("INVALID_ARGS", "title is required");
  const dueAt = parseDate(args.due_at);
  if (!dueAt) return err("INVALID_ARGS", "invalid due_at — expected ISO-8601 timestamp");

  const reminder = (await ctx.prisma.reminder.create({
    data: {
      userId: ctx.userId,
      title,
      body: typeof args.body === "string" ? args.body : null,
      dueAt,
      calendarEventId:
        typeof args.calendar_event_id === "string" ? args.calendar_event_id : null,
    },
  })) as unknown as { id: string; dueAt: Date };
  return { ok: true, data: { id: reminder.id, due_at: reminder.dueAt.toISOString() } };
}

const tool: Tool = {
  name: "create_reminder",
  description:
    "Create a reminder. The Droplet will fire a notification at due_at (in-app toast). Pass calendar_event_id to link the reminder to an event for context.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "Event UUID." } },
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

  const existing = (await ctx.prisma.calendarEvent.findUnique({
    where: { id },
  })) as unknown as { userId: string; source: string | null } | null;
  if (!existing) return err("NOT_FOUND", "event_not_found");
  if (existing.userId !== ctx.userId) return err("FORBIDDEN", "forbidden");
  if (existing.source && existing.source !== "local") {
    return err(
      "EXTERNAL_SOURCE",
      "cannot delete externally-synced events — remove the calendar source instead",
    );
  }

  await ctx.prisma.calendarEvent.delete({ where: { id } });
  return { ok: true, data: { id, deleted: true } };
}

const tool: Tool = {
  name: "delete_event",
  description:
    "Delete a local calendar event by id. Cannot delete externally-synced events.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

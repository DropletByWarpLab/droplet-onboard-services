import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Event UUID." },
    title: { type: "string" },
    description: { type: "string" },
    location: { type: "string" },
    starts_at: { type: "string" },
    ends_at: { type: "string" },
    all_day: { type: "boolean" },
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

  const startsAt = args.starts_at !== undefined ? parseModelDate(args.starts_at) : undefined;
  const endsAt = args.ends_at !== undefined ? parseModelDate(args.ends_at) : undefined;
  if (args.starts_at !== undefined && !startsAt)
    return err("INVALID_ARGS", "invalid starts_at");
  if (args.ends_at !== undefined && !endsAt) return err("INVALID_ARGS", "invalid ends_at");

  // Verify ownership before update so we can't be tricked into editing
  // someone else's event by id.
  const existing = (await ctx.prisma.calendarEvent.findUnique({
    where: { id },
  })) as unknown as { userId: string; source: string | null } | null;
  if (!existing) return err("NOT_FOUND", "event_not_found");
  if (existing.userId !== ctx.userId) return err("FORBIDDEN", "forbidden");
  if (existing.source && existing.source !== "local") {
    return err(
      "EXTERNAL_SOURCE",
      "cannot edit events from an external sync source — make a local override instead",
    );
  }

  const data: Record<string, unknown> = {};
  if (typeof args.title === "string") data.title = args.title;
  if (typeof args.description === "string") data.description = args.description;
  if (typeof args.location === "string") data.location = args.location;
  if (startsAt) data.startsAt = startsAt;
  if (endsAt) data.endsAt = endsAt;
  if (typeof args.all_day === "boolean") data.allDay = args.all_day;

  try {
    const ev = (await ctx.prisma.calendarEvent.update({ where: { id }, data })) as unknown as { id: string };
    return { ok: true, data: { id: ev.id, updated: true } };
  } catch (e) {
    return err("UPDATE_FAILED", e instanceof Error ? e.message : String(e));
  }
}

const tool: Tool = {
  name: "update_event",
  description:
    "Update an existing local calendar event. Only fields you pass are changed. Cannot edit events that came from an external sync source.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

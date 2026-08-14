import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";

const inputSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "ISO-8601 lower bound (default: now)." },
    to: { type: "string", description: "ISO-8601 upper bound (default: 30 days from now)." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
  },
  additionalProperties: false,
} as const;

interface CalendarEventRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  location: string | null;
  meetingUrl: string | null;
  source: string | null;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const from = parseModelDate(args.from) ?? new Date();
  const to =
    parseModelDate(args.to) ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const rows = (await ctx.prisma.calendarEvent.findMany({
    where: {
      userId: ctx.userId,
      startsAt: { gte: from, lte: to },
    },
    orderBy: { startsAt: "asc" },
    take: limit,
  })) as unknown as CalendarEventRow[];
  return {
    ok: true,
    data: {
      from: from.toISOString(),
      to: to.toISOString(),
      count: rows.length,
      events: rows.map((e) => ({
        id: e.id,
        title: e.title,
        starts_at: e.startsAt.toISOString(),
        ends_at: e.endsAt.toISOString(),
        all_day: e.allDay,
        location: e.location,
        // WARP-1874 — create_event/update_event can set the link, so the
        // read tier has to hand it back or the model can only ever write a
        // field it cannot answer questions about.
        meeting_url: e.meetingUrl,
        source: e.source,
      })),
    },
  };
}

const tool: Tool = {
  name: "list_events",
  description:
    "List the user's calendar events in a time range. Defaults to the next 30 days from now if no range is given. Returns local + externally-synced events together.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

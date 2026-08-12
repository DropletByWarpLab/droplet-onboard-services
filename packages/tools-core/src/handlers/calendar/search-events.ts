/**
 * WARP-1452 — `search_calendar_events` LLM tool.
 *
 * Text search over the user's calendar (title / description / location),
 * optionally bounded to a date range. Pure-prisma read tier; mirrors
 * `list_events`' field selection so both tools return the same event shape.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Text to match against event title, description, and location (case-insensitive).",
    },
    from: { type: "string", description: "Optional ISO-8601 lower bound on start time." },
    to: { type: "string", description: "Optional ISO-8601 upper bound on start time." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max events to return (default 25).",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

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
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query || query.length > 200) return err("INVALID_ARGS", "query must be 1-200 chars");
  const from = args.from !== undefined ? parseModelDate(args.from) : null;
  if (args.from !== undefined && !from)
    return err("INVALID_ARGS", "invalid from — expected ISO-8601 timestamp");
  const to = args.to !== undefined ? parseModelDate(args.to) : null;
  if (args.to !== undefined && !to)
    return err("INVALID_ARGS", "invalid to — expected ISO-8601 timestamp");
  let limit = 25;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
      return err("INVALID_ARGS", "limit must be an integer 1-100");
    limit = args.limit;
  }

  const range: Array<Record<string, unknown>> = [];
  if (from) range.push({ startsAt: { gte: from } });
  if (to) range.push({ startsAt: { lte: to } });

  const rows = (await ctx.prisma.calendarEvent.findMany({
    where: {
      userId: ctx.userId,
      ...(range.length > 0 ? { AND: range } : {}),
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { location: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: { startsAt: "asc" },
    take: limit,
  })) as unknown as CalendarEventRow[];

  return {
    ok: true,
    data: {
      type: "search_calendar_events",
      count: rows.length,
      query,
      events: rows.map((e) => ({
        id: e.id,
        title: e.title,
        starts_at: e.startsAt.toISOString(),
        ends_at: e.endsAt.toISOString(),
        all_day: e.allDay,
        location: e.location,
        // WARP-1874 — kept in step with list_events, per the shape contract
        // this file's header states.
        meeting_url: e.meetingUrl,
        source: e.source,
      })),
    },
  };
}

const tool: Tool = {
  name: "search_calendar_events",
  description:
    "Find calendar events by text — matches the query against event title, description, and location (case-insensitive), optionally within a from/to date range. Note: this calendar stores no attendee data, so events cannot be found or filtered by attendee.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

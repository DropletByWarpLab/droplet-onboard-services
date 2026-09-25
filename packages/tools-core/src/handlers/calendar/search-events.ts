/**
 * WARP-1452 — `search_calendar_events` LLM tool.
 *
 * Text search over the user's calendar (title / description / location),
 * optionally bounded to a date range. Returns `list_events`' event shape
 * (`toolEvent`), so the two tools stay interchangeable.
 *
 * WARP-3101 — READ THROUGH THE ORCHESTRATOR (`GET /api/calendar/events?q=`),
 * never `ctx.prisma`: it used to key the query on `ctx.userId`, a User.id over
 * the mcp-server's HTTP transport, which matches no CalendarEvent (the column
 * holds a username). The range, when given, keeps events that OVERLAP it, the
 * rule list_events and the dashboard use.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";
import { err, forbidden, invalid, refusalOf, toolEvent, type EventJson } from "./_route.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "Text to match against event title, description, and location (case-insensitive).",
    },
    from: { type: "string", description: "Optional ISO-8601 lower bound: events ending after it." },
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

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
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

  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  if (from) qs.set("from", from.toISOString());
  if (to) qs.set("to", to.toISOString());
  const res = await ctx.http.orchestrator.get(`/api/calendar/events?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const refusal = await refusalOf(res);
    if (res.status === 403) return forbidden(refusal);
    if (res.status === 400) return invalid(refusal);
    return err("SEARCH_FAILED", `orchestrator returned ${res.status}`);
  }
  const { events } = (await res.json()) as { events: EventJson[] };

  return {
    ok: true,
    data: {
      type: "search_calendar_events",
      count: events.length,
      query,
      events: events.map(toolEvent),
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

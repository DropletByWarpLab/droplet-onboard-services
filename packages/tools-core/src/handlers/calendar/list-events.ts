/**
 * `list_events` — the calendar of the person the assistant acts for, in a
 * time range.
 *
 * WARP-3101 — READ THROUGH THE ORCHESTRATOR (`GET /api/calendar/events`), the
 * list the dashboard shows. This handler used to query CalendarEvent through
 * `ctx.prisma` by `userId: ctx.userId`; the column holds a username and over
 * the mcp-server's HTTP transport `ctx.userId` is a User.id, so every HTTP
 * caller got an empty calendar. An event is listed when it OVERLAPS the range
 * (the dashboard's rule), so one already under way still shows.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";
import { err, forbidden, refusalOf, toolEvent, type EventJson } from "./_route.js";

const inputSchema = {
  type: "object",
  properties: {
    from: { type: "string", description: "ISO-8601 lower bound (default: now)." },
    to: { type: "string", description: "ISO-8601 upper bound (default: 30 days from now)." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
  },
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const from = parseModelDate(args.from) ?? new Date();
  const to =
    parseModelDate(args.to) ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));

  const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), limit: String(limit) });
  const res = await ctx.http.orchestrator.get(`/api/calendar/events?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return forbidden(await refusalOf(res));
  if (!res.ok) return err("LIST_FAILED", `orchestrator returned ${res.status}`);
  const { events } = (await res.json()) as { events: EventJson[] };
  return {
    ok: true,
    data: {
      from: from.toISOString(),
      to: to.toISOString(),
      count: events.length,
      events: events.map(toolEvent),
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

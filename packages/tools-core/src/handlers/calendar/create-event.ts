/**
 * `create_event` — add an event to the calendar of the person the assistant
 * acts for.
 *
 * WARP-3101 — WRITTEN BY THE ORCHESTRATOR (`POST /api/calendar/events`), never
 * here. This handler used to insert the row through `ctx.prisma` with
 * `userId: ctx.userId`. `CalendarEvent.userId` holds a username, and over the
 * mcp-server's HTTP transport `ctx.userId` is a User.id, so the event landed
 * on a calendar nobody reads. The route resolves the person from the
 * acting-user header and files the event under their username.
 */
import { parseMeetingLink } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";
import { err, forbidden, invalid, refusalOf } from "./_route.js";

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Event title (1-500 chars)." },
    description: { type: "string", description: "Optional longer notes." },
    location: { type: "string", description: "Optional physical location string." },
    meeting_url: {
      type: "string",
      description:
        "Optional video-call link (Zoom, Microsoft Teams, Google Meet, Webex, or any other https URL). Must start with https://. This is separate from `location` — an event can have both a room and a call.",
    },
    starts_at: { type: "string", description: "ISO-8601 start time." },
    ends_at: { type: "string", description: "ISO-8601 end time (must be after starts_at)." },
    all_day: { type: "boolean", description: "True for all-day events. Default false." },
  },
  required: ["title", "starts_at", "ends_at"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const startsAt = parseModelDate(args.starts_at);
  const endsAt = parseModelDate(args.ends_at);
  if (!startsAt) return err("INVALID_ARGS", "invalid starts_at — expected ISO-8601 timestamp");
  if (!endsAt) return err("INVALID_ARGS", "invalid ends_at — expected ISO-8601 timestamp");
  if (endsAt.getTime() <= startsAt.getTime())
    return err("INVALID_ARGS", "ends_at must be after starts_at");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > 500) return err("INVALID_ARGS", "title must be 1-500 chars");

  // WARP-1874 — a model-supplied URL is no more trusted than a pasted one
  // (arguably less: it can be echoed out of a summarized email), and it
  // ends up as an href on a household member's screen. Same https-only
  // gate as every other write path.
  let meetingUrl: string | null = null;
  if (args.meeting_url !== undefined && args.meeting_url !== null && args.meeting_url !== "") {
    const link = parseMeetingLink(args.meeting_url);
    if (!link)
      return err("INVALID_ARGS", "meeting_url must be an https:// link");
    // Store the parser's normalized href, so the value that was validated
    // is the value that renders.
    meetingUrl = link.url;
  }

  // The route takes strict ISO-8601; the model's looser shapes were parsed
  // above, so send the instant they name.
  const res = await ctx.http.orchestrator.post(
    "/api/calendar/events",
    {
      title,
      ...(typeof args.description === "string" ? { description: args.description } : {}),
      ...(typeof args.location === "string" ? { location: args.location } : {}),
      ...(meetingUrl !== null ? { meetingUrl } : {}),
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      allDay: args.all_day === true,
    },
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    const refusal = await refusalOf(res);
    if (res.status === 403) return forbidden(refusal);
    if (res.status === 400) return invalid(refusal);
    return err("CREATE_FAILED", `orchestrator returned ${res.status}`);
  }
  const { event } = (await res.json()) as { event: { id: string; title: string; startsAt: string } };
  return {
    ok: true,
    data: { id: event.id, title: event.title, starts_at: new Date(event.startsAt).toISOString() },
  };
}

const tool: Tool = {
  name: "create_event",
  description:
    "Create a calendar event on the user's local Droplet calendar. Times are ISO-8601 strings (UTC preferred). For all-day events pass all_day=true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

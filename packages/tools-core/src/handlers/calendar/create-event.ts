import { parseMeetingLink } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";

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

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

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

  try {
    const ev = (await ctx.prisma.calendarEvent.create({
      data: {
        userId: ctx.userId,
        title,
        description: typeof args.description === "string" ? args.description : null,
        location: typeof args.location === "string" ? args.location : null,
        meetingUrl,
        startsAt,
        endsAt,
        allDay: args.all_day === true,
        source: "local",
      },
    })) as unknown as { id: string; title: string; startsAt: Date };
    return {
      ok: true,
      data: { id: ev.id, title: ev.title, starts_at: ev.startsAt.toISOString() },
    };
  } catch (e) {
    return err("CREATE_FAILED", e instanceof Error ? e.message : String(e));
  }
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

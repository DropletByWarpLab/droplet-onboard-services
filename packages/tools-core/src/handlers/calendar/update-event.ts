/**
 * `update_event` — change an event on the calendar of the person the
 * assistant acts for.
 *
 * WARP-3101 — WRITTEN BY THE ORCHESTRATOR (`PATCH /api/calendar/events/:id`).
 * This handler used to check `existing.userId !== ctx.userId` itself and then
 * update through `ctx.prisma`. The column holds a username and over the
 * mcp-server's HTTP transport `ctx.userId` is a User.id, so the person's own
 * event was refused as FORBIDDEN. The route knows whose event it is.
 */
import { parseMeetingLink } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseModelDate } from "./_dates.js";
import { err, forbidden, invalid, refusalOf, switchedOff } from "./_route.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Event UUID." },
    title: { type: "string" },
    description: { type: "string" },
    location: { type: "string" },
    meeting_url: {
      type: "string",
      description:
        "Video-call link (https:// only). Pass an empty string to remove an existing link.",
    },
    starts_at: { type: "string" },
    ends_at: { type: "string" },
    all_day: { type: "boolean" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) return err("INVALID_ARGS", "id is required");

  const startsAt = args.starts_at !== undefined ? parseModelDate(args.starts_at) : undefined;
  const endsAt = args.ends_at !== undefined ? parseModelDate(args.ends_at) : undefined;
  if (args.starts_at !== undefined && !startsAt)
    return err("INVALID_ARGS", "invalid starts_at");
  if (args.ends_at !== undefined && !endsAt) return err("INVALID_ARGS", "invalid ends_at");

  const data: Record<string, unknown> = {};
  // WARP-1874 — https-only, same gate as every other write path. An empty
  // string is the removal verb: most tool-call encodings cannot express
  // JSON null, and "" is never a valid link, so it is unambiguous.
  if (typeof args.meeting_url === "string") {
    if (args.meeting_url === "") {
      data.meetingUrl = null;
    } else {
      const link = parseMeetingLink(args.meeting_url);
      if (!link) return err("INVALID_ARGS", "meeting_url must be an https:// link");
      data.meetingUrl = link.url;
    }
  }
  if (typeof args.title === "string") data.title = args.title;
  if (typeof args.description === "string") data.description = args.description;
  if (typeof args.location === "string") data.location = args.location;
  if (startsAt) data.startsAt = startsAt.toISOString();
  if (endsAt) data.endsAt = endsAt.toISOString();
  if (typeof args.all_day === "boolean") data.allDay = args.all_day;

  // The route checks what this tool used to check itself: the event is the
  // person's (403 otherwise), it is local (409), and the range AFTER the patch
  // still ends after it starts (400).
  const res = await ctx.http.orchestrator.patch(`/api/calendar/events/${encodeURIComponent(id)}`, data, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const refusal = await refusalOf(res);
    const off = switchedOff(refusal);
    if (off) return off;
    if (res.status === 404) return err("NOT_FOUND", "event_not_found");
    if (res.status === 403) return forbidden(refusal);
    if (res.status === 409) {
      return err(
        "EXTERNAL_SOURCE",
        "cannot edit events from an external sync source — make a local override instead",
      );
    }
    if (res.status === 400 && refusal.error.includes("must be after")) {
      return err("INVALID_RANGE", "ends_at must be after starts_at");
    }
    if (res.status === 400) return invalid(refusal);
    return err("UPDATE_FAILED", `orchestrator returned ${res.status}`);
  }
  const { event } = (await res.json()) as { event: { id: string } };
  return { ok: true, data: { id: event.id, updated: true } };
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

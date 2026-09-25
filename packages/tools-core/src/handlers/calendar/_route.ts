/**
 * WARP-3101 — what a calendar or reminder route answered, for the tools that
 * call it.
 *
 * The calendar and reminder tools reach CalendarEvent and Reminder through the
 * orchestrator's routes, never `ctx.prisma`. Both tables are keyed on the
 * person's USERNAME, while `ctx.userId` is a username on the mcp-server's stdio
 * transport and a User.id on its HTTP one; the routes resolve the person the
 * tool acts for (from the acting-user header the mcp-server stamps) and key the
 * rows on their username, so the tools work the same on both.
 *
 * A route refuses with `{ error, details? }`. This reads it without trusting
 * the body to be JSON, and turns the refusals every one of these routes shares
 * into a ToolResult the model can pass on.
 */
import type { ToolResult } from "../../types.js";

export function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

export interface RouteRefusal {
  /** The route's `error` string, or `http_<status>` when it sent none. */
  error: string;
  /** The request fields a 400 named (zod `fieldErrors`), in route spelling. */
  fields: string[];
}

export async function refusalOf(res: Response): Promise<RouteRefusal> {
  try {
    const body = (await res.json()) as { error?: unknown; details?: { fieldErrors?: Record<string, unknown> } };
    return {
      error: typeof body?.error === "string" ? body.error : `http_${res.status}`,
      fields: Object.keys(body?.details?.fieldErrors ?? {}),
    };
  } catch {
    return { error: `http_${res.status}`, fields: [] };
  }
}

/**
 * `/api/calendar` sits behind the Calendar module gate (the orchestrator's
 * module-mounts.ts): switched off, it answers 404 `module_disabled`. That is
 * "this part of Droplet is off", not "no such event" — say so. `null` for any
 * other refusal.
 */
export function switchedOff(refusal: RouteRefusal): ToolResult | null {
  return refusal.error === "module_disabled"
    ? err("MODULE_DISABLED", "The calendar is switched off on this Droplet.")
    : null;
}

/**
 * A 403. `forbidden` is the route's "not your event"; the other two are the
 * acting-user check (services/tool-acting-user.service.ts in the orchestrator).
 */
export function forbidden(refusal: RouteRefusal): ToolResult {
  if (refusal.error === "acting_user_required") {
    return err("FORBIDDEN", "Droplet could not tell whose calendar and reminders these are, so it did not touch them.");
  }
  if (refusal.error === "forbidden_tool_for_role") {
    return err("FORBIDDEN", "This person's access does not include this.");
  }
  return err("FORBIDDEN", "forbidden");
}

/** A CalendarEvent as `GET /api/calendar/events` sends it (dates as ISO strings). */
export interface EventJson {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
  meetingUrl: string | null;
  source: string | null;
}

/** The event shape list_events and search_calendar_events both return. */
export function toolEvent(e: EventJson) {
  return {
    id: e.id,
    title: e.title,
    starts_at: new Date(e.startsAt).toISOString(),
    ends_at: new Date(e.endsAt).toISOString(),
    all_day: e.allDay,
    location: e.location,
    // WARP-1874 — create_event/update_event can set the link, so the read
    // tier has to hand it back or the model can only ever write a field it
    // cannot answer questions about.
    meeting_url: e.meetingUrl,
    source: e.source,
  };
}

/** A 400: the route's own message when it gave one, else the fields it named. */
export function invalid(refusal: RouteRefusal): ToolResult {
  if (refusal.error !== "invalid_request") return err("INVALID_ARGS", refusal.error);
  return err("INVALID_ARGS", refusal.fields.length > 0 ? `invalid ${refusal.fields.join(", ")}` : "invalid request");
}

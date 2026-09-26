/**
 * `create_reminder` — a reminder for the person the assistant acts for.
 *
 * WARP-3101 — WRITTEN BY THE ORCHESTRATOR (`POST /api/reminders`), never here.
 * This handler used to insert the row through `ctx.prisma` with
 * `userId: ctx.userId`. `Reminder.userId` holds a username (the poller
 * notifies it), and over the mcp-server's HTTP transport `ctx.userId` is a
 * User.id: the poller stamped the reminder notified, the send threw on the
 * UUID, and the reminder was lost. The route resolves the person from the
 * acting-user header and files the reminder under their username.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, forbidden, invalid, refusalOf } from "../calendar/_route.js";

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short reminder text." },
    body: { type: "string", description: "Optional longer body." },
    due_at: { type: "string", description: "ISO-8601 due time." },
    calendar_event_id: { type: "string", description: "Optional event UUID to link to." },
  },
  required: ["title", "due_at"],
  additionalProperties: false,
} as const;

function parseDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return err("INVALID_ARGS", "title is required");
  const dueAt = parseDate(args.due_at);
  if (!dueAt) return err("INVALID_ARGS", "invalid due_at — expected ISO-8601 timestamp");

  const res = await ctx.http.orchestrator.post(
    "/api/reminders",
    {
      title,
      ...(typeof args.body === "string" ? { body: args.body } : {}),
      // The route takes strict ISO-8601; send the instant the model named.
      dueAt: dueAt.toISOString(),
      ...(typeof args.calendar_event_id === "string" ? { calendarEventId: args.calendar_event_id } : {}),
    },
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    const refusal = await refusalOf(res);
    if (res.status === 403) return forbidden(refusal);
    if (res.status === 400) return invalid(refusal);
    return err("CREATE_FAILED", `orchestrator returned ${res.status}`);
  }
  const { reminder } = (await res.json()) as { reminder: { id: string; dueAt: string } };
  return { ok: true, data: { id: reminder.id, due_at: new Date(reminder.dueAt).toISOString() } };
}

const tool: Tool = {
  name: "create_reminder",
  description:
    "Create a reminder. The Droplet will fire a notification at due_at (in-app toast). Pass calendar_event_id to link the reminder to an event for context.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

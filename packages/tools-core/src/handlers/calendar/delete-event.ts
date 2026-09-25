/**
 * `delete_event` — remove an event from the calendar of the person the
 * assistant acts for.
 *
 * WARP-3101 — DELETED BY THE ORCHESTRATOR (`DELETE /api/calendar/events/:id`),
 * which knows whose event it is. This handler used to compare the row's
 * `userId` (a username) with `ctx.userId` (a User.id over the mcp-server's
 * HTTP transport) and so refused the person's own event as FORBIDDEN.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, forbidden, refusalOf } from "./_route.js";

const inputSchema = {
  type: "object",
  properties: { id: { type: "string", description: "Event UUID." } },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) return err("INVALID_ARGS", "id is required");

  const res = await ctx.http.orchestrator.delete(`/api/calendar/events/${encodeURIComponent(id)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const refusal = await refusalOf(res);
    if (res.status === 404) return err("NOT_FOUND", "event_not_found");
    if (res.status === 403) return forbidden(refusal);
    if (res.status === 409) {
      return err(
        "EXTERNAL_SOURCE",
        "cannot delete externally-synced events — remove the calendar source instead",
      );
    }
    return err("DELETE_FAILED", `orchestrator returned ${res.status}`);
  }
  return { ok: true, data: { id, deleted: true } };
}

const tool: Tool = {
  name: "delete_event",
  description:
    "Delete a local calendar event by id. Cannot delete externally-synced events.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

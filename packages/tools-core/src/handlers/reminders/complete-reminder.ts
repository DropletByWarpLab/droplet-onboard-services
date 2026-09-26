/**
 * `complete_reminder` — mark a reminder of the person the assistant acts for
 * done (or not done).
 *
 * WARP-3101 — WRITTEN BY THE ORCHESTRATOR (`PATCH /api/reminders/:id`), whose
 * write is scoped to the person's own reminders: someone else's id answers
 * exactly like a missing one (404, ORCH-008). This handler used to compare the
 * row's `userId` (a username) with `ctx.userId` (a User.id over the
 * mcp-server's HTTP transport) and so refused the person's own reminder.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, forbidden, refusalOf } from "../calendar/_route.js";

const inputSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    completed: { type: "boolean", description: "Default true." },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const id = typeof args.id === "string" ? args.id : null;
  if (!id) return err("INVALID_ARGS", "id is required");

  const completed = args.completed !== false;
  const res = await ctx.http.orchestrator.patch(
    `/api/reminders/${encodeURIComponent(id)}`,
    { completed },
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    const refusal = await refusalOf(res);
    if (res.status === 404) return err("NOT_FOUND", "reminder_not_found");
    if (res.status === 403) return forbidden(refusal);
    return err("UPDATE_FAILED", `orchestrator returned ${res.status}`);
  }
  return { ok: true, data: { id, completed } };
}

const tool: Tool = {
  name: "complete_reminder",
  description:
    "Mark a reminder as completed (or un-complete with completed=false). Completed reminders stop firing notifications.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

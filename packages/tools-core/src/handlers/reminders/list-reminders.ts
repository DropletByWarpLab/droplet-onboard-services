/**
 * `list_reminders` — the reminders of the person the assistant acts for.
 *
 * WARP-3101 — READ THROUGH THE ORCHESTRATOR (`GET /api/reminders`), the list
 * the dashboard shows. This handler used to query Reminder through
 * `ctx.prisma` by `userId: ctx.userId`; the column holds a username and over
 * the mcp-server's HTTP transport `ctx.userId` is a User.id, so every HTTP
 * caller got an empty list.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { err, forbidden, refusalOf } from "../calendar/_route.js";

const inputSchema = {
  type: "object",
  properties: {
    include_completed: { type: "boolean", description: "Default false." },
    due_before: { type: "string", description: "ISO-8601 cutoff." },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
} as const;

/** A Reminder as `GET /api/reminders` sends it (dates as ISO strings). */
interface ReminderJson {
  id: string;
  title: string;
  body: string | null;
  dueAt: string;
  completedAt: string | null;
}

function parseDate(input: unknown): Date | null {
  if (typeof input !== "string" || input.length === 0) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
  const dueBefore = parseDate(args.due_before);
  // The route's `completed` is three-way (true / false / absent = all); this
  // tool's default is the active ones.
  const qs = new URLSearchParams({ limit: String(limit) });
  if (args.include_completed !== true) qs.set("completed", "false");
  if (dueBefore) qs.set("due_before", dueBefore.toISOString());
  const res = await ctx.http.orchestrator.get(`/api/reminders?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return forbidden(await refusalOf(res));
  if (!res.ok) return err("LIST_FAILED", `orchestrator returned ${res.status}`);
  const { reminders } = (await res.json()) as { reminders: ReminderJson[] };
  return {
    ok: true,
    data: {
      count: reminders.length,
      reminders: reminders.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        due_at: new Date(r.dueAt).toISOString(),
        completed: r.completedAt !== null,
      })),
    },
  };
}

const tool: Tool = {
  name: "list_reminders",
  description:
    "List the user's reminders. By default returns active (uncompleted) reminders sorted by due time. Pass include_completed=true to see all.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

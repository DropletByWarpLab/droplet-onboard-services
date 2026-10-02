/**
 * `list_notifications` — the notifications the person the assistant acts for
 * received.
 *
 * WARP-3099 — READ THROUGH THE ORCHESTRATOR, never `ctx.prisma`. This handler
 * used to read `NotificationLog` by `username: ctx.userId`. `ctx.userId` is the
 * username on the mcp-server's stdio transport but the `User.id` on its HTTP
 * one (mcp-server context.ts: `claims.sub`), and the log is keyed on the
 * username (WARP-2911): every HTTP-transport caller got an empty list, and
 * nothing said so. Chat excludes this tool (chat-tool-scope.ts), so those
 * callers are most of the ones it is kept for. N1 (`GET /api/notifications`)
 * resolves the person from the acting-user header by username, then by id,
 * and re-checks that they may use this tool (routes/notifications.ts
 * `recipientFor`, the lookup WARP-3060 built for `send_notification`).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
  additionalProperties: false,
} as const;

/** N1's row, as JSON. */
interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  // N1 takes 1-200 as digits; anything else is the default.
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit)) || 30));
  const res = await ctx.http.orchestrator.get(`/api/notifications?limit=${limit}&state=all`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 403) return err("FORBIDDEN", "Notifications cannot be read for this person.");
  if (!res.ok) return err("NOTIFICATIONS_UNAVAILABLE", `orchestrator returned ${res.status}`);
  const { notifications: rows } = (await res.json()) as { notifications: NotificationRow[] };
  return {
    ok: true,
    data: {
      count: rows.length,
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        // WARP-2909 — where the notification points (a dashboard path).
        url: n.url ?? null,
        delivered: n.deliveredAt !== null,
        at: n.createdAt,
      })),
    },
  };
}

const tool: Tool = {
  name: "list_notifications",
  description:
    "List recent notifications sent to the user. Useful for 'what reminders did I get today?' or auditing what was dispatched.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

/**
 * `send_notification` — notify the person the assistant is acting for.
 *
 * WARP-3060 — DELIVERED BY THE ORCHESTRATOR, never written here. This handler
 * used to insert a NotificationLog row through `ctx.prisma` with
 * `channels: ""` and a comment promising delivery "out-of-band". Nothing ever
 * picked such a row up: no toast, no push, while the model told the person it
 * had notified them (and, since WARP-2804, the row counted as unread). It now
 * posts to `POST /api/notifications/send`, where `sendNotification` records the
 * row AND carries it (toast + web push). The route resolves the recipient from
 * the acting-user header and re-checks this person's reach server-side; the
 * recipient is never an argument, so the tool can only notify the person it
 * acts for.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Headline (1-500 chars)." },
    body: { type: "string", description: "Optional longer message (up to 2000 chars)." },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

function err(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "auth_required");
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > 500) return err("INVALID_ARGS", "title must be 1-500 chars");
  const body = typeof args.body === "string" ? args.body : undefined;
  if (body !== undefined && body.length > 2000) return err("INVALID_ARGS", "body must be at most 2000 chars");

  const res = await ctx.http.orchestrator.post(
    "/api/notifications/send",
    { kind: "ai", title, ...(body !== undefined ? { body } : {}) },
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 403) return err("FORBIDDEN", "Notifications cannot be sent for this person.");
  if (!res.ok) return err("NOTIFICATION_FAILED", `orchestrator returned ${res.status}`);
  const sent = (await res.json()) as { id: string; channels: string[]; delivered: boolean };
  return {
    ok: true,
    data: {
      id: sent.id,
      delivered: sent.delivered,
      channels: sent.channels,
      // The row is in their notification list either way; only claim what reached them.
      ...(sent.delivered ? {} : { note: "Saved to their notifications, but not delivered to any screen or device." }),
    },
  };
}

const tool: Tool = {
  name: "send_notification",
  description:
    "Send the user an immediate notification: a toast on any open dashboard tab and a push to their subscribed browsers.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;

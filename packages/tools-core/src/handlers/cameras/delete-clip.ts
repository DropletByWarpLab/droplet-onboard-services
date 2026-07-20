/**
 * WARP-1440 — `delete_clip` LLM tool.
 *
 * Permanently deletes a camera event's recording clip (the Frigate
 * event plus its saved clip + snapshot on disk) via the orchestrator's
 * DELETE /api/cameras/events/:eventId route. Irreversible, so it is
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER:
 * neither the MCP server nor the agent loop enforces the
 * `requiresConfirmation` flag generically, so the first call returns
 * `confirmation_required` (no HTTP call) echoing the event id and a
 * warning that the footage is gone for good. The model relays it to
 * the user and re-issues the call with `confirmed: true` only after
 * the user explicitly approves — same handler-enforced two-phase
 * contract as `memory_forget`.
 */
import { confirmationRequired } from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    event_id: {
      type: "string",
      description:
        "Frigate event id of the clip to delete. Find event ids via list_clips or list_camera_events.",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved deleting this exact clip in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with the event id to relay to the user for approval.",
    },
  },
  required: ["event_id"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const eventId = typeof args.event_id === "string" ? args.event_id.trim() : "";
  if (eventId.length === 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "event_id is required" },
    };
  }

  // Confirmation gate — BEFORE any HTTP call. Deleting a clip removes
  // the recording permanently; the agent must never do it unattended.
  if (args.confirmed !== true) {
    return confirmationRequired(
      `I'd like to permanently delete the recording clip for camera event "${eventId}". ` +
        "This cannot be undone — the clip and its snapshot are removed from disk. " +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "delete_clip", event_id: eventId },
    );
  }

  const res = await ctx.http.orchestrator.delete(
    `/api/cameras/events/${encodeURIComponent(eventId)}`,
  );
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "no camera event with that id" },
    };
  }
  if (res.status === 451 || res.status === 403) {
    return {
      ok: false,
      status: "error",
      error: { code: "FORBIDDEN", message: `orchestrator returned ${res.status}` },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: { code: "DELETE_FAILED", message: `orchestrator returned ${res.status}` },
    };
  }

  return { ok: true, data: { type: "delete_clip", event_id: eventId, deleted: true } };
}

const tool: Tool = {
  name: "delete_clip",
  description:
    "Permanently delete a camera event's recording clip (and its snapshot) from disk. Irreversible. Two-step: the first call returns confirmation_required with the event id — relay it to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true. Find event ids via list_clips or list_camera_events.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

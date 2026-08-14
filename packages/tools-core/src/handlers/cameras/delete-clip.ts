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
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "delete_clip";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    event_id: {
      type: "string",
      description:
        "Frigate event id of the clip to delete. Find event ids via list_clips or list_camera_events.",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
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
  const fingerprint = confirmationFingerprint([TOOL_NAME, eventId]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to permanently delete the recording clip for camera event "${eventId}". ` +
        "This cannot be undone — the clip and its snapshot are removed from disk. " +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      { type: "delete_clip", event_id: eventId },
      { toolName: TOOL_NAME, fingerprint },
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
    "Permanently delete a camera event's recording clip (and its snapshot) from disk. Irreversible. Two-step: the first call returns confirmation_required with the event id — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation. Find event ids via list_clips or list_camera_events.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

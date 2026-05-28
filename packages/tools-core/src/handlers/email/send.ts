/**
 * WARP-466 (D2) — `email_send` LLM tool.
 *
 * Write tier + requires confirmation. Dispatches an existing EmailDraft
 * via `POST /api/email/drafts/:id/send`. The orchestrator route enforces
 * the off-LAN `outbound_email` gate and flips the draft to status=queued;
 * the email-indexer's outbound poller drives the SMTP transaction.
 *
 * The tool itself doesn't read the operator's mailbox before sending —
 * the draft is the source of truth. Operators (or the chat surface) can
 * edit the draft via the dashboard before sending.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    draftId: {
      type: "string",
      description: "EmailDraft.id to send. Must currently have status=draft.",
    },
  },
  required: ["draftId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const draftId = typeof args.draftId === "string" ? args.draftId : "";
  if (!draftId) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "draftId is required" },
    };
  }
  const res = await ctx.http.orchestrator.post(
    `/api/email/drafts/${encodeURIComponent(draftId)}/send`,
    {},
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 451) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "OFF_LAN_BLOCKED",
        message:
          "Outbound email is disabled by the off-LAN allowlist. An admin can enable outbound_email in Settings → Off-LAN allowlist.",
      },
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "Draft not found" },
    };
  }
  if (res.status === 409) {
    return {
      ok: false,
      status: "error",
      error: { code: "ALREADY_DISPATCHED", message: "Draft already dispatched" },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SEND_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as {
    id: string;
    status: string;
    message?: string;
  };
  return {
    ok: true,
    data: {
      type: "email_send",
      draftId: data.id,
      status: data.status,
      summary:
        data.message ??
        "Queued for SMTP send by the email-indexer service.",
    },
  };
}

const tool: Tool = {
  name: "email_send",
  description:
    "Send a drafted email. Write tier — requires user confirmation in the dashboard. Refuses with off_lan_blocked when Settings → Off-LAN allowlist has `outbound_email` disabled.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

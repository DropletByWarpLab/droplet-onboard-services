import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError } from "./pm-orch.js";

const TOOL_NAME = "pm_add_work_item_comment";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
    comment_html: { type: "string", minLength: 1, description: "HTML body of the comment" },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the change, and the user approves from that prompt.",
    },
  },
  required: ["workspace_slug", "project_id", "work_item_id", "comment_html"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
  comment_html: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { work_item_id, comment_html } = args as unknown as Args;

  // WARP-2008 — confirmation gate. This tool declared
  // `requiresConfirmation: true` and routes/pm/native.ts stated that "the tool
  // layer owns the human-facing confirmation gate" — but no gate existed at
  // either layer, so the write executed on the first model-emitted call.
  const fingerprint = confirmationFingerprint([TOOL_NAME, work_item_id, comment_html]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to post a comment on work item ${work_item_id}. ` +
        "The comment is visible to everyone with access to the project. " +
        "Ask the user to approve. You cannot approve on their behalf.",
      { type: TOOL_NAME, work_item_id },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  try {
    const data = await callOrch<{ comment: unknown }>(
      ctx,
      "post",
      `/api/pm/work-items/${encodeURIComponent(work_item_id)}/comments`,
      { comment_html },
    );
    return { ok: true, data: { comment: data.comment } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return { ok: false, status: "error", error: { code, message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_add_work_item_comment",
  description:
    "Append an HTML comment to a work item. Two-step: the first call returns confirmation_required describing the change — relay that to the user. Approval happens outside this conversation. Returns the new comment id.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

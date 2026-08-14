import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, OrchPmError, toPlaneWorkItem } from "./pm-orch.js";

const TOOL_NAME = "pm_transition_work_item";

const inputSchema = {
  type: "object",
  properties: {
    workspace_slug: { type: "string" },
    project_id: { type: "string" },
    work_item_id: { type: "string" },
    state_id: { type: "string", description: "Target state id (e.g. 'in_progress', 'done')" },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the change, and the user approves from that prompt.",
    },
  },
  required: ["workspace_slug", "project_id", "work_item_id", "state_id"],
  additionalProperties: false,
} as const;

interface Args {
  workspace_slug: string;
  project_id: string;
  work_item_id: string;
  state_id: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { work_item_id, state_id } = args as unknown as Args;

  // WARP-2008 — confirmation gate. This tool declared
  // `requiresConfirmation: true` and routes/pm/native.ts stated that "the tool
  // layer owns the human-facing confirmation gate" — but no gate existed at
  // either layer, so the write executed on the first model-emitted call.
  const fingerprint = confirmationFingerprint([TOOL_NAME, work_item_id, state_id]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to move work item ${work_item_id} to state "${state_id}". ` +
        "Ask the user to approve. You cannot approve on their behalf.",
      { type: TOOL_NAME, work_item_id, state_id },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  try {
    const data = await callOrch<{ work_item: Parameters<typeof toPlaneWorkItem>[0] }>(
      ctx,
      "post",
      `/api/pm/work-items/${encodeURIComponent(work_item_id)}/transition`,
      { state_id },
    );
    return { ok: true, data: { work_item: toPlaneWorkItem(data.work_item) } };
  } catch (err) {
    if (err instanceof OrchPmError) {
      const code = err.status === 404 ? "PM_WORK_ITEM_NOT_FOUND" : "PM_API_ERROR";
      return { ok: false, status: "error", error: { code, message: err.message } };
    }
    throw err;
  }
}

const tool: Tool = {
  name: "pm_transition_work_item",
  description:
    "Transition a work item to a different state (e.g. in_progress → done). Two-step: the first call returns confirmation_required describing the change — relay that to the user. Approval happens outside this conversation. Returns the updated work item.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

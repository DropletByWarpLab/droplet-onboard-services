import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toActivity } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    subject_type: {
      type: "string",
      enum: ["COMPANY", "DEAL"],
    },
    subject_id: { type: "string" },
    kind: {
      type: "string",
      // STAGE_CHANGE, CREATED and SYNCED are absent deliberately: they are
      // written by the box when the thing they describe actually happens. A
      // model-written stage change with no move behind it would make the
      // timeline lie about the pipeline. The orchestrator enforces the same
      // list, so this enum is the first gate and not the only one.
      enum: ["NOTE", "CALL", "MEETING", "TASK", "EMAIL"],
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description: "One line, shown on the timeline",
    },
  },
  required: ["subject_type", "subject_id", "kind", "summary"],
  additionalProperties: false,
} as const;

interface Args {
  subject_type: "COMPANY" | "DEAL";
  subject_id: string;
  kind: "NOTE" | "CALL" | "MEETING" | "TASK" | "EMAIL";
  summary: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { subject_type, subject_id, kind, summary } = args as unknown as Args;
  try {
    const data = await callOrch<{ activity: Parameters<typeof toActivity>[0] }>(
      ctx,
      "post",
      "/api/crm/activities",
      {
        subjectType: subject_type,
        companyId: subject_type === "COMPANY" ? subject_id : null,
        dealId: subject_type === "DEAL" ? subject_id : null,
        kind,
        summary,
      },
    );
    return { ok: true, data: { activity: toActivity(data.activity) } };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_log_activity",
  description:
    "Append an interaction to a customer's or deal's timeline. Requires confirmation. Summarise what happened, not what was said.",
  inputSchema,
  requiresWrite: true,
  // Enforced generically by the dispatch interceptor (WARP-2305): the first
  // call is refused and a token bound to these exact arguments is minted, so
  // no confirmation code belongs in this handler.
  requiresConfirmation: true,
  handler,
};

export default tool;

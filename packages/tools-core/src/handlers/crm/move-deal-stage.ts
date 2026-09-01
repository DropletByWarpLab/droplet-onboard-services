import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toDeal } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    deal_id: { type: "string" },
    stage_id: { type: "string", description: 'From business_find entity:"pipeline"; same pipeline.' },
  },
  required: ["deal_id", "stage_id"],
  additionalProperties: false,
} as const;

interface Args {
  deal_id: string;
  stage_id: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { deal_id, stage_id } = args as unknown as Args;
  try {
    const data = await callOrch<{ deal: Parameters<typeof toDeal>[0] }>(
      ctx,
      "post",
      `/api/crm/deals/${encodeURIComponent(deal_id)}/stage`,
      { stageId: stage_id },
    );
    return { ok: true, data: { deal: toDeal(data.deal) } };
  } catch (err) {
    // A stage from another pipeline comes back 422 `invalid_stage`, which
    // crmError keeps as CRM_INVALID_REQUEST with the message — the model can
    // fix that by re-reading the pipeline, and it is not the same failure as
    // a deal id that does not exist.
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_move_deal_stage",
  description:
    "Move a deal to another stage in its own pipeline; the forecast reads this and it lands on the timeline.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

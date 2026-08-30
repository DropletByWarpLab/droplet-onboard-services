import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toActivity, toDeal } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    deal_id: { type: "string" },
    timeline_limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: ["deal_id"],
  additionalProperties: false,
} as const;

interface Args {
  deal_id: string;
  timeline_limit?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { deal_id, timeline_limit } = args as unknown as Args;
  const id = encodeURIComponent(deal_id);
  try {
    const [deal, activities] = await Promise.all([
      callOrch<{ deal: Parameters<typeof toDeal>[0] }>(ctx, "get", `/api/crm/deals/${id}`),
      callOrch<{ activities?: Parameters<typeof toActivity>[0][] }>(
        ctx,
        "get",
        `/api/crm/activities?subject_type=DEAL&subject_id=${id}&per_page=${timeline_limit ?? 15}`,
      ),
    ]);
    return {
      ok: true,
      data: { deal: toDeal(deal.deal), timeline: (activities.activities ?? []).map(toActivity) },
    };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_get_deal",
  description:
    "One deal with its recent timeline. Read before drafting a follow-up. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

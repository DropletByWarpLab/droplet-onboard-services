import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toDeal } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["OPEN", "WON", "LOST"],
      description: "Outcome class. The stage's meaning, not its name.",
    },
    customer_id: { type: "string" },
    idle_days: {
      type: "number",
      minimum: 0,
      maximum: 3650,
      description: "Days with no timeline activity; counts from creation if never active.",
    },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: [],
  additionalProperties: false,
} as const;

interface Args {
  outcome?: "OPEN" | "WON" | "LOST";
  customer_id?: string;
  idle_days?: number;
  limit?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { outcome, customer_id, idle_days, limit } = args as unknown as Args;
  const params = new URLSearchParams();
  if (outcome) params.set("kind", outcome);
  if (customer_id) params.set("company", customer_id);
  if (idle_days !== undefined) params.set("idle_days", String(idle_days));
  params.set("per_page", String(limit ?? 25));
  try {
    const data = await callOrch<{ deals?: Parameters<typeof toDeal>[0][]; total?: number }>(
      ctx,
      "get",
      `/api/crm/deals?${params.toString()}`,
    );
    return { ok: true, data: { deals: (data.deals ?? []).map(toDeal), total: data.total ?? 0 } };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_list_deals",
  description:
    "List CRM deals, optionally by outcome, customer, or idle_days (how you find deals needing a chase). `amount_minor` is a STRING of minor units — pair with `currency`, never parse as a number. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

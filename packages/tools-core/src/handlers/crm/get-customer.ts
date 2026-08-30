import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toActivity, toCompany, toDeal } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    customer_id: { type: "string" },
    timeline_limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: ["customer_id"],
  additionalProperties: false,
} as const;

interface Args {
  customer_id: string;
  timeline_limit?: number;
}

/**
 * One customer with the two things a question about them almost always needs:
 * their open deals and what happened recently. Three reads rather than one
 * fat endpoint, because each is separately useful and the orchestrator has no
 * combined route — and inventing one for a tool's convenience would put a
 * shape in the API that nothing else wants.
 */
async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { customer_id, timeline_limit } = args as unknown as Args;
  const id = encodeURIComponent(customer_id);
  try {
    const company = await callOrch<{ company: Parameters<typeof toCompany>[0] }>(
      ctx,
      "get",
      `/api/crm/companies/${id}`,
    );
    const [deals, activities] = await Promise.all([
      callOrch<{ deals?: Parameters<typeof toDeal>[0][] }>(
        ctx,
        "get",
        `/api/crm/deals?company=${id}&kind=OPEN`,
      ),
      callOrch<{ activities?: Parameters<typeof toActivity>[0][] }>(
        ctx,
        "get",
        `/api/crm/activities?subject_type=COMPANY&subject_id=${id}&per_page=${timeline_limit ?? 10}`,
      ),
    ]);
    return {
      ok: true,
      data: {
        customer: toCompany(company.company),
        open_deals: (deals.deals ?? []).map(toDeal),
        timeline: (activities.activities ?? []).map(toActivity),
      },
    };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_get_customer",
  description:
    "One CRM customer with their open deals and recent timeline. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

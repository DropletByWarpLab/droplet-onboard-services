import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, crmError, toCompany } from "./crm-orch.js";

const inputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Name or web domain. Omit to list all customers.",
    },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
  required: [],
  additionalProperties: false,
} as const;

interface Args {
  query?: string;
  limit?: number;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { query, limit } = args as unknown as Args;
  const params = new URLSearchParams();
  if (query?.trim()) params.set("q", query.trim());
  // Capped harder than the API's 200: a tool result is read by a model with a
  // finite context, and 200 customers is a context flood, not an answer.
  params.set("per_page", String(limit ?? 20));
  try {
    const data = await callOrch<{ companies?: Parameters<typeof toCompany>[0][]; total?: number }>(
      ctx,
      "get",
      `/api/crm/companies?${params.toString()}`,
    );
    return {
      ok: true,
      data: {
        customers: (data.companies ?? []).map(toCompany),
        // The model needs to know when it is looking at a page rather than the
        // whole list, or it will answer "you have 20 customers".
        total: data.total ?? 0,
      },
    };
  } catch (err) {
    return crmError(err);
  }
}

const tool: Tool = {
  name: "crm_search_customers",
  description:
    "Search CRM customers (companies) by name or web domain. Returns ids for crm_get_customer and crm_list_deals. Read-only.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * WARP-2497 — the ONE cloud-connector read tool.
 *
 * The connected SaaS accounts (Stripe, HubSpot, Mailchimp, Shopify) expose ~13
 * record shapes between them. A tool per vendor — let alone per dataset — would
 * add thirteen `{type,function:{…}}` blocks to every completion request, and the
 * full-registry serialization canary already sits within 3 KB of its 100 KB
 * ceiling. So the vendor is NOT a tool axis and not an argument either: the
 * dataset name determines the provider (`charge`/`invoice` ⇒ Stripe,
 * `contact`…`engagement` ⇒ HubSpot, `campaign`/`audience_member`/
 * `ecommerce_order` ⇒ Mailchimp, `order`/`product`/`customer` ⇒ Shopify), and
 * the orchestrator route owns that mapping. One tool, one route, one small
 * schema.
 *
 * WARP-2354 is the proof that this generalises: adding Shopify's three datasets
 * cost three lines here and three in `CLOUD_DATASET_READS`, and no new tool.
 * Note `ecommerce_order` (Mailchimp's marketing-attribution shadow) and `order`
 * (Shopify's order of record) are DIFFERENT datasets on purpose — the first has
 * no tax, refund or fulfilment column, so revenue arithmetic must not be
 * attempted on it. Collapsing them here would route a revenue question to
 * whichever vendor won the name.
 *
 * Exported so the orchestrator's cross-package drift test can assert the
 * route's dataset vocabulary and this enum are the same list — the two sides
 * are compiled separately and nothing else would catch them diverging.
 */
export const CLOUD_QUERY_DATASETS = [
  "charge",
  "invoice",
  "contact",
  "company",
  "deal",
  "ticket",
  "engagement",
  "campaign",
  "audience_member",
  "ecommerce_order",
  "order",
  "product",
  "customer",
] as const;

const DATASET_SET: ReadonlySet<string> = new Set(CLOUD_QUERY_DATASETS);

/** Forwarded verbatim as query-string params; absent args are never sent so
 *  the route's own defaults (page size, no filter) stay in charge. */
const OPTIONAL_ARGS = ["from", "to", "status", "query", "id", "limit"] as const;

// Property descriptions are deliberately terse — see the size note above; the
// enum already teaches the model the vocabulary, so prose buys nothing.
const inputSchema = {
  type: "object",
  properties: {
    dataset: { type: "string", enum: CLOUD_QUERY_DATASETS },
    from: { type: "string", description: "ISO-8601 start, inclusive" },
    to: { type: "string", description: "ISO-8601 end, exclusive" },
    status: { type: "string", description: "Vendor's own status word" },
    query: { type: "string", description: "Name or email search" },
    id: { type: "string", description: "A single record id" },
    limit: { type: "number", description: "Max rows" },
  },
  required: ["dataset"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const dataset = args.dataset;
  // Re-checked here even though `enum` already constrains it: `dataset` is
  // interpolated into the request PATH, and the schema is enforced by whatever
  // transport happens to be in front of us. A model-supplied `../write-requests`
  // must never be able to re-target the GET at a different route.
  if (typeof dataset !== "string" || !DATASET_SET.has(dataset)) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "VALIDATION",
        message: `dataset must be one of: ${CLOUD_QUERY_DATASETS.join(", ")}`,
      },
    };
  }

  const params: Record<string, unknown> = {};
  for (const key of OPTIONAL_ARGS) {
    if (args[key] !== undefined) params[key] = args[key];
  }

  const res = await ctx.http.orchestrator.get(`/api/erp/dataset/${dataset}`, {
    params,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // The route renders ErpError.toJSON() — `{ error, code }` — so the agent
    // gets the actionable code (ERP_NOT_CONNECTED, FORBIDDEN, VALIDATION …)
    // rather than a bare status. A non-JSON body means something upstream of
    // the route answered (proxy, auth edge); fall back rather than throw,
    // because a thrown error reaches the model as an opaque tool crash.
    let code = "CLOUD_QUERY_FAILED";
    let message = `orchestrator returned ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof body.code === "string" && body.code.length > 0) code = body.code;
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    } catch {
      // non-JSON body — keep the status-derived fallback
    }
    return { ok: false, status: "error", error: { code, message } };
  }

  // `{ dataset, provider, rows, truncated }` passed through unmodified: the
  // route already shaped and capped it, and a second reshape here would be a
  // second place for the wire contract to drift.
  return { ok: true, data: await res.json() };
}

const tool: Tool = {
  name: "cloud_query_dataset",
  // The vendor list that used to sit in this sentence is GONE, and its removal
  // is the point rather than a saving. Adding Shopify's three datasets took the
  // full chat pool to 60,023 chars against `base-prompt-budget.test.ts`'s
  // 60,000 tripwire, and that file's instruction for exactly this moment is
  // "trim the schema" — never raise the ceiling, which only relocates the
  // cliff. Naming the vendors here duplicated the `enum` the model is already
  // shown, cost ~38 chars, and grew with every vendor: a description that lists
  // its providers is a description that cannot survive the fifth one.
  description:
    "Read business records from the connected cloud accounts by dataset name. " +
    "Read-only; the dataset picks the provider.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;

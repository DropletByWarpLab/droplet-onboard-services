/**
 * `business_link` (ADR-045 slice D) — one verb for joining two business
 * records that already exist.
 *
 * DESIGNED TO DEGRADE. ADR-045 intends a graph: a deal to the project that
 * delivers it, a project to its customer, a task to the task blocking it, a
 * file to whatever it is evidence of, a task to the department that owns
 * it. On `stage` today, exactly TWO of those edges have a table behind
 * them, and both live on `CrmDeal` — `projectId` and `companyId`, from the
 * WARP-2117 join (`onDelete: SetNull`, so deleting the project never
 * deletes the record of the sale). `PmProject` has no `companyId` column;
 * there is no work-item relation table, no file-to-record link table, and
 * no department column on a work item.
 *
 * So the whole intended graph ships as DATA in `LINK_EDGES` and two
 * branches ship as CODE. An edge nobody has built yet is a row with
 * `status: "not_built"` and a `blockedBy` string, and the caller gets a
 * self-describing refusal naming both what it is waiting for and what does
 * work today — instead of a stack trace, a silent success, or a tool that
 * would not compile until four other slices land. When slice F/G/H arrive
 * they flip one word in that table and add a dispatch branch: no schema
 * change, no registry change, no budget change.
 *
 * WHY `from_entity` / `to_entity` / `kind` ARE PLAIN STRINGS, not enums.
 * Deliberate, and the opposite call from `business_create`'s `entity`.
 * Those three fields are precisely the value space slices F, G and H
 * EXTEND, and a shared enum would be (a) a four-way merge collision on one
 * literal array and (b) a grammar-level rejection where a refusal that
 * names the alternatives is far more useful to a model. `entity` on the
 * create/update verbs is the opposite case: a closed set that must never
 * grow, because the value it must never admit is `patient`.
 *
 * OUT OF DEFAULT CHAT SCOPE, on purpose (site 7). Two live edges, both of
 * which are a drag on the pipeline board, do not justify 671 chars on every
 * matching turn when the chat pool has 136 chars of headroom. Dashboard and
 * external MCP clients see it; `allowed_tools` overrides. Revisit when the
 * not_built rows go live or when the CRM reads leave the pool.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import {
  businessError,
  invalidArgs,
  refuseNotBuilt,
  refuseUnknownEdge,
  resolveEdge,
} from "./write-shared.js";

/** No `minLength`/`maxLength`/`pattern`/`enum` at all (WARP-1839 for the
 *  first three; composability for the last — see the header). */
const inputSchema = {
  type: "object",
  properties: {
    from_entity: { type: "string", description: "Kind of the record the edge starts at, e.g. deal." },
    from_id: { type: "string" },
    to_entity: { type: "string", description: "Kind of the record it points to, e.g. project." },
    to_id: { type: "string" },
    kind: {
      type: "string",
      description: "The edge, e.g. delivers. An unsupported one is refused with the list that works.",
    },
  },
  required: ["from_entity", "from_id", "to_entity", "to_id", "kind"],
  additionalProperties: false,
} as const;

interface Args {
  from_entity: string;
  from_id: string;
  to_entity: string;
  to_id: string;
  kind: string;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { from_entity, from_id, to_entity, to_id, kind } = args as unknown as Args;

  const fromId = typeof from_id === "string" ? from_id.trim() : "";
  const toId = typeof to_id === "string" ? to_id.trim() : "";
  if (fromId.length === 0 || toId.length === 0) {
    return invalidArgs("from_id and to_id are both required and must be non-empty.");
  }

  // The table is the gate, and it is consulted BEFORE anything else. An
  // entity nobody serves — `patient` included — simply is not in it, and
  // the refusal enumerates only what exists.
  const edge = resolveEdge(from_entity, to_entity, kind);
  if (!edge) return refuseUnknownEdge();
  if (edge.status === "not_built") return refuseNotBuilt(edge);

  try {
    // Both live edges are columns on the DEAL, so both are one PATCH. The
    // direction is the schema's, not a convenience: `CrmDeal.projectId` and
    // `CrmDeal.companyId` are SetNull precisely so losing the project or
    // the account leaves the commercial record intact.
    const body =
      edge.to === "project" ? { projectId: toId } : { companyId: toId };
    const data = await callOrch<{
      deal: { id: string; title: string; company: string | null };
    }>(ctx, "patch", `/api/crm/deals/${encodeURIComponent(fromId)}`, body);
    return {
      ok: true,
      data: {
        linked: {
          from: { entity: edge.from, id: data.deal.id, name: data.deal.title },
          to: { entity: edge.to, id: toId },
          kind: edge.kind,
        },
      },
    };
  } catch (err) {
    // Both live edges are a deal PATCH under `/api/crm`, so the CRM is the
    // module named if the 404 turns out to be a switch.
    return businessError(err, "deal");
  }
}

const tool: Tool = {
  name: "business_link",
  description:
    "Join two business records that already exist, such as a deal to the project that delivers it.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

/**
 * `business_link` (ADR-045 slice D) — one verb for joining two business
 * records that already exist.
 *
 * DESIGNED TO DEGRADE. ADR-045 intends a graph: a deal to the project that
 * delivers it, a project to its customer, a task to the task blocking it, a
 * file to whatever it is evidence of, a task to the department that owns
 * it. On `stage` today, exactly TWO of those edges are writable by this
 * tool, and both live on `CrmDeal` — `projectId` and `companyId`, from the
 * WARP-2117 join (`onDelete: SetNull`, so deleting the project never
 * deletes the record of the sale). Two more have their column or table now
 * (`PmProject.companyId`, `EntityLink`) but a write route that admits only
 * a signed-in human, not the assistant's principal; there is still no
 * work-item relation table and no department column on a work item.
 * `LINK_EDGES`'s header in `write-shared.ts` says which is which.
 *
 * So the whole intended graph ships as DATA in `LINK_EDGES` and two
 * branches ship as CODE. An edge this box cannot write yet is a row with
 * `status: "not_built"` and a `blockedBy` string, and the caller gets a
 * self-describing refusal naming both what it is waiting for and what does
 * work today — instead of a stack trace, a silent success, or a tool that
 * would not compile until four other slices land. When a blocker clears —
 * a table lands, or a route admits the principal — that slice flips one
 * word in the table and adds a dispatch branch: no schema change, no
 * registry change, no budget change.
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

  // 🔴 WARP-2757 — the dispatch comes off the EDGE ROW, and this file no
  // longer knows the word "deal".
  //
  // It used to be `edge.to === "project" ? { projectId } : { companyId }` with
  // the endpoint hard-coded to `/api/crm/deals/`. That was correct only by
  // coincidence: both live edges happen to be columns on the deal, so "not
  // project" could stand in for "customer". The next live edge is
  // `project -> customer` — `PmProject.companyId` already exists — and under
  // the old shape it would PATCH `{companyId}` to `/api/crm/deals/<a project
  // id>`, then report the 404 as a missing deal. Nothing about updating the
  // table would have made the author look at this line.
  const { write } = edge;

  // 🔴 The ROUTE literal stays inline HERE, and that is a constraint, not a
  // style choice: `tool-routes.test.ts` reads a tool's declared hops out of
  // its handler source by finding the literal in the `callOrch` call. A URL
  // moved onto the edge row — or even into a local `const` built by a ternary
  // — goes invisible to it, and the manifest then asserts a hop nothing can be
  // shown to make. The row owns the CHOICE; this file owns the literals.
  //
  // So a new live subject fails in two places at once, which is the design:
  // there is no route for it here, and there is no manifest entry for it.
  if (write.subject !== "deal") {
    // Unreachable while `deal` is the only live subject. A refusal rather than
    // a throw: a live edge with no route here is a mis-wiring, and the caller
    // should hear that this box cannot do it yet rather than see a 500.
    return refuseNotBuilt({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      status: "not_built",
      blockedBy: `business_link has no route for a ${write.subject} subject yet`,
    });
  }

  try {
    const data = await callOrch<unknown>(
      ctx,
      "patch",
      `/api/crm/deals/${encodeURIComponent(fromId)}`,
      write.body(toId),
    );
    const subject = write.readBack(data);
    return {
      ok: true,
      data: {
        linked: {
          from: { entity: edge.from, id: subject.id, name: subject.name },
          to: { entity: edge.to, id: toId },
          kind: edge.kind,
        },
      },
    };
  } catch (err) {
    // The module named by a `module_disabled` refusal follows the SUBJECT of
    // the write, not a constant: a future `project -> customer` edge is a
    // Projects call, and telling its caller to switch on the CRM would send
    // them to the wrong switch.
    return businessError(err, write.subject);
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

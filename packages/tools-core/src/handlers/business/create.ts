/**
 * `business_create` (ADR-045 slice D) — one verb for bringing a business
 * record into being.
 *
 * REPLACES `pm_create_project`, `pm_create_work_item`,
 * `pm_add_work_item_comment` and `crm_log_activity`, and ADDS the customer
 * and deal creation the CRM has never had a tool for — four tools' worth of
 * capability, plus two new ones, for less serialized budget than the four
 * cost (measured: 1,024 chars against 977 + 705 + 507 + 573).
 *
 * WHY ONE VERB. The four it replaces were four schemas the model had to
 * choose between before it could act, and three of them were excluded from
 * chat for budget, so the choice was mostly theoretical: on a real turn the
 * assistant could start a project and nothing else. Collapsing to
 * `entity` + `name` + a parent makes the whole surface reachable inside the
 * budget that used to buy one corner of it.
 *
 * CONFIRMATION. `requiresWrite` + `requiresConfirmation`, enforced
 * GENERICALLY by the WARP-2305 dispatch interceptor. There is deliberately
 * no confirmation code in this file: the interceptor refuses the first
 * call, mints a token bound to these exact arguments, and runs this handler
 * only once that token comes back. `confirmationOwner` is left unset (=
 * `"interceptor"`) because none of the routes below ever answers 202 —
 * verified: neither `routes/crm.ts` nor `routes/pm/native.ts` contains one.
 *
 * ERRORS CARRY NO `details`. See `write-shared.ts` — a confirmation token
 * has reached the model through `error.details` before, and the answer
 * here is a result shape with no field it could be placed in.
 *
 * PHI. `patient` is not an `entity` value, the enum makes it un-emittable
 * under the DMR grammar, and the runtime check refuses anything outside
 * `CREATABLE` without echoing what was asked for.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
import {
  CREATABLE,
  NOTE_KINDS,
  businessError,
  invalidArgs,
  refuseEntity,
  type CreatableEntity,
  type NoteKind,
} from "./write-shared.js";

/**
 * NO `minLength` / `maxLength` / `pattern` anywhere (WARP-1839): those are
 * the keywords llama.cpp expands into repeated grammar rules, and one of
 * them took tool calling off the appliance entirely. Length is checked at
 * runtime below, which is where it was actually enforced even before the
 * DMR flip — the ai-gateway strips those keywords on the way out.
 *
 * `entity` DOES carry an `enum`, and that is not a size optimisation. It is
 * the PHI gate: the model must not be able to emit `patient` at all, and
 * `enum` survives the sanitizer (it is in `_SCHEMA_DATA_KEYS`) so it
 * reaches the grammar and constrains decoding. Five short literals compile
 * to a trivial alternation; `crm_log_activity` shipped a five-member enum
 * inside the chat pool for exactly as long as the CRM has existed.
 */
const inputSchema = {
  type: "object",
  properties: {
    entity: { type: "string", enum: [...CREATABLE] },
    name: {
      type: "string",
      description: "Name or title. For a note, the one-line summary of what happened.",
    },
    parent_entity: {
      type: "string",
      description: "What it hangs off: project for a task; customer, deal or task for a note.",
    },
    parent_id: { type: "string", description: "Id of that parent. Required for task and note." },
    note_kind: {
      type: "string",
      description: "Note on a customer or deal: call, meeting, task or email. Default note.",
    },
    description: { type: "string", description: "Longer body for a task or a project." },
    identifier: {
      type: "string",
      description: "Project only: key prefix for its tasks, letters and digits up to 10, e.g. ROOF.",
    },
  },
  required: ["entity", "name"],
  additionalProperties: false,
} as const;

interface Args {
  entity: CreatableEntity;
  name: string;
  parent_entity?: string;
  parent_id?: string;
  note_kind?: string;
  description?: string;
  identifier?: string;
}

/**
 * The route's own bound on `name`, per entity, so an over-long one comes back
 * as a message the model can act on instead of an opaque 400 from zod:
 * `companyCreateSchema.name` 300, `dealCreateSchema.title` 300,
 * `projectCreateSchema.name` 200, `workItemCreateSchema.name` 500,
 * `activityCreateSchema.summary` 1000 (a note on a task becomes a comment,
 * bounded far higher; 1000 is the tighter of the two and what a "one-line
 * summary" should meet anyway). ONE table, consulted before the switch: a
 * single shared gate at 500 once ran first and made the note bound dead code.
 */
const NAME_MAX: Record<CreatableEntity, number> = {
  customer: 300,
  deal: 300,
  project: 200,
  task: 500,
  note: 1000,
};

/** `projectCreateSchema.description` / `workItemCreateSchema.description_html`. */
const DESCRIPTION_MAX = { project: 10_000, task: 100_000 } as const;

/** `projectCreateSchema.identifier`: 1–10 letters or digits. */
const IDENTIFIER_RE = /^[A-Za-z0-9]{1,10}$/;

/** What every branch returns: the id the caller needs to act next, and
 *  nothing else. A creator does not need the whole row read back, and a
 *  tool result is read by a model with a finite context. */
function created(entity: string, id: string, name: string): ToolResult {
  return { ok: true, data: { created: { entity, id, name } } };
}

function requireParent(
  entity: string,
  parentId: unknown,
  why = `is required when creating a ${entity}`,
): string | ToolResult {
  if (typeof parentId !== "string" || parentId.trim().length === 0) {
    return invalidArgs(`parent_id ${why}.`);
  }
  return parentId.trim();
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { entity, name, parent_entity, parent_id, note_kind, description, identifier } =
    args as unknown as Args;

  if (typeof entity !== "string" || !(CREATABLE as readonly string[]).includes(entity)) {
    return refuseEntity("business_create");
  }
  const title = typeof name === "string" ? name.trim() : "";
  if (title.length === 0) {
    return invalidArgs("name is required and must be a non-empty string.");
  }
  if (title.length > NAME_MAX[entity]) {
    return invalidArgs(`name must be at most ${NAME_MAX[entity]} characters for a ${entity}.`);
  }
  // Neither optional field is ever silently dropped — the same rule as
  // `note_kind` on a task. An argument that meant nothing is refused by name
  // so the model can fix the call, rather than told "done".
  if (description !== undefined) {
    if (entity !== "task" && entity !== "project") {
      return invalidArgs("description applies to a task or a project.");
    }
    if (typeof description !== "string" || description.length > DESCRIPTION_MAX[entity]) {
      return invalidArgs(
        `description must be a string of at most ${DESCRIPTION_MAX[entity]} characters.`,
      );
    }
  }
  if (identifier !== undefined) {
    if (entity !== "project") {
      return invalidArgs("identifier applies to a project.");
    }
    if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) {
      return invalidArgs("identifier must be 1-10 characters, letters and digits only.");
    }
  }

  try {
    switch (entity) {
      case "customer": {
        const data = await callOrch<{ company: { id: string; name: string } }>(
          ctx,
          "post",
          "/api/crm/companies",
          { name: title },
        );
        return created("customer", data.company.id, data.company.name);
      }

      case "deal": {
        // `companyId` is optional on the route: a deal that arrives before
        // its account does is a real thing, and refusing it here would make
        // "log the enquiry from the trade show" impossible. Attach the
        // customer later with business_link.
        //
        // But a parent that IS named must be a customer — refused otherwise,
        // as the task branch refuses a non-project — and must be a real id.
        // `createDeal` treats `companyId: ""` as "skip the exists check" and
        // then WRITES the empty string (`input.companyId ?? null`: "" is not
        // null), which is neither a customer nor the absent state.
        if (parent_entity !== undefined && parent_entity !== "customer") {
          return invalidArgs(
            "a deal hangs off a customer; set parent_entity to customer, or leave both parent fields out for a deal with no customer yet.",
          );
        }
        let companyId: string | undefined;
        if (parent_entity !== undefined || parent_id !== undefined) {
          const customerId = requireParent(
            "deal",
            parent_id,
            "must be the customer's id when a parent is given",
          );
          if (typeof customerId !== "string") return customerId;
          companyId = customerId;
        }
        const data = await callOrch<{ deal: { id: string; title: string } }>(
          ctx,
          "post",
          "/api/crm/deals",
          { title, companyId },
        );
        return created("deal", data.deal.id, data.deal.title);
      }

      case "project": {
        // `workspace_slug` omitted on purpose: the route defaults to the
        // single workspace a box has, and carrying the property would spend
        // schema budget on a concept no owner has ever had to name.
        const data = await callOrch<{ project: { id: string; name: string } }>(
          ctx,
          "post",
          "/api/pm/projects",
          { name: title, description, identifier },
        );
        return created("project", data.project.id, data.project.name);
      }

      case "task": {
        if (parent_entity !== undefined && parent_entity !== "project") {
          return invalidArgs("a task hangs off a project; set parent_entity to project.");
        }
        const projectId = requireParent("task", parent_id);
        if (typeof projectId !== "string") return projectId;
        // `labels` is NOT carried, and `business_update` does not take it
        // either. The route wants label IDS (`label_ids`), and no tool reads
        // a project's labels — `GET /pm/projects/:id/labels` has nothing
        // behind it — so from chat the property could only ever be filled
        // with an invented value: schema budget spent advertising an
        // argument that cannot be right. It returns the day a label read
        // exists, resolved from names here, in the same change.
        const data = await callOrch<{ work_item: { id: string; name: string } }>(
          ctx,
          "post",
          `/api/pm/projects/${encodeURIComponent(projectId)}/work-items`,
          { name: title, description_html: description },
        );
        return created("task", data.work_item.id, data.work_item.name);
      }

      case "note": {
        const subjectId = requireParent("note", parent_id);
        if (typeof subjectId !== "string") return subjectId;

        // A note on a TASK is a work-item comment; a note on a customer or
        // deal is a CRM timeline entry. Two stores, one verb — which is the
        // point of the collapse, and why both hops are declared in
        // TOOL_ROUTES rather than one being hidden behind the other.
        if (parent_entity === "task") {
          if (note_kind !== undefined) {
            return invalidArgs("note_kind applies to notes on a customer or deal, not on a task.");
          }
          const data = await callOrch<{ comment: { id: string } }>(
            ctx,
            "post",
            `/api/pm/work-items/${encodeURIComponent(subjectId)}/comments`,
            { comment_html: title },
          );
          return created("note", data.comment.id, title);
        }

        if (parent_entity !== "customer" && parent_entity !== "deal") {
          return invalidArgs("a note hangs off a customer, a deal or a task; set parent_entity.");
        }

        const kind = (typeof note_kind === "string" ? note_kind.trim().toUpperCase() : "NOTE") as NoteKind;
        if (!(NOTE_KINDS as readonly string[]).includes(kind)) {
          // The box writes STAGE_CHANGE / CREATED / SYNCED when the thing
          // they describe actually happens. A model-written stage change
          // with no move behind it would make the timeline lie about the
          // pipeline, so this refusal is a feature, not a validation nit.
          return invalidArgs(`note_kind must be one of: ${NOTE_KINDS.join(", ").toLowerCase()}.`);
        }

        const data = await callOrch<{ activity: { id: string } }>(
          ctx,
          "post",
          "/api/crm/activities",
          {
            subjectType: parent_entity === "deal" ? "DEAL" : "COMPANY",
            companyId: parent_entity === "customer" ? subjectId : null,
            dealId: parent_entity === "deal" ? subjectId : null,
            kind,
            summary: title,
          },
        );
        return created("note", data.activity.id, title);
      }
    }
  } catch (err) {
    return businessError(err, entity);
  }
}

const tool: Tool = {
  name: "business_create",
  description:
    "Create a new record: a customer, a deal, a project, a task under a project, or a note on a customer, deal or task.",
  inputSchema,
  requiresWrite: true,
  // Enforced generically by the WARP-2305 dispatch interceptor. Setting the
  // flag IS the integration; do not hand-roll a prompt here.
  requiresConfirmation: true,
  handler,
};

export default tool;

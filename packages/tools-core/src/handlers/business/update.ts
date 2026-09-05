/**
 * `business_update` (ADR-045 slice D) — one verb for changing a business
 * record that already exists.
 *
 * REPLACES `crm_move_deal_stage` and `pm_update_work_item` /
 * `pm_transition_work_item`. Read that list again: BOTH of the state-moving
 * tools were excluded from default chat purely for schema budget
 * (`chat-tool-scope.ts` says so for the CRM one in as many words), so on a
 * real owner turn the assistant could describe a pipeline and never move
 * anything in it. This tool is how "move the Acme deal to negotiation" and
 * "mark the dishwasher ticket done" become reachable at all — and it fits,
 * because it costs 617 chars where the two it replaces cost 405 + 601 +
 * 539.
 *
 * ONE HOP PER ENTITY — and that is a WARP-2579 consequence, not an
 * accident. `updateDeal` used to call `moveDealStage` first, which
 * committed its own transaction, and only then validate the fields; a PATCH
 * with a good stage and a bad company moved the deal and then threw. The
 * fix extracted `applyStageMove(tx, …)` so the move rides in the SAME
 * transaction as the field update and still writes its `STAGE_CHANGE`
 * timeline row. So `PATCH /api/crm/deals/:id { stageId, title, ownerId }`
 * is now atomic and complete, and dispatching a separate
 * `POST /deals/:id/stage` would re-open exactly the partial-write window
 * WARP-2579 closed. The PM side is the same story from the other end:
 * `transitionWorkItem` is literally
 * `updateWorkItem(prisma, actorId, id, { stateId })`, activity rows and
 * `isCompleted` sync included.
 *
 * `project` IS NOT AN ENTITY HERE. `PATCH /api/pm/projects/:id` is
 * `requireRole(...WRITE)` and does not admit the `_service:mcp` principal —
 * unlike `POST /api/pm/projects`, widened on purpose so project creation
 * would work. A `project` branch would ship registered and 403ing. See
 * `write-shared.ts`.
 *
 * WHAT A TASK CAN AND CANNOT CHANGE FROM HERE. `pm_update_work_item` took
 * `name`, `description_html`, `assignees` and `labels`. This verb carries
 * the first three (`description` -> `description_html`, the same field and
 * bound `create.ts` uses, so "rewrite the body of that ticket" is not a
 * capability the collapse quietly lost — #2005's review caught that it had
 * been). `labels` is deliberately absent on BOTH verbs, for the reason
 * `create.ts` gives at its task branch: the route wants label IDS and no
 * tool reads a project's labels, so a model has nothing to pass. When a
 * read exists the argument lands on create and update in one commit.
 *
 * CONFIRMATION + ERROR SHAPE: as `create.ts` — generic interceptor, no
 * handler-side prompt, and no `details` on any failure.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch, toPlaneWorkItem } from "../pm/pm-orch.js";
import {
  UPDATABLE,
  businessError,
  invalidArgs,
  refuseEntity,
  type UpdatableEntity,
} from "./write-shared.js";

/** No `minLength`/`maxLength`/`pattern` (WARP-1839). `enum` on `entity`
 *  only, and for the PHI reason spelled out in `create.ts`. */
const inputSchema = {
  type: "object",
  properties: {
    entity: { type: "string", enum: [...UPDATABLE] },
    id: { type: "string" },
    state: { type: "string", description: "Stage id for a deal, workflow-state id for a task." },
    assignee: {
      type: "string",
      description: "Person id to own the customer or deal, or to be assigned the task.",
    },
    name: { type: "string", description: "New name or title." },
    description: { type: "string", description: "Task only: replaces the longer body." },
  },
  required: ["entity", "id"],
  additionalProperties: false,
} as const;

interface Args {
  entity: UpdatableEntity;
  id: string;
  state?: string;
  assignee?: string;
  name?: string;
  description?: string;
}

/** `workItemPatchSchema.description_html` — the bound `create.ts` mirrors
 *  for the same field, checked here so an over-long body comes back as a
 *  sentence rather than an opaque 400 from zod. */
const TASK_DESCRIPTION_MAX = 100_000;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { entity, id, state, assignee, name, description } = args as unknown as Args;

  if (typeof entity !== "string" || !(UPDATABLE as readonly string[]).includes(entity)) {
    return refuseEntity("business_update");
  }
  const recordId = typeof id === "string" ? id.trim() : "";
  if (recordId.length === 0) {
    return invalidArgs("id is required and must be a non-empty string.");
  }

  const title = typeof name === "string" ? name.trim() : undefined;
  if (title !== undefined && title.length === 0) {
    return invalidArgs("name must be a non-empty string when supplied.");
  }
  const body = typeof description === "string" ? description : undefined;
  if (description !== undefined && body === undefined) {
    return invalidArgs("description must be a string when supplied.");
  }
  if (body !== undefined && entity !== "task") {
    // A customer's and a deal's free text are their notes, which are
    // timeline entries (`business_create({entity:"note"})`), not a field.
    return invalidArgs("description applies to a task.");
  }
  if (body !== undefined && body.length > TASK_DESCRIPTION_MAX) {
    return invalidArgs(`description must be at most ${TASK_DESCRIPTION_MAX} characters.`);
  }
  if (state === undefined && assignee === undefined && title === undefined && body === undefined) {
    // A PATCH with no fields is a write the user approved for nothing.
    // Refusing costs one turn; a silent no-op costs the user's trust in
    // every subsequent "done".
    return invalidArgs("supply at least one of state, assignee, name or description.");
  }
  if (state !== undefined && entity === "customer") {
    // A customer has no workflow. The archive flag is deliberately not
    // exposed here — archiving an account is a dashboard decision, not a
    // side effect of a rename.
    return invalidArgs("a customer has no state; use state on a deal or a task.");
  }

  try {
    switch (entity) {
      case "customer": {
        const data = await callOrch<{ company: { id: string; name: string } }>(
          ctx,
          "patch",
          `/api/crm/companies/${encodeURIComponent(recordId)}`,
          { name: title, ownerId: assignee },
        );
        return { ok: true, data: { updated: { entity, id: data.company.id, name: data.company.name } } };
      }

      case "deal": {
        // ONE call. `stageId` here moves the deal AND writes its
        // STAGE_CHANGE timeline entry, in the same transaction as the field
        // update — see the header. `stage` is echoed back because the
        // stage's NAME is the thing a person recognises, and the outcome
        // (`stage.kind`) is never the stage name.
        const data = await callOrch<{
          deal: { id: string; title: string; stage: { name: string; kind: string } };
        }>(ctx, "patch", `/api/crm/deals/${encodeURIComponent(recordId)}`, {
          title,
          stageId: state,
          ownerId: assignee,
        });
        return {
          ok: true,
          data: {
            updated: {
              entity,
              id: data.deal.id,
              name: data.deal.title,
              stage: data.deal.stage.name,
              outcome: data.deal.stage.kind,
            },
          },
        };
      }

      case "task": {
        // `assignees` is a SET on the route, not an append: handing a task
        // to someone means they own it now. If multi-assignee ever needs to
        // be expressible from chat it gets its own argument, rather than
        // this one quietly meaning two things.
        //
        // `label_ids` is NOT sent — see the header. The omission is a
        // decision shared with `create.ts`, not a field this branch forgot.
        const data = await callOrch<{ work_item: Parameters<typeof toPlaneWorkItem>[0] }>(
          ctx,
          "patch",
          `/api/pm/work-items/${encodeURIComponent(recordId)}`,
          {
            name: title,
            description_html: body,
            state_id: state,
            assignees: assignee === undefined ? undefined : [assignee],
          },
        );
        // The route answers with the full ApiWorkItem, whose `state` is an
        // ApiState OBJECT (`{id, projectId, name, group, …}`), and `callOrch`
        // does no runtime validation. `toPlaneWorkItem` is what turns that
        // into the state's NAME on the read path; going through it here
        // keeps the two paths from disagreeing about what a state looks like.
        const w = toPlaneWorkItem(data.work_item);
        return {
          ok: true,
          data: { updated: { entity, id: w.id, name: w.name, state: w.state ?? null } },
        };
      }
    }
  } catch (err) {
    return businessError(err, entity);
  }
}

const tool: Tool = {
  name: "business_update",
  description:
    "Change a customer, deal or task: move it to a new stage or state, reassign it, rename it, " +
    "or rewrite a task's description.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

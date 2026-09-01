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
 * CONFIRMATION + ERROR SHAPE: as `create.ts` — generic interceptor, no
 * handler-side prompt, and no `details` on any failure.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { callOrch } from "../pm/pm-orch.js";
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
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { entity, id, state, assignee, name } = args as unknown as Args;

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
  if (state === undefined && assignee === undefined && title === undefined) {
    // A PATCH with no fields is a write the user approved for nothing.
    // Refusing costs one turn; a silent no-op costs the user's trust in
    // every subsequent "done".
    return invalidArgs("supply at least one of state, assignee or name.");
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
        const data = await callOrch<{
          work_item: { id: string; name: string; state?: string };
        }>(ctx, "patch", `/api/pm/work-items/${encodeURIComponent(recordId)}`, {
          name: title,
          state_id: state,
          assignees: assignee === undefined ? undefined : [assignee],
        });
        return {
          ok: true,
          data: {
            updated: {
              entity,
              id: data.work_item.id,
              name: data.work_item.name,
              state: data.work_item.state ?? null,
            },
          },
        };
      }
    }
  } catch (err) {
    return businessError(err);
  }
}

const tool: Tool = {
  name: "business_update",
  description:
    "Change a customer, deal or task: move it to a new stage or state, reassign it, or rename it.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;

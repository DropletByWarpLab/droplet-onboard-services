/**
 * ADR-045 slice D — the shared vocabulary behind `business_create`,
 * `business_update` and `business_link`.
 *
 * WHY THIS FILE EXISTS. The collapse replaces seven tools
 * (`pm_create_project`, `pm_create_work_item`, `pm_update_work_item`,
 * `pm_transition_work_item`, `pm_add_work_item_comment`,
 * `crm_move_deal_stage`, `crm_log_activity`) with three verbs. Those three
 * share one entity vocabulary and one error mapping, and a second copy of
 * either is a second place for a word like `patient` to appear in an
 * entity list. So there is one copy, here.
 *
 * WHAT IS DELIBERATELY *NOT* HERE: any `ctx.http` / `callOrch` call.
 * `__tests__/tool-routes.test.ts` extracts a handler's real hops by parsing
 * the SOURCE FILE that declares the registered `name:` — nothing else. A
 * hop dispatched from a shared module is invisible to that gate, which
 * would turn the manifest back into the unchecked comment WARP-1455 exists
 * to abolish. Every HTTP call therefore lives in the handler file itself,
 * with a literal path, even where that costs a little repetition.
 *
 * PHI, NON-NEGOTIABLE (ADR-044). `patient` is not an entity value here and
 * never becomes one, and no `business_*` result carries a practice field.
 * The practice block is served by the ERP router behind the same `canRead`
 * reference as `/erp/patient/:id`; the CRM's own write gate is
 * `["owner", "admin", "family"]` — a gate `family` passes — so a
 * CRM-shaped door onto practice data would be a door with a weaker lock.
 * The refusals below enumerate only the entities that DO exist, so a
 * refusal cannot confirm the shape of what was asked for either.
 */

import type { ToolResult } from "../../types.js";
import { OrchPmError } from "../pm/pm-orch.js";

/**
 * Everything `business_create` can bring into being.
 *
 * `contact` is ABSENT, and the reason is a route fact rather than a design
 * one: nothing creates a `Contact` through a door the `_service:mcp`
 * principal can open. `POST /api/contacts` is `requireRole(...WRITE)`, and
 * `POST /api/crm/companies/:id/contacts` is both `requireRole` AND a LINK
 * route that requires a `contactId` that already exists. Adding a `contact`
 * branch would ship a tool that 403s — the exact shipped-but-dead class
 * `TOOL_ROUTES` exists to close. Widening the address book's auth is a
 * security decision with its own admission test, not a line in a tool slice.
 */
export const CREATABLE = ["customer", "deal", "project", "task", "note"] as const;
export type CreatableEntity = (typeof CREATABLE)[number];

/**
 * Everything `business_update` can change. Narrower than {@link CREATABLE},
 * and again for route reasons:
 *
 *   - `project` — `PATCH /api/pm/projects/:id` is `requireRole(...WRITE)`
 *     and does not admit the mcp principal, unlike `POST /api/pm/projects`
 *     which was widened deliberately. Creating a project from chat works;
 *     renaming one does not, and must not be advertised as if it did.
 *   - `note` — append-only by design. A timeline entry is evidence of what
 *     happened; a verb that edits it is a verb that rewrites the record.
 */
export const UPDATABLE = ["customer", "deal", "task"] as const;
export type UpdatableEntity = (typeof UPDATABLE)[number];

/**
 * The timeline vocabulary a CALLER may write, upper-cased on the wire.
 *
 * `STAGE_CHANGE`, `CREATED` and `SYNCED` are absent for the reason
 * `crm_log_activity` gave when it carried this list as a schema `enum`: the
 * box writes them when the thing they describe actually happens, and a
 * model-written stage change with no move behind it makes the timeline lie
 * about the pipeline. It is a runtime check here rather than a schema
 * `enum` because `business_create`'s schema already spends its enum budget
 * on the PHI-bearing `entity` discriminator; the orchestrator's
 * `activityCreateSchema` enforces the identical list, so this is still the
 * first of two gates and not the only one.
 */
export const NOTE_KINDS = ["NOTE", "CALL", "MEETING", "TASK", "EMAIL"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// ── Refusals ────────────────────────────────────────────────────────────────
//
// Every refusal below is `status: "error"` with a `code` and a `message` and
// NOTHING ELSE. There is no `details` field on any of them, and that is the
// design: a confirmation token has reached the model through `error.details`
// before (WARP-640's flat `details.confirmationToken` rides into the `role:
// "tool"` message the agent loop appends). These handlers cannot repeat it,
// because there is no field to repeat it in — the same shape argument
// `InterceptorAuditEvent` makes about PHI in `interceptor.ts`.

export function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

/**
 * Refuse an entity value we do not serve.
 *
 * The offending value is NOT echoed. Echoing it would be the natural thing
 * to write and is exactly wrong here: the one value this project must never
 * acknowledge is `patient`, and "'patient' is not something business_create
 * works with" acknowledges it. Naming only what exists refuses without
 * confirming anything.
 */
export function refuseEntity(verb: "business_create" | "business_update"): ToolResult {
  const allowed = verb === "business_create" ? CREATABLE : UPDATABLE;
  return invalidArgs(`${verb} works with: ${allowed.join(", ")}. Pick one of those.`);
}

/**
 * One error mapping for all three verbs, over BOTH back ends.
 *
 * `callOrch` throws `OrchPmError` whatever the target, so one mapper covers
 * the PM and CRM routes alike. A non-`OrchPmError` is rethrown rather than
 * flattened: a programming mistake dressed as a tidy tool failure is a
 * mistake nobody ever finds.
 *
 * 404 lets the model say "I couldn't find that deal" instead of "something
 * went wrong". 422 keeps its message verbatim, because the orchestrator's
 * 422s (`invalid_stage`, `amount_needs_currency`, `invalid_state`) name a
 * mistake the model can correct on the next turn; collapsing them into one
 * code makes them unrecoverable.
 */
export function businessError(err: unknown): ToolResult {
  if (err instanceof OrchPmError) {
    const code =
      err.status === 404
        ? "BUSINESS_NOT_FOUND"
        : err.status === 400 || err.status === 422
          ? "BUSINESS_INVALID_REQUEST"
          : "BUSINESS_API_ERROR";
    return { ok: false, status: "error", error: { code, message: err.message } };
  }
  throw err;
}

// ── The link graph ──────────────────────────────────────────────────────────

/**
 * Whether this box can actually write the edge.
 *
 * An EXPLICIT column, never derived from "is there a `case` for it in the
 * handler" (CLAUDE.md: no state derived from an absence). That derivation
 * would make a typo in a switch indistinguishable from a deliberate
 * not-yet, and the caller-facing difference between the two is the whole
 * point of this table: one is a bug, the other is an honest "not on this
 * box yet, here is what it is waiting on".
 */
export type LinkStatus = "live" | "not_built";

export interface LinkEdge {
  /** Entity the edge starts at. */
  from: string;
  /** Entity it points to. */
  to: string;
  /** The edge's own name, so one pair can carry several relationships. */
  kind: string;
  status: LinkStatus;
  /** `not_built` only — what has to exist first. Rendered to the caller. */
  blockedBy?: string;
}

/**
 * Every edge ADR-045 intends, with the truth about each one on `stage`.
 *
 * THE DEGRADATION CONTRACT. Slice D ships the whole intended graph as DATA
 * and only two branches as CODE. An edge whose table does not exist yet is
 * a row here with `status: "not_built"` and a `blockedBy` naming the thing
 * it waits for — so `business_link` compiles today, refuses cleanly and
 * self-describingly today, and becomes capable the day slice F/G/H land by
 * flipping ONE WORD in this table plus adding its dispatch branch. No
 * schema change, no registry change, no budget change, and — because the
 * schema takes `from_entity`/`to_entity`/`kind` as plain strings rather
 * than enums — no shared enum for four slices to collide on.
 *
 * The two live rows are the WARP-2117 join, verified in the schema:
 * `CrmDeal.projectId` and `CrmDeal.companyId` (both `onDelete: SetNull`,
 * both writable through `dealPatchSchema`). Note the direction — the link
 * to a project lives on the DEAL, so that deleting the project leaves the
 * commercial record of the sale intact. `project -> customer` is listed
 * below as `not_built` because `PmProject` genuinely has no `companyId`
 * column on `stage`, whatever a branch stack elsewhere may carry.
 */
export const LINK_EDGES: readonly LinkEdge[] = [
  // ── live on `stage` ──
  { from: "deal", to: "project", kind: "delivers", status: "live" },
  { from: "deal", to: "customer", kind: "belongs_to", status: "live" },

  // ── real edges this box cannot write yet ──
  {
    from: "project",
    to: "customer",
    kind: "for",
    status: "not_built",
    blockedBy: "PmProject has no companyId column yet",
  },
  {
    from: "task",
    to: "task",
    kind: "blocks",
    status: "not_built",
    blockedBy: "the work-item relation table is not built yet",
  },
  {
    from: "task",
    to: "task",
    kind: "relates_to",
    status: "not_built",
    blockedBy: "the work-item relation table is not built yet",
  },
  {
    from: "file",
    to: "record",
    kind: "attached_to",
    status: "not_built",
    blockedBy: "the file-to-record link table is not built yet",
  },
  {
    from: "task",
    to: "department",
    kind: "owned_by",
    status: "not_built",
    blockedBy: "work items carry no department column yet",
  },
  // Not a missing table — a missing GATE. The route exists and works for a
  // signed-in human; it just does not admit the assistant's own principal,
  // and it links a contact that already exists rather than creating one.
  {
    from: "customer",
    to: "contact",
    kind: "has_contact",
    status: "not_built",
    blockedBy: "the contact-link route does not admit the assistant yet",
  },
  {
    from: "deal",
    to: "contact",
    kind: "has_contact",
    status: "not_built",
    blockedBy: "the contact-link route does not admit the assistant yet",
  },
];

export function resolveEdge(
  from: unknown,
  to: unknown,
  kind: unknown,
): LinkEdge | undefined {
  if (typeof from !== "string" || typeof to !== "string" || typeof kind !== "string") {
    return undefined;
  }
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  const k = kind.trim().toLowerCase();
  return LINK_EDGES.find((e) => e.from === f && e.to === t && e.kind === k);
}

/** "deal -> project (delivers), deal -> customer (belongs_to)" */
export function liveEdgeSummary(): string {
  return LINK_EDGES.filter((e) => e.status === "live")
    .map((e) => `${e.from} -> ${e.to} (${e.kind})`)
    .join(", ");
}

/**
 * The pair/kind is not in the table at all — a typo, or an invented edge.
 * Answering with the list that works turns a dead end into one more turn.
 */
export function refuseUnknownEdge(): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "BUSINESS_LINK_UNKNOWN",
      message: `That is not a link this box knows. Links that work today: ${liveEdgeSummary()}.`,
    },
  };
}

/**
 * The edge is real and intended, and this box cannot write it yet.
 *
 * A DIFFERENT code from the unknown case on purpose: "you asked for
 * something that does not exist" and "you asked for something that does not
 * exist YET" are different answers, and only the second one should make a
 * caller (or a reader of the audit log) go looking for the ticket.
 */
export function refuseNotBuilt(edge: LinkEdge): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "BUSINESS_LINK_NOT_AVAILABLE",
      message:
        `${edge.from} -> ${edge.to} (${edge.kind}) is a real link, but ` +
        `${edge.blockedBy ?? "it is not built yet"}. ` +
        `Links that work today: ${liveEdgeSummary()}.`,
    },
  };
}

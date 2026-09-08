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
 * One error mapping for all three verbs, over BOTH back ends — and it is the
 * READ path's, re-exported, not a second copy. A copy is how the write path
 * once shipped without the `module_disabled` branch and answered "that
 * record does not exist" when a module was merely switched off. The mapping
 * itself, and why 404 / 422 / `module_disabled` are kept apart, is in
 * `_graph.ts`.
 */
export { businessError } from "./_graph.js";

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

/**
 * How a LIVE edge is actually written.
 *
 * 🔴 WARP-2757 item 1 — this used to be a bare ternary in `link.ts`:
 *
 *     const body = edge.to === "project" ? { projectId: toId } : { companyId: toId };
 *
 * It was correct only by coincidence. Both live edges happen to be columns on
 * the DEAL, so "not project" could stand in for "customer" and the PATCH
 * endpoint could be hard-coded to `/api/crm/deals/`. The moment a live edge
 * starts anywhere else — `project → customer` is next, and
 * `PmProject.companyId` already exists — that ternary PATCHes `{companyId}` to
 * `/api/crm/deals/<a project id>`: wrong endpoint, wrong record, and a 404 the
 * caller would read as "no such deal".
 *
 * The failure needed an author to update this table and its tests and NOT the
 * ternary thirty lines away in another file, which is the ordinary way that
 * change gets made. So the dispatch moved onto the row: a `live` edge carries
 * its own write, the type makes one without a write impossible to declare, and
 * `link.ts` no longer knows the word "deal".
 */
export interface LinkWrite {
  /**
   * Which entity OWNS the column — the record the PATCH is addressed to, and
   * the key `link.ts` looks its ROUTE up under.
   *
   * The route literal deliberately stays in the handler: `tool-routes.test.ts`
   * reads declared hops out of the handler SOURCE, and a URL that moved into
   * this file would be invisible to it — the manifest would then claim a hop
   * nothing could be shown to make. So the row owns the CHOICE and the handler
   * owns the literals, and adding a subject fails in two places at once:
   * `link.ts` has no route for it, and the manifest has no entry.
   */
  subject: string;
  /** The PATCH body that sets the edge to `targetId`. */
  body: (targetId: string) => Record<string, string>;
  /** Read the subject's id and display name back out of the response. */
  readBack: (json: unknown) => { id: string; name: string };
}

interface LinkEdgeBase {
  /** Entity the edge starts at. */
  from: string;
  /** Entity it points to. */
  to: string;
  /** The edge's own name, so one pair can carry several relationships. */
  kind: string;
}

/**
 * A discriminated union, not one shape with two optional fields.
 *
 * `status: "live"` REQUIRES `write`, so an edge flipped live without a
 * dispatch is a compile error at the table rather than a wrong PATCH at
 * runtime — which is the strongest version of the guard the ticket asked for.
 * `LIVE_EDGES_CARRY_A_WRITE` below is the same check for callers who reach
 * this table from JavaScript.
 */
export type LinkEdge =
  | (LinkEdgeBase & { status: "live"; write: LinkWrite; blockedBy?: never })
  | (LinkEdgeBase & { status: "not_built"; blockedBy: string; write?: never });

/** Shape of `PATCH /api/crm/deals/:id`'s response, as this file reads it. */
interface DealPatchResponse {
  deal: { id: string; title: string };
}

/** Both live edges today are columns on the DEAL, and each one says so for
 *  itself rather than letting the handler assume it of all of them. */
const dealWrite = (column: "projectId" | "companyId"): LinkWrite => ({
  subject: "deal",
  body: (targetId) => ({ [column]: targetId }),
  readBack: (json) => {
    const d = (json as DealPatchResponse).deal;
    return { id: d.id, name: d.title };
  },
});

/**
 * Every edge ADR-045 intends, with the truth about each one on `stage`.
 *
 * THE DEGRADATION CONTRACT. Slice D ships the whole intended graph as DATA
 * and only two branches as CODE. An edge this box cannot write yet is a row
 * here with `status: "not_built"` and a `blockedBy` naming the thing it
 * waits for — so `business_link` compiles today, refuses cleanly and
 * self-describingly today, and becomes capable the day its blocker clears
 * by flipping ONE WORD in this table plus adding its dispatch branch. No
 * schema change, no registry change, no budget change, and — because the
 * schema takes `from_entity`/`to_entity`/`kind` as plain strings rather
 * than enums — no shared enum for four slices to collide on.
 *
 * TWO KINDS OF BLOCKER, and each `blockedBy` says which. A missing TABLE
 * (`task -> task`, `task -> department`) waits on a schema slice. A missing
 * GATE is a route that exists and works for a signed-in human but does not
 * admit the assistant's `_service:mcp` principal — flipping the word here
 * without widening the route would ship a branch that 403s, the exact thing
 * `business_update` refuses `project` to avoid. Two rows moved from the
 * first kind to the second while #2005 was open, and their strings now say
 * so rather than naming a table that exists:
 *   - `project -> customer`: `PmProject.companyId` landed (WARP-2562,
 *     ADR-044) and `business_find` already READS it, but the writer is
 *     `PATCH /api/pm/projects/:id`, which is `requireRole(...WRITE)`.
 *   - `file -> record`: the `EntityLink` table and `/api/crm/entity-links`
 *     landed (WARP-2585), but that router is deliberately not
 *     `requireRoleOrMcpService` — it resolves the file through the CALLER's
 *     own Nextcloud session, a trust surface the service principal does not
 *     carry. Its own header says the principal is admitted there, with the
 *     asserted-user handling, when the tool half lands. A route change with
 *     its own review, not a word flip.
 *
 * The two live rows are the WARP-2117 join, verified in the schema:
 * `CrmDeal.projectId` and `CrmDeal.companyId` (both `onDelete: SetNull`,
 * both writable through `dealPatchSchema`). Note the direction — the link
 * to a project lives on the DEAL, so that deleting the project leaves the
 * commercial record of the sale intact.
 */
export const LINK_EDGES: readonly LinkEdge[] = [
  // ── live on `stage` ──
  // `CrmDeal.projectId` and `CrmDeal.companyId` are both SetNull precisely so
  // losing the project or the account leaves the commercial record intact.
  { from: "deal", to: "project", kind: "delivers", status: "live", write: dealWrite("projectId") },
  { from: "deal", to: "customer", kind: "belongs_to", status: "live", write: dealWrite("companyId") },

  // ── real edges whose SUBSTRATE now exists, and whose write tool does not ──
  //
  // 🔴 All three of these said "not built yet" and had stopped being true.
  // `PmWorkItemRelation` landed with WARP-2586 (schema.prisma, plus
  // pm-relations.service.ts and routes/pm/relations.ts), and `PmWorkItem`
  // gained `departmentId` with WARP-2717. A table that reads "blocked on a
  // table that already exists" is worse than no note: it tells the next reader
  // the expensive half is missing when what is actually missing is the cheap
  // half, and that is the wrong estimate to act on.
  //
  // They stay `not_built` because `business_link` genuinely cannot write them
  // yet — the reason is now the WRITE, not the substrate, and the text says so.
  {
    from: "task",
    to: "task",
    kind: "blocks",
    status: "not_built",
    blockedBy: "PmWorkItemRelation exists (WARP-2586); business_link has no writer for it yet",
  },
  {
    from: "task",
    to: "task",
    kind: "relates_to",
    status: "not_built",
    blockedBy: "PmWorkItemRelation exists (WARP-2586); business_link has no writer for it yet",
  },
  {
    from: "task",
    to: "department",
    kind: "owned_by",
    status: "not_built",
    blockedBy:
      "the column exists (WARP-2717) and business_find can FILTER on it (WARP-2719); assigning one still needs a writer",
  },

  // ── real edges whose column or table EXISTS, and whose write route admits
  //    only a signed-in human — see the header ──
  {
    from: "project",
    to: "customer",
    kind: "for",
    status: "not_built",
    blockedBy:
      "the project route does not admit the assistant yet - PmProject.companyId exists, " +
      "but PATCH /api/pm/projects/:id is human-only",
  },
  {
    from: "file",
    to: "record",
    kind: "attached_to",
    status: "not_built",
    blockedBy:
      "the file-link route does not admit the assistant yet - the EntityLink table exists, " +
      "but /api/crm/entity-links resolves the file through the caller's own Nextcloud session",
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

/**
 * The same invariant the type enforces, checked at load for callers who reach
 * this table from JavaScript — the tools are consumed as compiled `dist`, and
 * `tsc` has no say over what a JS caller constructs.
 *
 * A throw at import is deliberate and is the cheap end of the trade: the
 * process refuses to start with a mis-declared edge, rather than serving one
 * wrong PATCH per call for as long as nobody notices.
 */
export const LIVE_EDGES_CARRY_A_WRITE = ((): true => {
  const bad = LINK_EDGES.filter((e) => e.status === "live" && !e.write);
  if (bad.length > 0) {
    throw new Error(
      `LINK_EDGES: live edge(s) with no write dispatch: ` +
        bad.map((e) => `${e.from}->${e.to} (${e.kind})`).join(", "),
    );
  }
  return true;
})();

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

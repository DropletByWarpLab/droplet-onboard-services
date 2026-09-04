/**
 * ADR-045 §5.3 (slice 8) — the department DIMENSION on PM rows.
 *
 * `Department` (ADR-029 / WARP-1255) is a Nextcloud groupfolder: `ncGroupRw`,
 * `ncGroupfolderId`, `quotaBytes`, `aclVersion`, `state ProvisionState`. Its
 * relations are memberships, shares, invite grants and a one-level
 * self-hierarchy — nothing that has ever pointed at a PM row. This module is
 * the rule set for the two nullable columns that change that:
 *
 *   PmProject.departmentId   — the department that owns the project
 *   PmWorkItem.departmentId  — overrides the project's when set
 *
 * Everything downstream — who is routed to, who is notified (slice I) — reads
 * `DepartmentMembership`, which is already built and already provisioned. This
 * file adds no second membership notion and no second org entity.
 *
 * ── the one rule this module exists to protect ───────────────────────
 *
 * PROVISIONING STATE MUST NOT GATE THE WORK HALF. A ticket routed to a
 * department whose `state` is `pending` or `provisioning`, or whose
 * `provisionError` is set (`state = failed`), is still assignable, still
 * visible, still listable. Storage convergence is not a precondition for a
 * ticket existing. The two meanings of the word "department" — who shares a
 * groupfolder, and who owns work — share a ROW and nothing else.
 *
 * That is breakable by accident in one character: `state !== "active"`. Written
 * that way the guard reads as prudence and silently makes every
 * not-yet-converged department unroutable — which is precisely the case the
 * person who creates a department and immediately files a ticket against it
 * hits, every time, on the first try. So the refusal set is named explicitly
 * and by INTENT: {@link ARCHIVE_INTENT_STATES}. `ProvisionState` already splits
 * that way on purpose (WARP-1257: `failed` is the PROVISION-intent failure,
 * `archive_failed` the ARCHIVE-intent one), so this reuses the schema's own
 * split rather than inventing a second one.
 *
 * ── three more couplings, closed structurally rather than by care ────
 *
 *  1. {@link DEPARTMENT_SELECT} omits `state`, `provisionError`,
 *     `nonConvergedSince`, `quotaBytes` and every `nc*` column. A PM consumer —
 *     route, dashboard, LLM tool — cannot gate on a provisioning field it was
 *     never handed. It also means no BigInt crosses the PM boundary
 *     (`quotaBytes` is the only one on `Department`), so nothing downstream has
 *     to think about apps/web-dashboard's pre-ES2020 target.
 *  2. A PM write never calls `kickReconcile()`. Reconciliation converges
 *     Nextcloud toward the department's desired storage state; assigning a
 *     ticket changes nothing Nextcloud has an opinion about.
 *  3. A PM write never bumps `aclVersion`. That counter keys the file-search
 *     cache (WARP-1259 / department-tx.ts) and every membership and state
 *     mutation must bump it in-transaction. Owning a ticket grants no file
 *     access whatsoever, so bumping it here would invalidate the whole search
 *     cache on every card drag for no reason.
 *
 * ── which KINDs may own work ─────────────────────────────────────────
 *
 * DEPARTMENT and TEAM. Not HOUSEHOLD: it is the seeded WS-5 system department
 * that everyone is already in, so "route it to Household" is indistinguishable
 * from routing nothing — and it would read on the board as a decision when it
 * is the absence of one. The refusal is explicit
 * (`department_not_assignable`), never a silent coercion to null.
 *
 * A TEAM owns work in its own right and assigning to one does NOT also assign
 * the parent: ownership is exactly one row, and a derived second owner is the
 * kind of implicit state this codebase keeps paying for. The parent shows up on
 * the READ side instead — see {@link expandDepartmentScope}: filtering by a
 * DEPARTMENT includes its TEAMs, because a department's board that hides the
 * work its own teams own is not a department's board. Filtering by a TEAM
 * matches only that team.
 */

import type {
  DepartmentKind,
  Prisma,
  PrismaClient,
  ProvisionState,
} from "@prisma/client";

/** A Prisma client OR an interactive-transaction handle — mirrors
 *  `pm.service.ts`'s `Db`, so an assignment guard can run inside the same
 *  `$transaction` as the write it guards when a caller needs that. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Stable error codes, thrown as `Error(code)` exactly like `PM_ERRORS` so the
 * route layer's existing `mapServiceError` switch stays the ONE place that
 * knows about HTTP status. Folded into `PM_ERRORS` by pm.service.ts so callers
 * have a single error vocabulary.
 */
export const PM_DEPARTMENT_ERRORS = {
  DEPARTMENT_NOT_FOUND: "department_not_found",
  DEPARTMENT_NOT_ASSIGNABLE: "department_not_assignable",
  DEPARTMENT_ARCHIVED: "department_archived",
} as const;

/**
 * The ARCHIVE-intent half of `ProvisionState` — the ONLY states that refuse a
 * NEW assignment.
 *
 * Read the complement out loud, because the complement is the point:
 * `pending`, `provisioning`, `active` and `failed` are ALL assignable. Three of
 * those four say "Nextcloud has not converged yet, or did not converge", which
 * is a fact about storage. A ticket is not storage.
 *
 * `archive_failed` is in the set with the other two because intent is what
 * matters, not outcome: someone asked for this department to go away and the
 * de-provisioning is what failed. Routing new work into it would be routing
 * work into something on its way out.
 *
 * If a future `ProvisionState` member is added, it belongs here only if it
 * means "someone asked for this department to go away".
 */
export const ARCHIVE_INTENT_STATES: ReadonlySet<ProvisionState> =
  new Set<ProvisionState>(["archiving", "archived", "archive_failed"]);

/**
 * The ONLY department columns PM is allowed to see.
 *
 * This is a deliberate structural guard, not a payload optimisation. Omitting
 * `state` / `provisionError` / `nonConvergedSince` means no PM route, no
 * dashboard component and no LLM tool can write the coupling this slice exists
 * to prevent — the field is not there to gate on. Omitting `quotaBytes`,
 * `ncGroupRw`, `ncGroupRo` and `ncGroupfolderId` keeps every storage-ACL
 * identifier on the storage side of the wall, and keeps the only BigInt on the
 * model out of a payload the pre-ES2020 dashboard build compiles against.
 *
 * `parentId` IS included: it is what lets a caller roll a TEAM up to its
 * DEPARTMENT without a second request, and it is org shape, not storage.
 */
export const DEPARTMENT_SELECT = {
  id: true,
  name: true,
  kind: true,
  parentId: true,
} satisfies Prisma.DepartmentSelect;

/** The row shape {@link DEPARTMENT_SELECT} produces. */
export interface DepartmentRefRow {
  id: string;
  name: string;
  kind: DepartmentKind;
  parentId: string | null;
}

/**
 * The department a PM row resolves to, as the API projects it.
 *
 * `source` is carried because the override rule is otherwise invisible: on a
 * board filtered to one department, an item that INHERITS its department and an
 * item that OVERRIDES to the same one look identical, and an item that
 * overrides to a DIFFERENT one simply vanishes from the filter with no
 * explanation. `source` is what lets the card say "this one was set here".
 */
export interface PmDepartmentRef extends DepartmentRefRow {
  source: "item" | "project";
}

/**
 * Apply the override rule: the row's own department wins, the project's is the
 * fallback, and neither is a legal answer.
 *
 * Accepts `undefined` as well as `null` on both sides on purpose. The DB-less
 * unit lane mocks Prisma with a hand-written fake (`routes/pm/native.test.ts`)
 * that does not resolve includes it was never taught, so an un-included
 * relation arrives as `undefined` rather than `null`. Treating the two the same
 * keeps that suite green without teaching every fake about a relation it does
 * not test.
 */
export function resolveDepartmentRef(
  own: DepartmentRefRow | null | undefined,
  inherited: DepartmentRefRow | null | undefined,
): PmDepartmentRef | null {
  if (own) return { ...own, source: "item" };
  if (inherited) return { ...inherited, source: "project" };
  return null;
}

/**
 * Refuse an assignment that must not be made, or return quietly.
 *
 * Throws `department_not_found` (→404), `department_not_assignable` (→422,
 * HOUSEHOLD) or `department_archived` (→409, archive intent). Never throws for
 * `pending` / `provisioning` / `failed` — see this file's header.
 *
 * CLEARING is never guarded: callers must be able to set `departmentId = null`
 * on a row whose department has since been archived, or the un-routing path
 * would be blocked by the very state that makes un-routing the right move. So
 * this is only ever called with a non-null id.
 */
export async function assertAssignableDepartment(
  db: Db,
  departmentId: string,
): Promise<void> {
  const dept = await db.department.findUnique({
    where: { id: departmentId },
    select: { id: true, kind: true, state: true },
  });
  if (!dept) throw new Error(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_FOUND);
  if (dept.kind === "HOUSEHOLD") {
    throw new Error(PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_ASSIGNABLE);
  }
  if (ARCHIVE_INTENT_STATES.has(dept.state)) {
    throw new Error(PM_DEPARTMENT_ERRORS.DEPARTMENT_ARCHIVED);
  }
}

/**
 * Expand a filter target into the set of department ids it matches: the target
 * itself plus, when it is a DEPARTMENT, its child TEAMs.
 *
 * No `kind` branch is needed. `validateDepartmentHierarchy` (WARP-1255, the
 * 2026-07-11 amendment) permits exactly one level of nesting — a TEAM's parent
 * must be a DEPARTMENT and a TEAM can never be a parent — so the `parentId`
 * arm of this query returns rows only when the target is a DEPARTMENT, and
 * returns them all in one hop. Adding a kind check would be a second encoding
 * of the same rule, free to drift from it.
 *
 * An unknown id yields `[departmentId]` rather than `[]` so the caller's filter
 * matches nothing, instead of degrading into "no filter" and silently showing
 * the whole board.
 */
export async function expandDepartmentScope(
  db: Db,
  departmentId: string,
): Promise<string[]> {
  const rows = await db.department.findMany({
    where: { OR: [{ id: departmentId }, { parentId: departmentId }] },
    select: { id: true },
  });
  return rows.length > 0 ? rows.map((r) => r.id) : [departmentId];
}

/**
 * The work-item predicate for a department filter, honouring the override rule
 * on the DB side so `?department=` and the board agree.
 *
 * `null` scope means "owned by nobody" — the item has none AND its project has
 * none. Anything else is "the item's own is in the set, OR the item has none
 * and the project's is in the set". The second arm is what makes tagging a
 * project once actually filter its items.
 *
 * ⚠ Returned as a fragment for the caller to put in `where.AND`, never assigned
 * to `where.OR` directly: `listWorkItems` already uses `where.OR` for the `?q=`
 * free-text filter, and writing this one there would silently replace it —
 * turning "items in Clinical matching 'sterilise'" into "items in Clinical".
 */
export function departmentWorkItemWhere(
  scope: readonly string[] | null,
): Prisma.PmWorkItemWhereInput {
  if (scope === null) {
    return { departmentId: null, project: { is: { departmentId: null } } };
  }
  const ids = [...scope];
  return {
    OR: [
      { departmentId: { in: ids } },
      { departmentId: null, project: { is: { departmentId: { in: ids } } } },
    ],
  };
}

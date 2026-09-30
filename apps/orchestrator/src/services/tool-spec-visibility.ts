/**
 * WARP-3354 — who may see, run and share a routine.
 *
 * Romain's rule (2026-09-30): a routine is PRIVATE to its creator unless it
 * is shared with the Workspace; owners and admins see every routine. Same
 * model as chat projects, except that owner/admin are not locked out.
 *
 *   visibility WORKSPACE  every member sees it and runs it under today's run rules
 *   visibility PRIVATE    its creator (`ownerId`), owners and admins
 *
 * The rule lives HERE, once. Every read and every run of a routine goes
 * through `canSeeToolSpec` / `visibleToolSpecWhere`, for a browser session and
 * for the assistant's `routine_*` tools alike — those reach the same routes
 * as the person they act for, so there is no second copy of the rule to drift.
 *
 * Fail-closed: only the literal `WORKSPACE` opens a routine to everybody. A
 * missing or unknown value is treated as private.
 *
 * Not covered, on purpose: a SCHEDULED run fires as the routine's creator
 * (tool-schedule-ticker.service.ts) and never reads this rule. Un-sharing a
 * routine does not cancel its schedule; it stays the creator's automation.
 */

export const TOOL_SPEC_VISIBILITIES = ["PRIVATE", "WORKSPACE"] as const;
export type ToolSpecVisibility = (typeof TOOL_SPEC_VISIBILITIES)[number];

/** The person a request acts for — `User.id` and wire role (see `resolveActor`). */
export interface VisibilityActor {
  id: string;
  role: string;
}

export interface VisibilitySpec {
  ownerId: string | null;
  visibility: string;
}

/** Roles that see and manage every routine, whoever created it. */
const SEES_EVERY_ROUTINE: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Owner and admin: they see every routine, so nothing is hidden from them. */
export function seesEveryToolSpec(actor: { role: string }): boolean {
  return SEES_EVERY_ROUTINE.has(actor.role);
}

/**
 * May this person share, un-share, edit or run this routine regardless of its
 * visibility: its creator, an owner or an admin. A routine with no creator
 * (box-provided, or mined suggestion) has no creator to match, so only an
 * owner or admin manages it.
 */
export function canManageToolSpec(actor: VisibilityActor, spec: VisibilitySpec): boolean {
  if (SEES_EVERY_ROUTINE.has(actor.role)) return true;
  return spec.ownerId !== null && spec.ownerId === actor.id;
}

export function canSeeToolSpec(actor: VisibilityActor, spec: VisibilitySpec): boolean {
  return spec.visibility === "WORKSPACE" || canManageToolSpec(actor, spec);
}

/**
 * The `where` fragment for a list query: everything for owner/admin, else the
 * shared routines plus the ones this person created. Spread into the caller's
 * own filter (status, category).
 */
export function visibleToolSpecWhere(
  actor: VisibilityActor,
): { OR: Array<{ visibility: ToolSpecVisibility } | { ownerId: string }> } | null {
  if (SEES_EVERY_ROUTINE.has(actor.role)) return null;
  return { OR: [{ visibility: "WORKSPACE" }, { ownerId: actor.id }] };
}

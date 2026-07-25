/**
 * WARP-1526 (RBAC v2 T2, ADR-032 draft §4) — the role-mutation guard.
 *
 * ONE service, consolidating the person-mutation rails that used to live
 * inline (and divergently) in routes/people.ts and routes/auth.ts. Every
 * path that changes / disables / removes a person on EITHER user surface
 * (/api/people/*, /api/auth/users*) runs these rails through this module,
 * so the two surfaces can never drift apart again (the WARP-1523 lesson).
 *
 * Rails, in contract order:
 *
 *   pre-transaction (pure, no DB):
 *     2. Self-action     — 409 SELF_ACTION_NOT_ALLOWED (WARP-480). Runs FIRST,
 *        matching the shipped people-surface placement (before body parse).
 *     1. Owner untouchable — 403 OWNER_IMMUTABLE (new). Any mutation targeting
 *        a User.role="owner" row is refused: role change, disable, remove,
 *        usage-policy write, scope rewrite. Design copy verbatim.
 *     3. Rank cap        — 403 ROLE_RANK_EXCEEDED (WARP-623 / WARP-1042 /
 *        WARP-1523). ROLE_RANK[requested] <= ROLE_RANK[actor]; fail closed on
 *        a missing actor role claim. Runs BEFORE the assignable-enum rail so
 *        the WARP-1523 pins (admin→owner ⇒ ROLE_RANK_EXCEEDED) keep their code.
 *     7. Assignable enum — 403 ROLE_NOT_ASSIGNABLE (new, WARP-1526 ticket
 *        comments). The human-assignable role set is exactly
 *        {admin, family, guest}: per the Access & Roles design brief §6.2 the
 *        role select is "never Owner or Service" — `service` is the env-var-
 *        only non-human principal (rank −1, see jwt.service ROLE_RANK doc),
 *        and `owner` is not assignable because there is exactly ONE owner by
 *        design; ownership transfer is a future dedicated flow, not a role
 *        assignment. This consciously supersedes the #1221-era owner→owner-
 *        allowed pins, which existed purely to document the rank-cap rail.
 *
 *   in-transaction (serializable — the people.ts LAST_OWNER_INVARIANT
 *   pattern; Prisma's $transaction default on Postgres):
 *     4. Last-owner      — 409 LAST_OWNER_INVARIANT (WARP-480). At least one
 *        role="owner" row must remain. With rail 1 in place this is
 *        unreachable from the routes (every owner-targeting mutation is
 *        refused earlier) — kept as a cheap, honest in-tx backstop against
 *        drifted data or a future path that forgets rail 1.
 *     5. Last-operator   — 409 LAST_OPERATOR_INVARIANT (new). A demote /
 *        disable / remove may not leave zero non-disabled owner∪admin
 *        ("the final owner-or-admin", design brief §8). "Non-disabled" is
 *        the explicit User.directoryStatus enum — never guessed from NULLs.
 *        Near-tautological while an ACTIVE owner exists (rail 1 makes the
 *        owner unremovable), but real protection for drifted directories
 *        with no (or a deactivated) owner row.
 *
 *   post-commit (rail 6 — consolidated effect runners):
 *     revokeAllSessions(target) so the change propagates at the next request
 *     (WARP-247), the Activity write (house style: enum `kind` + free-text
 *     `what`), the WARP-490 access-token denylist on removal, and the
 *     WARP-1259 Nextcloud `droplet-admins` cascade on tier crossings
 *     (best-effort + logged; the department-reconciler's admin-group sweep
 *     converges residual drift from User.role — Prisma is truth).
 *
 * Refusals THROW RoleMutationRefusedError; routes map it with
 * `res.status(err.status).json(err.toJSON())`. Refused mutations never emit
 * Activity rows (the audit log records state changes, not noise).
 */
import type { Role } from "./jwt.service.js";
import { ACCESS_TOKEN_TTL_SECONDS, ROLE_RANK } from "./jwt.service.js";
import { revokeAllSessions } from "./session.service.js";
import { denylistUser } from "./auth-denylist.service.js";
import { recordActivity } from "./activity.singleton.js";
import type { ActivityActor } from "./activity.service.js";
import {
  adminBasicToken,
  DROPLET_ADMINS_GROUP,
} from "./department-provisioner.service.js";
import {
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
} from "./nextcloud-groups.client.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("role-mutation-guard");

/**
 * The human-assignable role vocabulary — design brief §6.2: the role select
 * offers Admin / Family / Guest, "never Owner or Service". Everything else
 * in the Role union is refused by rail 7 (assertRoleAssignable).
 */
export const ASSIGNABLE_ROLES = ["admin", "family", "guest"] as const satisfies readonly Role[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * The operator tier — who can manage access. Also exactly the tier the
 * box-wide Nextcloud `droplet-admins` group tracks (WARP-1259 / ADR-029
 * §3.5). Single definition here; people.ts imports it instead of keeping
 * its own copy.
 */
export const ADMIN_TIER_ROLES = ["owner", "admin"] as const satisfies readonly Role[];

const ADMIN_TIER = new Set<Role>(ADMIN_TIER_ROLES);
const ASSIGNABLE = new Set<Role>(ASSIGNABLE_ROLES);

/** Machine-readable refusal codes, one per rail. */
export type RoleMutationRefusalCode =
  | "OWNER_IMMUTABLE"
  | "SELF_ACTION_NOT_ALLOWED"
  | "ROLE_RANK_EXCEEDED"
  | "ROLE_NOT_ASSIGNABLE"
  | "LAST_OWNER_INVARIANT"
  | "LAST_OPERATOR_INVARIANT";

/**
 * Typed refusal. `status` is the HTTP status the route maps; `toJSON()` is
 * the exact response body shape both surfaces already use
 * (`{ error, code }`). 409 for state-conflict rails (the request is
 * well-formed and the caller IS authorized; the resource state forbids it),
 * 403 for authority rails — matching the shipped WARP-480 / WARP-1523
 * semantics.
 */
export class RoleMutationRefusedError extends Error {
  readonly status: number;
  readonly code: RoleMutationRefusalCode;

  constructor(status: number, code: RoleMutationRefusalCode, message: string) {
    super(message);
    this.name = "RoleMutationRefusedError";
    this.status = status;
    this.code = code;
  }

  toJSON(): { error: string; code: RoleMutationRefusalCode } {
    return { error: this.message, code: this.code };
  }

  /** Rail 1 — design brief §12 copy, verbatim. */
  static ownerImmutable(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      403,
      "OWNER_IMMUTABLE",
      "The owner has full control and can't be changed here.",
    );
  }

  /** Rail 2 — shipped WARP-480 copy, byte-identical to people.ts. */
  static selfAction(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      409,
      "SELF_ACTION_NOT_ALLOWED",
      "Cannot modify your own role, scope, or account",
    );
  }

  /** Rail 3 — message stays per-site (create/invite/update keep their shipped copy). */
  static rankExceeded(message: string): RoleMutationRefusedError {
    return new RoleMutationRefusedError(403, "ROLE_RANK_EXCEEDED", message);
  }

  /** Rail 7 — never Owner or Service (design brief §6.2). */
  static roleNotAssignable(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      403,
      "ROLE_NOT_ASSIGNABLE",
      "This role can't be assigned to a person.",
    );
  }

  /** Rail 4 — shipped WARP-480 copy, byte-identical to people.ts. */
  static lastOwner(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      409,
      "LAST_OWNER_INVARIANT",
      "Cannot remove the only owner. Promote another user to owner first.",
    );
  }

  /** Rail 5 — design brief §12 copy, verbatim (em dash and all). */
  static lastOperator(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      409,
      "LAST_OPERATOR_INVARIANT",
      "This is the last person who can manage access — give someone else an admin role first.",
    );
  }
}

/** The actor fields the rails need, straight off `req.user`. */
export interface GuardActor {
  id?: string | null;
  role?: Role | null;
}

/** The target row fields the pre-tx rails need. */
export interface GuardTarget {
  id: string;
  role: Role;
}

/**
 * Mirrors Prisma's DirectoryUserStatus enum (schema.prisma) as TS literals so
 * this file compiles standalone without pulling the Prisma client into the
 * guard hot path — the same discipline people.ts applies to ROLE_VALUES.
 * Drift would be caught by the route suites (they pass real row values).
 */
export type GuardDirectoryStatus = "ACTIVE" | "DEACTIVATED";

/**
 * Minimal structural tx handle — the invariants only ever COUNT users, so
 * they accept any client that can (the interactive $transaction handle in
 * production, an in-memory stub in tests).
 */
export interface GuardTx {
  user: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

// ── individual rails ────────────────────────────────────────────

/**
 * Rail 2 — self-action. A missing actor id never self-matches (presence is
 * the auth middleware's job; this rail only compares identities), exactly
 * like the shipped `req.params.id === req.user?.id` check.
 */
export function assertNotSelf(
  actorId: string | null | undefined,
  targetId: string,
): void {
  if (actorId != null && actorId === targetId) {
    throw RoleMutationRefusedError.selfAction();
  }
}

/** Rail 1 — owner untouchable, regardless of actor. */
export function assertTargetNotOwner(targetRole: Role): void {
  if (targetRole === "owner") {
    throw RoleMutationRefusedError.ownerImmutable();
  }
}

/**
 * Rail 3 — rank cap: ROLE_RANK[requested] <= ROLE_RANK[actor] (equal rank is
 * allowed — admin→admin last-admin recovery, WARP-1523 semantics). Fails
 * CLOSED when the actor's role claim is absent.
 */
export function assertRankCap(
  actorRole: Role | null | undefined,
  requestedRole: Role,
  message: string,
): void {
  if (!actorRole || ROLE_RANK[requestedRole] > ROLE_RANK[actorRole]) {
    throw RoleMutationRefusedError.rankExceeded(message);
  }
}

/** Rail 7 — the assignable-enum narrowing (never Owner or Service, §6.2). */
export function assertRoleAssignable(requestedRole: Role): void {
  if (!ASSIGNABLE.has(requestedRole)) {
    throw RoleMutationRefusedError.roleNotAssignable();
  }
}

// ── pre-transaction composites (rail order is contract) ────────

const DEFAULT_RANK_MESSAGE = "You cannot assign a role higher than your own";

/** Role change (PATCH /people/:id/role; PUT /auth/users/:username role branch). */
export function assertRoleChangeAllowed(args: {
  actor: GuardActor;
  target: GuardTarget;
  requestedRole: Role;
  rankMessage?: string;
}): void {
  assertNotSelf(args.actor.id, args.target.id);
  assertTargetNotOwner(args.target.role);
  assertRankCap(
    args.actor.role,
    args.requestedRole,
    args.rankMessage ?? DEFAULT_RANK_MESSAGE,
  );
  assertRoleAssignable(args.requestedRole);
}

/** Removal (DELETE /people/:id; DELETE /auth/users/:username). */
export function assertRemovalAllowed(args: {
  actor: GuardActor;
  target: GuardTarget;
}): void {
  assertNotSelf(args.actor.id, args.target.id);
  assertTargetNotOwner(args.target.role);
}

/** Disable (POST /auth/users/:username/disable). */
export function assertDisableAllowed(args: {
  actor: GuardActor;
  target: GuardTarget;
}): void {
  assertNotSelf(args.actor.id, args.target.id);
  assertTargetNotOwner(args.target.role);
}

/**
 * Scope rewrite (PATCH /people/:id/scope) — same two rails as removal:
 * the shipped self-action guard plus rail 1 (an owner's bindings are inert
 * — requireScope short-circuits owners — but they are still the owner's
 * row; "any mutation targeting an owner" includes it).
 */
export function assertScopeChangeAllowed(args: {
  actor: GuardActor;
  target: GuardTarget;
}): void {
  assertNotSelf(args.actor.id, args.target.id);
  assertTargetNotOwner(args.target.role);
}

/**
 * Usage-policy write (PUT /people/:id/usage) — rail 1 only. Self-edits stay
 * allowed on purpose: an owner/admin capping their OWN storage can't lock
 * anyone out of the box (shipped WARP-1271 comment), so rail 2 does not
 * apply here.
 */
export function assertUsageWriteAllowed(args: { target: GuardTarget }): void {
  assertTargetNotOwner(args.target.role);
}

/**
 * Create/invite sites (POST /auth/users, POST /auth/invites,
 * POST /people/invite) — no target row exists yet, so only rails 3 + 7:
 * rank first (preserves the shipped per-site ROLE_RANK_EXCEEDED pins for
 * admin actors), then the assignable narrowing (which now also stops an
 * OWNER actor from minting a second owner — exactly-one-owner doctrine).
 */
export function assertAssignableForCreate(args: {
  actorRole: Role | null | undefined;
  requestedRole: Role;
  rankMessage: string;
}): void {
  assertRankCap(args.actorRole, args.requestedRole, args.rankMessage);
  assertRoleAssignable(args.requestedRole);
}

// ── in-transaction invariants (rails 4 + 5) ─────────────────────

/**
 * Rail 4 — last-owner backstop. The count uses the byte-identical
 * `{ role: "owner" }` where-shape the WARP-480 inline check used, so the
 * existing route-suite prisma mocks keep working unchanged.
 */
async function assertNotLastOwner(tx: GuardTx, losesAnOwner: boolean): Promise<void> {
  if (!losesAnOwner) return;
  const owners = await tx.user.count({ where: { role: "owner" } });
  if (owners <= 1) {
    throw RoleMutationRefusedError.lastOwner();
  }
}

/**
 * Rail 5 — last-operator. Counts the OTHER non-disabled operators
 * (role ∈ owner∪admin, directoryStatus="ACTIVE", excluding the target);
 * zero remaining means the target is "the final owner-or-admin" and the
 * mutation is refused. Explicit enum column, never IS-NULL-derived.
 */
async function assertNotLastOperator(tx: GuardTx, targetId: string): Promise<void> {
  const remaining = await tx.user.count({
    where: {
      role: { in: [...ADMIN_TIER_ROLES] },
      directoryStatus: "ACTIVE",
      id: { not: targetId },
    },
  });
  if (remaining === 0) {
    throw RoleMutationRefusedError.lastOperator();
  }
}

/** Role change: rails 4 → 5, only when the change actually crosses down. */
export async function assertRoleChangeInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTarget; requestedRole: Role },
): Promise<void> {
  await assertNotLastOwner(
    tx,
    args.target.role === "owner" && args.requestedRole !== "owner",
  );
  if (ADMIN_TIER.has(args.target.role) && !ADMIN_TIER.has(args.requestedRole)) {
    await assertNotLastOperator(tx, args.target.id);
  }
}

/** Removal: rails 4 → 5 for any operator-tier target. */
export async function assertRemovalInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTarget },
): Promise<void> {
  await assertNotLastOwner(tx, args.target.role === "owner");
  if (ADMIN_TIER.has(args.target.role)) {
    await assertNotLastOperator(tx, args.target.id);
  }
}

/**
 * Disable: rail 5 only (disable never changes the role column, so the
 * owner-count invariant is untouched). Re-disabling an already-DEACTIVATED
 * row is an idempotent pass — it removes no operator capacity.
 */
export async function assertDisableInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTarget & { directoryStatus: GuardDirectoryStatus } },
): Promise<void> {
  if (args.target.directoryStatus === "DEACTIVATED") return;
  if (ADMIN_TIER.has(args.target.role)) {
    await assertNotLastOperator(tx, args.target.id);
  }
}

// ── rail 6 — consolidated post-commit effect runners ───────────

/**
 * WARP-1259 tier-crossing cascade: keep the box-wide `droplet-admins` NC
 * group tracking the operator tier. Best-effort and non-blocking — an NC
 * outage must never fail the mutation that already committed; the
 * department-reconciler's admin-group sweep (WARP-1526 rail 6) converges
 * residual drift from User.role on its next tick, Prisma being truth.
 */
async function syncAdminTierGroup(args: {
  userId: string;
  nextcloudUsername: string | null;
  previousRole: Role;
  nextRole: Role;
}): Promise<void> {
  const wasAdminTier = ADMIN_TIER.has(args.previousRole);
  const isAdminTierNow = ADMIN_TIER.has(args.nextRole);
  if (wasAdminTier === isAdminTierNow || !args.nextcloudUsername) return;
  const ncUsername = args.nextcloudUsername;
  try {
    const adminToken = adminBasicToken();
    if (isAdminTierNow) {
      await ncAddUserToGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
    } else {
      await ncRemoveUserFromGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
    }
  } catch (err) {
    logger.error(
      { err, userId: args.userId, ncUsername, isAdminTierNow },
      "role change: droplet-admins NC group sync failed (non-blocking; reconciler sweep converges)",
    );
  }
}

/**
 * Post-effects of a committed role change (WARP-247 revoke → WARP-1259 NC
 * cascade → Activity). Emit shape is byte-identical to the shipped
 * people.ts block (kind "system" — permission edits; lifecycle events use
 * "auth").
 */
export async function runRoleChangePostEffects(args: {
  target: { id: string; username: string; nextcloudUsername: string | null };
  previousRole: Role;
  nextRole: Role;
  actorUsername: string | null;
  actor: ActivityActor;
}): Promise<void> {
  await revokeAllSessions(args.target.id);
  await syncAdminTierGroup({
    userId: args.target.id,
    nextcloudUsername: args.target.nextcloudUsername,
    previousRole: args.previousRole,
    nextRole: args.nextRole,
  });
  await recordActivity({
    kind: "system",
    severity: "ok",
    sourceIcon: "shield",
    what: "Role changed",
    sub: `${args.target.username}: ${args.previousRole} → ${args.nextRole}`,
    refs: {
      actor: args.actorUsername,
      targetUserId: args.target.id,
      targetUsername: args.target.username,
      previousRole: args.previousRole,
      nextRole: args.nextRole,
    },
    actor: args.actor,
  });
}

/**
 * Post-effects of a committed removal (WARP-490 hard revocation + audit).
 * `targetUserId: null` is the legacy NC-only path (no local row): nothing
 * to revoke or denylist, but the mandatory-emit audit row still lands —
 * previously DELETE /auth/users/:username emitted nothing at all.
 */
export async function runRemovalPostEffects(args: {
  targetUserId: string | null;
  targetUsername: string;
  targetRole: Role | null;
  actorUsername: string | null;
  actor: ActivityActor;
}): Promise<void> {
  if (args.targetUserId) {
    await revokeAllSessions(args.targetUserId);
    await denylistUser(args.targetUserId, ACCESS_TOKEN_TTL_SECONDS);
  }
  await recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "user-x",
    what: "User removed",
    sub: args.targetUsername,
    refs: {
      actor: args.actorUsername,
      targetUserId: args.targetUserId,
      targetUsername: args.targetUsername,
      role: args.targetRole,
    },
    actor: args.actor,
  });
}

/**
 * Post-effects of a committed disable (WARP-116 immediate revocation +
 * the WARP-1062 mandatory-emit row, shape unchanged from auth.ts).
 */
export async function runDisablePostEffects(args: {
  targetUserId: string | null;
  username: string;
  actor: ActivityActor;
}): Promise<void> {
  const sessionsRevoked = args.targetUserId
    ? await revokeAllSessions(args.targetUserId)
    : 0;
  await recordActivity({
    kind: "auth",
    severity: "warn",
    sourceIcon: "shield-off",
    what: "User disabled",
    sub: args.username,
    refs: {
      username: args.username,
      targetUserId: args.targetUserId,
      sessionsRevoked,
    },
    actor: args.actor,
  });
}

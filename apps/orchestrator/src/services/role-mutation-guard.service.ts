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
 *     1b. Owner untouchable BY ANOTHER ACTOR — 403 OWNER_IMMUTABLE
 *        (WARP-1564). Rail 1 with a self carve-out, for the one surface that
 *        rewrites CREDENTIALS (PUT /auth/users/:username: password, email,
 *        displayName, quota). Blanket rail 1 there would refuse the owner's
 *        own account maintenance, which is why the residual vector survived
 *        the T2 sweep: the role-relevant branch was railed, the credential
 *        branch was not, and an admin could rotate the owner's password
 *        (local hash + Nextcloud mirror) and sign in as them. Same code and
 *        copy as rail 1 — the owner's row looks identical to every actor who
 *        is not the owner. Fails CLOSED on a missing actor id (it uses
 *        identity to PERMIT, unlike rail 2 which uses it to REFUSE).
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
 *   in-transaction (SERIALIZABLE — opened with the exported
 *   `SERIALIZABLE_TX` options at every call site. NOT a default: Prisma's
 *   interactive `$transaction` inherits the Postgres default, READ
 *   COMMITTED, which admits the write skew these rails exist to stop. The
 *   pre-#1229 version of this comment claimed otherwise and was wrong.
 *   Callers additionally re-read the target INSIDE the transaction
 *   (`readGuardTargetTx`) and pin `role` in the write's `where`, so neither
 *   the decision nor the write can be made against stale state):
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
import type { Prisma } from "@prisma/client";
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

/** Machine-readable refusal codes, one per rail (+ the concurrency answer). */
export type RoleMutationRefusalCode =
  | "OWNER_IMMUTABLE"
  | "SELF_ACTION_NOT_ALLOWED"
  | "ROLE_RANK_EXCEEDED"
  | "ROLE_NOT_ASSIGNABLE"
  | "LAST_OWNER_INVARIANT"
  | "LAST_OPERATOR_INVARIANT"
  | "CONCURRENT_MUTATION";

/**
 * The `$transaction` options EVERY guarded mutation must be opened with
 * (pr-reviewer #1229 B1) — one exported constant so no call site can drift
 * back to the default.
 *
 * Prisma's interactive `$transaction` does NOT default to Serializable: it
 * inherits the database default, which on Postgres is READ COMMITTED. Rails
 * 4 and 5 are check-then-write (COUNT the surviving owner∪admin rows, then
 * demote / disable / delete in the same transaction), so under RC two
 * concurrent requests each removing one of the last two operators BOTH read
 * "one other operator remains", BOTH pass, and BOTH commit — landing exactly
 * the zero-operator state the rails exist to prevent, unrecoverable from the
 * dashboard. Under SERIALIZABLE the loser aborts (P2034) instead, which the
 * routes map to CONCURRENT_MUTATION rather than a 500.
 *
 * Same finding class and same remedy as reset.service.ts (pr-reviewer #549
 * finding 1).
 *
 * WARP-1583 moved the DEFINITION to `lib/prisma-tx.ts`, next to
 * `REPEATABLE_READ_TX`, so the two isolation levels this app uses are
 * chosen from one place rather than discovered separately. Re-exported here
 * because this module is where the contract that requires it is documented,
 * and where every call site already imports it from.
 */
export { SERIALIZABLE_TX } from "../lib/prisma-tx.js";

/**
 * Prisma error codes that mean "another writer touched this row while we
 * were deciding" (pr-reviewer #1229 B1/B2):
 *
 *   P2034 — transaction write conflict / serialization failure: the loser
 *           of a SERIALIZABLE conflict. Adding the isolation level without
 *           mapping this would turn a safe concurrent mutation into a 500.
 *   P2025 — record required but not found: our optimistic-concurrency
 *           `where: { id, role }` guard missed because the row changed (or
 *           vanished) between the in-transaction re-read and the write.
 *
 * Both are the same story to the caller: nothing was applied, retry. They
 * are NOT mapped to a specific rail's code — we genuinely cannot know which
 * invariant the concurrent writer would have tripped, and claiming one would
 * be a lie in the audit trail.
 */
export function isConcurrencyConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "P2034" || code === "P2025";
}

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

  /**
   * Not a rail — the answer when a guarded mutation loses a race
   * (SERIALIZABLE conflict, or an optimistic-write miss). 409 matches the
   * other state-conflict refusals: the request was well-formed and the
   * caller was authorized; the resource moved underneath it. Nothing was
   * applied, so retrying is safe and is what the copy asks for.
   */
  static concurrentMutation(): RoleMutationRefusedError {
    return new RoleMutationRefusedError(
      409,
      "CONCURRENT_MUTATION",
      "Someone else changed this person at the same time. Try again.",
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
 * The target as the IN-TRANSACTION invariants require it: the tier AND the
 * current enable state, both re-read inside the transaction.
 *
 * Deliberately distinct from `GuardTarget` (pr-reviewer #1229 N2). Rail 5
 * counts NON-DISABLED operators, so it must know whether the target itself
 * is one — otherwise a DEACTIVATED sole admin becomes unremovable AND
 * undemotable, a stuck row with no route-level exit. Making the field
 * REQUIRED here (rather than optional on the shared type) is what stops a
 * call site from silently omitting it; the PRE-tx composites keep the
 * two-field `GuardTarget` unchanged, because the T3–T6 stack builds on that
 * seam.
 */
export interface GuardTxTarget extends GuardTarget {
  directoryStatus: GuardDirectoryStatus;
}

/**
 * The transaction handle the in-transaction invariants take.
 *
 * `Prisma.TransactionClient` — NOT a hand-rolled structural type
 * (pr-reviewer #1229 N5). A minimal `{ user: { count } }` interface is
 * satisfied by the full `PrismaClient` too, so
 * `assertRemovalInvariantsTx(prisma, …)` type-checked and ran the invariant
 * OUTSIDE any transaction — precisely the B1/B3 mistake this seam should
 * make unrepresentable. `TransactionClient` is structurally the client
 * MINUS `$transaction`/`$connect`/…, so passing the top-level client is now
 * a compile error.
 */
export type GuardTx = Prisma.TransactionClient;

/**
 * Re-read the target INSIDE the transaction (pr-reviewer #1229 B2).
 *
 * The pre-tx rails necessarily decide on a snapshot read before the
 * transaction opens. The in-tx rails must NOT: whether rail 5 runs at all
 * is derived from the target's tier, so a stale `role` lets a concurrent
 * promotion slip a demotion past a check that was never evaluated (target
 * read as `family` → rail skipped → promoted to `admin` by another writer →
 * this transaction demotes the now-sole admin). Callers pass THIS row to
 * the invariants, and guard their write with `where: { id, role }` so the
 * window between this read and the write is closed too.
 *
 * Projected to the three columns the rails use — WARP-1539's "never pull
 * passwordHash into memory" rule applies to internal reads as much as to
 * serialized ones.
 */
export async function readGuardTargetTx(
  tx: GuardTx,
  targetId: string,
): Promise<GuardTxTarget | null> {
  const row = await tx.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true, directoryStatus: true },
  });
  return row as GuardTxTarget | null;
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
 * Rail 1b (WARP-1564) — owner untouchable BY SOMEONE ELSE. Rail 1 with a
 * self carve-out, for the identity/credential-edit surface.
 *
 * Rail 1 proper is actor-blind, which is exactly right for role / disable /
 * remove / scope: nobody, including the owner, performs those on the owner's
 * row through these routes. It is too broad for PUT /auth/users/:username,
 * which is also how the OWNER edits their own display name, email and
 * password — a blanket rail 1 there would lock the owner out of their own
 * account maintenance. That is precisely why the residual vector could not be
 * closed inline with the shipped rail.
 *
 * Refuses with the SAME 403 OWNER_IMMUTABLE code and copy as rail 1: to every
 * caller who is not the owner, the owner's row behaves identically on every
 * surface. There is no new refusal vocabulary to learn, and no way to tell
 * "owner row, wrong actor" apart from "owner row" — the response is the same.
 *
 * FAIL-CLOSED on a missing actor id, which is the INVERSE of rail 2's
 * fail-open and the subtle part of this rail:
 *   • rail 2 uses identity to REFUSE, so an absent id must not self-match —
 *     it fails open (presence is the auth middleware's job).
 *   • rail 1b uses identity to PERMIT, so an absent id cannot prove "I am the
 *     owner" — it must fail closed, or a route that lost its actor claim
 *     would hand out the owner's credentials.
 * The empty string is treated as absent for the same reason: it is not a
 * User.id any row can hold, so it can only arrive from a broken claim.
 */
export function assertTargetNotOtherOwner(
  actorId: string | null | undefined,
  target: GuardTarget,
): void {
  if (target.role !== "owner") return;
  if (!actorId || actorId !== target.id) {
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
 * Identity / credential edit (PUT /auth/users/:username) — rail 1b only.
 * WARP-1564.
 *
 * This is the one surface in the product that can rewrite a person's
 * CREDENTIALS: the local argon2id `passwordHash` that /auth/login verifies,
 * and the Nextcloud mirror behind it. Before this rail the route ran the
 * guard only on its role-relevant branch, so every owner-takeover door was
 * shut except the decisive one — an admin could POST the owner's username a
 * new password and then sign in as the owner.
 *
 * DELIBERATELY NOT FIELD-SCOPED. The obvious alternative is an allowlist —
 * rail only `password` and `email` — and it is the wrong shape twice over:
 *
 *   • Every field the route accepts already belongs to the owner alone.
 *     `password` is the credential. `email` IS the login key (/auth/login
 *     resolves the row by email blind-index, then verifies that row's hash),
 *     so rewriting it re-keys who can sign into the owner's account and locks
 *     the real owner out. `quota` is the same mutation class that
 *     `assertUsageWriteAllowed` already refuses on owner rows via
 *     PUT /api/people/:id/usage — leaving it open here would re-create the
 *     two-surface drift this whole service exists to prevent (WARP-1523).
 *     `displayName` is the owner's attributed identity across the dashboard,
 *     the activity log and Nextcloud.
 *   • An allowlist defaults any field ADDED to updateUserSchema later to
 *     UN-railed. That is "derive state from absence" in guard form: the
 *     safety of the owner's row would silently depend on a future author
 *     remembering to extend a list somewhere else. Rail-the-route-unless-self
 *     is fail-closed by construction — a new field inherits the rail.
 *
 * SCOPE, stated precisely: the rail decides from the target ROW, so it covers
 * every request that resolves one. A username with no local row cannot BE the
 * owner (role lives only on that row), so there is nothing to protect there —
 * but see the call site for the one residual it leaves (a displayName/quota-
 * only body against a rowless username still reaches Nextcloud).
 *
 * The caller must ALSO pin `role` in the write's `where` — this rail decides
 * on a non-transactional read, and pinning is what makes a promotion that
 * lands in that window a 0-row no-op rather than a credential write on a
 * stale decision. See the header's in-transaction contract; the call site
 * documents the concrete concurrent writer (SCIM group→role mapping).
 *
 * Rail 2 (self-action) is deliberately NOT applied, matching the shipped
 * reasoning in `assertUsageWriteAllowed`: changing your own display name or
 * your own password grants you nothing you did not already have, so the
 * self-action rail would only break legitimate self-service.
 */
export function assertDirectoryEditAllowed(args: {
  actor: GuardActor;
  target: GuardTarget;
}): void {
  assertTargetNotOtherOwner(args.actor.id, args.target);
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
 *
 * A target that is ALREADY disabled is never the last operator (N2): it
 * holds no live access, so demoting or removing it cannot strand the box —
 * and refusing would strand the ROW instead, with no route-level exit.
 */
async function assertNotLastOperator(
  tx: GuardTx,
  target: GuardTxTarget,
): Promise<void> {
  if (target.directoryStatus === "DEACTIVATED") return;
  const remaining = await tx.user.count({
    where: {
      role: { in: [...ADMIN_TIER_ROLES] },
      directoryStatus: "ACTIVE",
      id: { not: target.id },
    },
  });
  if (remaining === 0) {
    throw RoleMutationRefusedError.lastOperator();
  }
}

/**
 * Role change: rails 4 → 5, only when the change actually crosses down.
 * `target` MUST be the in-transaction re-read (`readGuardTargetTx`) — the
 * decision to run rail 5 at all is derived from `target.role`.
 */
export async function assertRoleChangeInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTxTarget; requestedRole: Role },
): Promise<void> {
  // Rail 4 is deliberately NOT status-gated: it protects the existence of
  // an owner ROW (owner-only routes must stay reachable after a re-enable),
  // which disabling does not change.
  await assertNotLastOwner(
    tx,
    args.target.role === "owner" && args.requestedRole !== "owner",
  );
  if (ADMIN_TIER.has(args.target.role) && !ADMIN_TIER.has(args.requestedRole)) {
    await assertNotLastOperator(tx, args.target);
  }
}

/** Removal: rails 4 → 5 for any operator-tier target (in-tx re-read). */
export async function assertRemovalInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTxTarget },
): Promise<void> {
  await assertNotLastOwner(tx, args.target.role === "owner");
  if (ADMIN_TIER.has(args.target.role)) {
    await assertNotLastOperator(tx, args.target);
  }
}

/**
 * Disable: rail 5 only (disable never changes the role column, so the
 * owner-count invariant is untouched). Re-disabling an already-DEACTIVATED
 * row is an idempotent pass — it removes no operator capacity.
 */
export async function assertDisableInvariantsTx(
  tx: GuardTx,
  args: { target: GuardTxTarget },
): Promise<void> {
  if (ADMIN_TIER.has(args.target.role)) {
    // The already-DEACTIVATED early return now lives in
    // assertNotLastOperator, shared by all three composites (N2).
    await assertNotLastOperator(tx, args.target);
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
 *
 * WARP-1565 removed the `what` headline override. It existed for exactly one
 * caller: DELETE /api/auth/users/:username, which deleted the Nextcloud
 * account but left the local row, so "User removed" would have been a false
 * statement in an append-only, signature-chained audit log (pr-reviewer
 * #1229 B3). That route now deletes the row, so both removal surfaces
 * describe the same event — and an override with no caller is a seam for the
 * two audit vocabularies to diverge through again.
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
  /**
   * Whether the Nextcloud enable-flag mirror landed (pr-reviewer #1229
   * N1). Recorded on the audit row so a disable that only took effect
   * locally is not indistinguishable from a fully-applied one — NC is
   * proxied without orchestrator auth in front, so the difference is real
   * access, and the reconciler's mirror pass is what closes it.
   */
  ncMirror?: "synced" | "failed";
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
      ...(args.ncMirror ? { ncMirror: args.ncMirror } : {}),
    },
    actor: args.actor,
  });
}

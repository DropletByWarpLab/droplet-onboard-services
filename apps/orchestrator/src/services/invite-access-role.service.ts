/**
 * WARP-1533 (RBAC v2 T9) — access-role handling for the invite flow
 * (ADR-032 §5 invite line: `POST /api/people/invite` accepts `accessRoleId`,
 * rank-capped via the role's `startingPoint`; the accept path assigns it in
 * the same mint transaction — the WARP-1051 pattern).
 *
 * ONE module, TWO postures:
 *
 *   - {@link validateInviteAccessRole} — CREATE time, fail-CLOSED. Shared by
 *     BOTH create surfaces (`POST /api/people/invite` and the legacy
 *     `POST /api/auth/invites`, which the dashboard invite modal calls) so
 *     they can never diverge — the exact drift WARP-1523 had to chase down
 *     on the tier caps. Throws a typed {@link InviteAccessRoleError} the
 *     routes map to `{ error, code }` JSON (the invite-service convention,
 *     mirroring InvalidInviteEmailError / InvalidInviteRoleError).
 *
 *   - {@link resolveInviteAccessRoleForAccept} — ACCEPT time, fail-OPEN
 *     toward least privilege. A role that vanished or was archived between
 *     invite and accept must NEVER fail the accept (the invitee holds a
 *     valid credential); it resolves to "no role + reason" so the route can
 *     fall back to the invite's plain tier and log/Activity-note why.
 *
 * The `startingPoint ∈ {admin, family, guest}` CHECK lives here (schema
 * comment on AccessRole.startingPoint: service-enforced, deliberately not a
 * DB constraint). It runs BEFORE the rank cap so a hand-planted owner-based
 * row is rejected as not-assignable even for an owner inviter — never
 * laundered through "at my own level".
 */
import type { AccessRole, PrismaClient, Role } from "@prisma/client";
import { ROLE_RANK } from "./jwt.service.js";

/**
 * The tiers a custom role may confer (brief D-B): Admin / Family / Guest.
 * Never `owner` (exactly one owner) and never `service` (env-var-minted
 * system principals). `satisfies readonly Role[]` keeps the tuple pinned to
 * the Prisma enum at compile time (the INVITE_ROLES discipline).
 */
export const ASSIGNABLE_STARTING_POINTS = [
  "admin",
  "family",
  "guest",
] as const satisfies readonly Role[];

/** A tier a custom role may confer on its people. */
export type AssignableStartingPoint = (typeof ASSIGNABLE_STARTING_POINTS)[number];

/** Is `value` a startingPoint an invite may carry? */
export function isAssignableStartingPoint(value: unknown): value is AssignableStartingPoint {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_STARTING_POINTS as readonly string[]).includes(value)
  );
}

/** Create-time validation failures, mapped by the routes to `{ error, code }`. */
export type InviteAccessRoleErrorCode =
  | "ACCESS_ROLE_NOT_FOUND"
  | "ACCESS_ROLE_NOT_ACTIVE"
  | "ACCESS_ROLE_NOT_ASSIGNABLE"
  | "ROLE_RANK_EXCEEDED"
  | "ROLE_TIER_MISMATCH";

/**
 * Thrown by {@link validateInviteAccessRole}. Carries the HTTP status the
 * routes should answer with — 403 for the WARP-623 rank cap (same shape as
 * the existing tier cap), 400 for everything else.
 */
export class InviteAccessRoleError extends Error {
  public readonly code: InviteAccessRoleErrorCode;
  public readonly status: 400 | 403;
  constructor(code: InviteAccessRoleErrorCode, status: 400 | 403, message: string) {
    super(message);
    this.name = "InviteAccessRoleError";
    this.code = code;
    this.status = status;
  }
}

/** Input to {@link validateInviteAccessRole}. */
export interface ValidateInviteAccessRoleInput {
  /** The AccessRole UUID the invite wants to carry. */
  accessRoleId: string;
  /** The tier (`role`) the same request assigns — must agree with the
   *  role's startingPoint (the invariant the accept path relies on). Raw
   *  request string: an unrecognized tier simply never matches. */
  inviteTier: string;
  /** The inviter's session tier; absent claim fails closed (WARP-623). */
  inviterRole: Role | undefined;
}

/**
 * Fail-closed create-time validation. Returns the AccessRole row on success;
 * throws {@link InviteAccessRoleError} otherwise. Check order: existence →
 * active → assignable startingPoint → WARP-623 rank cap → tier agreement.
 */
export async function validateInviteAccessRole(
  prisma: PrismaClient,
  input: ValidateInviteAccessRoleInput,
): Promise<AccessRole> {
  const role = await prisma.accessRole.findUnique({ where: { id: input.accessRoleId } });
  if (!role) {
    throw new InviteAccessRoleError(
      "ACCESS_ROLE_NOT_FOUND",
      400,
      "That access role doesn't exist.",
    );
  }
  if (role.state !== "active") {
    throw new InviteAccessRoleError(
      "ACCESS_ROLE_NOT_ACTIVE",
      400,
      `The "${role.name}" role is archived — restore it or pick another role.`,
    );
  }
  if (!isAssignableStartingPoint(role.startingPoint)) {
    // Service-layer CHECK for the schema's admin|family|guest contract.
    // Deliberately BEFORE the rank cap: an owner-based row must read as
    // corrupt data, not as "an owner may assign at their own level".
    throw new InviteAccessRoleError(
      "ACCESS_ROLE_NOT_ASSIGNABLE",
      400,
      `The "${role.name}" role cannot be assigned by invite.`,
    );
  }
  // WARP-623 rank cap on the ROLE's startingPoint — the tier its people
  // actually receive. Same 403 shape (message + code) as the existing tier
  // cap on both create surfaces. Fail closed when the role claim is absent.
  if (!input.inviterRole || ROLE_RANK[role.startingPoint] > ROLE_RANK[input.inviterRole]) {
    throw new InviteAccessRoleError(
      "ROLE_RANK_EXCEEDED",
      403,
      "You cannot invite someone to a role higher than your own",
    );
  }
  // Both checks must AGREE when both are supplied: the invite's tier column
  // is the accept path's least-privilege fallback, so a disagreement would
  // bake in a drift between "what the operator picked" and "what the invitee
  // gets if the role vanishes". The modal always sends tier == startingPoint;
  // anything else is a client bug.
  if (input.inviteTier !== role.startingPoint) {
    throw new InviteAccessRoleError(
      "ROLE_TIER_MISMATCH",
      400,
      `The "${role.name}" role is based on the ${role.startingPoint} tier — the invite's role must match.`,
    );
  }
  return role;
}

/** Why an invite's access role could not be applied at accept time. */
export type AcceptAccessRoleFallbackReason = "missing" | "archived" | "not_assignable";

/** Result of {@link resolveInviteAccessRoleForAccept} — exactly one side set. */
export type AcceptAccessRoleResolution =
  | { role: AccessRole; fallback: null }
  | { role: null; fallback: AcceptAccessRoleFallbackReason };

/**
 * Fail-open accept-time resolution. Never throws on bad role state — the
 * accept must succeed on the invite's plain tier (fail-toward-least-privilege,
 * WARP-1051 discipline); the reason feeds the route's log + Activity note.
 */
export async function resolveInviteAccessRoleForAccept(
  prisma: PrismaClient,
  accessRoleId: string,
): Promise<AcceptAccessRoleResolution> {
  const role = await prisma.accessRole.findUnique({ where: { id: accessRoleId } });
  if (!role) return { role: null, fallback: "missing" };
  if (role.state !== "active") return { role: null, fallback: "archived" };
  if (!isAssignableStartingPoint(role.startingPoint)) {
    return { role: null, fallback: "not_assignable" };
  }
  return { role, fallback: null };
}

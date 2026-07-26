/**
 * WARP-455 — A1 local user directory + scope bindings + guest time-box.
 *
 * Surface owned by this file:
 *   GET    /api/people                — owner+admin list of local User rows
 *   GET    /api/people/permissions    — role × ability matrix (read-only)
 *   PATCH  /api/people/:id/role       — owner+admin, emits ActivityRow
 *   PATCH  /api/people/:id/scope      — owner+admin, emits ActivityRow
 *   DELETE /api/people/:id            — owner+admin, emits ActivityRow
 *
 * Dependencies (do NOT re-implement):
 *   - `requireRole(...roles)`           — WARP-171, src/middleware/auth.ts
 *   - `recordActivity({ kind, ... })`   — WARP-456, src/services/activity.singleton.ts
 *   - `Role` enum                       — WARP-171, src/services/jwt.service.ts (mirrors Prisma)
 *   - `Scope` enum + `requireScope`     — added by THIS ticket, src/middleware/scope.ts
 *
 * Per the no-guessing rule (CLAUDE.md): the User row carries `role: Role`
 * and the GuestExpiry row carries `status: GuestExpiryStatus` — both
 * explicit Prisma enums, never derived from a nullable column.
 *
 * The local `User` model is ADDITIVE on top of the Nextcloud-OCS auth
 * fallback in middleware/auth.ts — it does not replace OCS-validated
 * sessions. A row in this table represents a person the household has
 * deliberately registered through the dashboard's People surface; the
 * Nextcloud fallback continues to populate `req.user` for legacy
 * sessions that haven't yet been mirrored locally.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { revokeAllSessions } from "../services/session.service.js";
import { denylistUser } from "../services/auth-denylist.service.js";
import { ACCESS_TOKEN_TTL_SECONDS, ROLE_RANK } from "../services/jwt.service.js";
import { requireScope, type ScopeLoader } from "../middleware/scope.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  createTeamInvite,
  isInviteRole,
  InvalidInviteEmailError,
  InvalidInviteRoleError,
} from "../services/onboarding-team-invite.service.js";
import {
  validateInviteAccessRole,
  InviteAccessRoleError,
} from "../services/invite-access-role.service.js";
import type { AccessRole } from "@prisma/client";
import {
  sendInviteEmail,
  type SendOptions,
} from "../services/email-channel.service.js";
import { buildInviteUrl } from "../lib/invite-url.js";
import { createLogger } from "../lib/logger.js";
import {
  adminBasicToken,
  DROPLET_ADMINS_GROUP,
} from "../services/department-provisioner.service.js";
import {
  ncAddUserToGroup,
  ncRemoveUserFromGroup,
} from "../services/nextcloud-groups.client.js";
import {
  upsertUsagePolicy,
  getUsagePolicyWithUsage,
  TargetUserNotFoundError,
  type UsagePolicyInput,
} from "../services/usage-policy.service.js";
import type { UserUsagePolicy } from "@prisma/client";

const logger = createLogger("people-route");

// The invite-accept URL is built by the shared, host-validated
// `buildInviteUrl` in lib/invite-url.ts (PR #486 review finding 2). The old
// local `buildInviteAcceptUrl` trusted `x-forwarded-host` blindly, embedding an
// unvalidated host into a token-bearing email link — a token-exfiltration
// vector. Host resolution now goes through the one validated helper.

// Canonical role + scope sets — duplicated as TS literals (mirroring
// what middleware/scope.ts does) so this file compiles standalone
// without pulling the Prisma client into a hot path. Any drift between
// these constants and the Prisma enum is a schema bug; the schema
// tests (local-directory.schema.test.ts + scope.schema.test.ts) lock
// the contract.
const ROLE_VALUES = ["owner", "admin", "family", "guest", "service"] as const;

// The privilege ladder is imported from jwt.service.ts (`ROLE_RANK`) — the
// WARP-623 single source of truth shared with the POST /auth/users and
// POST /auth/invites rank caps. WARP-1523 removed the inline duplicate that
// used to sit here now that both branches have landed on main (jwt.service is
// already in this file's import graph via ACCESS_TOKEN_TTL_SECONDS, so the
// standalone-compile discipline for ROLE_VALUES above is unaffected).

/**
 * WARP-1539 — the ONLY columns the People surface may serialize.
 *
 * These routes used to hand back whole `prisma.user` rows, which carry
 * three things no client may ever receive:
 *
 *   • `passwordHash`    — the argon2id PHC hash. schema.prisma states it is
 *                         "NEVER logged"; shipping it in a JSON body is
 *                         strictly worse than a log line.
 *   • `emailLookupHash` — the WARP-233 HMAC-SHA256 blind index over the
 *                         normalized email. It carries the plaintext-
 *                         uniqueness guarantee that `email @unique` used to
 *                         hold; handing it out lets a holder confirm-by-guess
 *                         which address a row belongs to, defeating the
 *                         property the blind index exists to provide.
 *   • `email`           — an encrypted dcv1: blob at rest (WARP-233). These
 *                         routes never call `decryptColumn`, so it was only
 *                         ever emitted as ciphertext: useless to the client
 *                         and needless exposure. No consumer reads it.
 *
 * owner/admin-only is not a mitigation — it just narrows *whose* session
 * has to leak. This is an allow-list on purpose: a column added to the
 * schema later is excluded by default and must be opted in deliberately,
 * which is the failure direction we want.
 */
const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  isLocal: true,
  nextcloudUsername: true,
  accessRoleId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// WARP-1259 (T7): the box-wide `droplet-admins` NC group (mask 31 on every
// active groupfolder, ADR-029 §3.5 Tier 1 admin-see-all) tracks this exact
// role tier — owner and admin, nothing else.
const ADMIN_TIER_ROLES = new Set<(typeof ROLE_VALUES)[number]>(["owner", "admin"]);

const SCOPE_VALUES = [
  "team",
  "exec_only",
  "finance",
  "engineering",
  "ops",
  "private",
] as const;

const roleSchema = z.object({
  role: z.enum(ROLE_VALUES),
});

const scopeSchema = z.object({
  // At least one binding required. Clearing every binding is a
  // delete-style operation that doesn't belong on PATCH; empty arrays
  // are almost certainly a UX bug (the dashboard sent [] when it meant
  // ["team"]) and 400 prevents accidentally locking a user out.
  scopes: z
    .array(z.enum(SCOPE_VALUES))
    .min(1)
    .max(SCOPE_VALUES.length)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: "Duplicate scopes not allowed",
    }),
});

// PR #381 — onboarding TEAM-invite body. The wizard invites by EMAIL + ROLE.
// The schema only checks presence/type/bounds; the canonical email + role
// VALIDATION lives in onboarding-team-invite.service (normalizeInviteEmail /
// isValidEmail / isInviteRole), which throws the typed errors this route maps
// to a 400 — so the service is the single source of truth for "what is a
// valid invite" and the route doesn't duplicate the email regex / role list.
const inviteSchema = z.object({
  email: z.string().min(1).max(200),
  role: z.string().min(1).max(32),
  // WARP-1533 (RBAC v2 T9): optional custom access role granted by this
  // invite. Shape-checked here; existence/state/rank/tier-agreement are
  // validated by invite-access-role.service in the handler (shared with the
  // legacy POST /auth/invites surface so the two can never diverge).
  accessRoleId: z.string().uuid().optional(),
});

// WARP-1271 (T19a): per-user usage settings. `null` explicitly clears the
// limit (no cap); `undefined` (the key omitted) leaves it unchanged —
// z.string().regex keeps BigInt off the wire (WARP-455 boundary rule),
// parsed to a real bigint before it reaches usage-policy.service.
const usageSchema = z.object({
  storageQuotaBytes: z.string().regex(/^\d+$/).nullable().optional(),
  maxUploadSizeMb: z.number().int().positive().max(1_000_000).nullable().optional(),
});

/** BigInt fields string-encoded per the ADR-029 §8 wire contract. */
function formatUsagePolicy(policy: UserUsagePolicy) {
  return {
    userId: policy.userId,
    storageQuotaBytes: policy.storageQuotaBytes?.toString() ?? null,
    quotaSyncState: policy.quotaSyncState,
    maxUploadSizeMb: policy.maxUploadSizeMb ?? null,
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt,
  };
}

/**
 * Role × ability matrix. Read-only surface for the dashboard's
 * permissions page — encodes the ADR-004 §3 contract so the UI can
 * render the table without a second source of truth. The booleans
 * here intentionally mirror the per-route guards in
 * `__tests__/rbac.test.ts` plus the scope-axis additions from this
 * ticket (the actual enforcement lives in the route guards, not here).
 *
 * Adding a new ability: append a key here AND add the matching
 * `requireRole` / `requireScope` guard at the route. The dashboard
 * keys off the response shape so renaming an existing key is a
 * breaking change.
 */
const PERMISSIONS_MATRIX = {
  owner: {
    managePeople: true,
    manageNetwork: true,
    restartServices: true,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: true,
  },
  admin: {
    managePeople: true,
    manageNetwork: true,
    restartServices: false,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: true,
  },
  family: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: true,
    manageMatter: true,
    writeFiles: true,
    chat: true,
    everyScope: false,
  },
  guest: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: false,
    manageMatter: false,
    writeFiles: false,
    chat: true,
    everyScope: false,
  },
  service: {
    managePeople: false,
    manageNetwork: false,
    restartServices: false,
    manageCameras: false,
    manageMatter: false,
    writeFiles: false,
    chat: true, // voice-io posts to /api/llm/chat under the service principal
    everyScope: false,
  },
} as const;

export function createPeopleRouter(
  prisma: PrismaClient,
  loadUserScopes: ScopeLoader,
  sendOptions: SendOptions = {},
): Router {
  const router = Router();

  // ── GET /api/people ─────────────────────────────────────────
  // Returns every row in the local directory. owner + admin only —
  // the household roster is administrative.
  router.get(
    "/people",
    requireRole("owner", "admin"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-1539 — project at the query, not after: the hash never
        // enters this process's memory, so it cannot reach a heap dump,
        // an error serializer, or a future `res.json(row)` added here.
        const people = await prisma.user.findMany({
          select: PUBLIC_USER_SELECT,
        });
        res.json({ people });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/people/permissions ─────────────────────────────
  // The role × ability matrix the dashboard renders on its Permissions
  // page. Open to every authenticated principal — knowing what
  // *would* be allowed isn't sensitive (the actual enforcement happens
  // at write time on each guarded route).
  router.get(
    "/people/permissions",
    (_req: Request, res: Response) => {
      res.json({ permissions: PERMISSIONS_MATRIX });
    },
  );

  // ── POST /api/people/invite ─────────────────────────────────
  // PR #381 — the onboarding TEAM step invites teammates by email + role.
  // owner + admin only — issuing an invite is an administrative action, same
  // guard as the rest of /api/people. The (email, role) pair is validated by
  // onboarding-team-invite.service: the email is normalized to lowercase
  // (#374 login-key contract) and the role is checked against the SHIPPED
  // HOUSEHOLD model (owner/admin/family/guest); invalid input is rejected
  // inline (400 + a `code`) so the wizard can show a field error.
  //
  // #386 (a SEPARATE PR on main) owns invite-ACCEPT-time argon2id passwordHash
  // so the invited member can sign in on the email-keyed login. This route only
  // CREATES the invite (the same UserInvite row #386's accept path consumes);
  // they are compatible and this route does not re-implement accept.
  router.post(
    "/people/invite",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = inviteSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        // Privilege-escalation guard (mirror of the POST /auth/invites fix).
        // requireRole("owner","admin") proves the caller MAY invite, not WHICH
        // role they may assign. Without this an admin could mint an owner
        // invite, and the accept path grants an owner/admin invite an owner
        // session role + Nextcloud admin group — a straight escalation. Reject
        // (403) any assigned role that outranks the inviter's own. Only
        // recognized invite roles are rank-checked here; an unknown role string
        // falls through to createTeamInvite's typed 400. owner→owner is
        // allowed, admin→owner is not. Fail closed if the role claim is absent.
        const inviterRole = req.user?.role;
        if (
          isInviteRole(parsed.data.role) &&
          (!inviterRole ||
            ROLE_RANK[parsed.data.role] > ROLE_RANK[inviterRole])
        ) {
          return res.status(403).json({
            error: "You cannot invite someone to a role higher than your own",
            code: "ROLE_RANK_EXCEEDED",
          });
        }

        // WARP-1533 (RBAC v2 T9): validate the optional custom access role
        // BEFORE any write — fail-closed via the shared service (exists,
        // active, assignable startingPoint, WARP-623 rank cap on the role's
        // startingPoint with the same 403 shape as the tier cap above, and
        // tier agreement so the accept path's fallback tier can never drift
        // from the operator's pick).
        let accessRole: AccessRole | null = null;
        if (parsed.data.accessRoleId) {
          try {
            accessRole = await validateInviteAccessRole(prisma, {
              accessRoleId: parsed.data.accessRoleId,
              inviteTier: parsed.data.role,
              inviterRole,
            });
          } catch (err) {
            if (err instanceof InviteAccessRoleError) {
              return res.status(err.status).json({ error: err.message, code: err.code });
            }
            throw err;
          }
        }

        let invite;
        try {
          invite = await createTeamInvite(prisma, {
            email: parsed.data.email,
            role: parsed.data.role,
            createdBy: req.user?.username ?? "unknown",
            accessRoleId: accessRole?.id ?? null,
          });
        } catch (err) {
          // Typed validation errors → 400 with the service's `code` so the
          // wizard renders the inline field error. Everything else bubbles.
          if (
            err instanceof InvalidInviteEmailError ||
            err instanceof InvalidInviteRoleError
          ) {
            return res.status(400).json({ error: err.message, code: err.code });
          }
          throw err;
        }

        // BUG-11 — actually deliver the invite. The row is created above; the
        // email is a separate, fallible step. `sendInviteEmail` flips the
        // invite's `sendStatus` to sent/failed and NEVER throws, so a relay
        // outage can't 500 the create. A failed send leaves a valid, retryable
        // invite (POST /api/people/invites/:id/resend) — no silent success.
        const acceptUrl = await buildInviteUrl(req, invite.token);
        const send = await sendInviteEmail(
          prisma,
          {
            inviteId: invite.id,
            to: invite.email,
            acceptUrl,
            role: invite.role,
          },
          sendOptions,
        );

        // Audit the issuance. We record WHO invited WHOM at WHAT role + the
        // delivery outcome — but NEVER the token (it's a bearer credential; an
        // audit row is not the place for it). Lifecycle events go on the `auth`
        // kind (matches the DELETE /people/:id "User removed" convention above).
        // WARP-1533: an access-role invite gets the ADR-032 §5 wording
        // ("Invite created with access role" — the free-text house style,
        // same kind/refs shape as the shipped "Teammate invited"); plain
        // tier invites keep the existing entry byte-for-byte.
        await recordActivity({
          kind: "auth",
          severity: send.status === "sent" ? "ok" : "warn",
          sourceIcon: "user-plus",
          what: accessRole ? "Invite created with access role" : "Teammate invited",
          sub: accessRole
            ? `${invite.email} · ${accessRole.name}`
            : `${invite.email} · ${invite.role}`,
          refs: {
            actor: req.user?.username ?? null,
            email: invite.email,
            role: invite.role,
            sendStatus: send.status,
            ...(accessRole
              ? {
                  accessRoleId: accessRole.id,
                  accessRoleName: accessRole.name,
                  accessRoleStartingPoint: accessRole.startingPoint,
                }
              : {}),
          },
          actor: actorFromRequest(req),
        });

        res.json({
          ok: true,
          token: invite.token,
          email: invite.email,
          role: invite.role,
          access_role_id: invite.accessRoleId,
          expires_at: invite.expiresAt,
          send_status: send.status,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/people/:id/role ──────────────────────────────
  // owner + admin can change another user's role. Emits an
  // ActivityRow with kind=system (per controller brief: lifecycle
  // events go on `auth`, permission edits go on `system`).
  router.patch(
    "/people/:id/role",
    requireRole("owner", "admin"),
    // Scope axis (WARP-455): runs AFTER requireRole per scope.ts module
    // comment. owner/admin short-circuit before the loader, so today this
    // is defense-in-depth + makes the axis live; it bites if the role
    // allowlist ever widens to family/guest.
    requireScope("exec_only", loadUserScopes),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. Runs FIRST so the refusal path
        // skips the body parse + DB read entirely. Operators must use
        // the appropriate workflow (re-invite, ownership-transfer) to
        // change their own role — the people surface is for editing
        // OTHER members, and a self-edit here is almost always a
        // misclick that ends in lockout. Refusals do NOT emit an
        // ActivityRow: the audit log is reserved for actual state
        // changes; refused calls are noise that crowd out signal.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const parsed = roleSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid role",
            details: parsed.error.flatten(),
          });
        }

        // WARP-1539 — projected: this row is both read for the guards
        // below AND returned verbatim by the no-op short-circuit, so it
        // must never carry the secret columns. Every field the handler
        // reads (id, username, role, nextcloudUsername) is in the
        // allow-list.
        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
          select: PUBLIC_USER_SELECT,
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }
        // No-op short-circuit: skip the update AND the audit row when
        // the role is already what the caller asked for. Avoids
        // polluting the activity feed with no-change touches when the
        // dashboard re-submits the same form on focus loss.
        if (existing.role === parsed.data.role) {
          return res.json({ user: existing });
        }

        // WARP-1523: ROLE_RANK cap on the role-UPDATE path — the same
        // privilege-escalation guard the CREATE/INVITE sites enforce
        // (POST /auth/users, POST /auth/invites, POST /people/invite).
        // requireRole("owner","admin") proves the caller may edit roles,
        // not WHICH role they may assign: without this cap an admin
        // (rank 2) could set any member to owner (rank 3). The cap is
        // <= — assigning your OWN rank is allowed (owner→owner co-owner,
        // admin→admin last-admin recovery), only an outranking target is
        // refused. Runs AFTER the no-op short-circuit so an unchanged
        // re-submit of an owner row by an admin stays a quiet 200 (the
        // dashboard re-submits the same form on focus loss), and BEFORE
        // the write path so every actual escalating change is refused.
        // Fail closed if the actor's role claim is somehow absent.
        const actorRole = req.user?.role;
        if (!actorRole || ROLE_RANK[parsed.data.role] > ROLE_RANK[actorRole]) {
          return res.status(403).json({
            error: "You cannot assign a role higher than your own",
            code: "ROLE_RANK_EXCEEDED",
          });
        }

        // WARP-480 last-owner invariant. At least one user with
        // role="owner" must remain at all times so owner-only routes
        // (POST /api/network/system/reboot, the device-identity reseal,
        // etc.) stay reachable without DB hand-edits. The count + the
        // update run inside a single interactive $transaction so a
        // concurrent demotion can't slip past the check window —
        // serializable isolation is the default for Prisma $transaction
        // on Postgres, which is what we need here.
        //
        // Only fires on owner→non-owner. Owner→owner is filtered out
        // above by the no-op short-circuit, and non-owner→anything
        // never touches the invariant.
        const demotingOnlyOwner =
          existing.role === "owner" && parsed.data.role !== "owner";

        const result = await prisma.$transaction(async (tx) => {
          if (demotingOnlyOwner) {
            const owners = await tx.user.count({ where: { role: "owner" } });
            if (owners <= 1) {
              return { kind: "last-owner" as const };
            }
          }
          // WARP-1539 — the updated row is returned to the caller, so it
          // gets the same projection as every other read here.
          const updated = await tx.user.update({
            where: { id: req.params.id },
            data: { role: parsed.data.role },
            select: PUBLIC_USER_SELECT,
          });
          return { kind: "ok" as const, updated };
        });

        if (result.kind === "last-owner") {
          return res.status(409).json({
            error:
              "Cannot remove the only owner. Promote another user to owner first.",
            code: "LAST_OWNER_INVARIANT",
          });
        }

        // WARP-247: a role change must propagate at the next REQUEST, not
        // wait out the ≤15-min access-token TTL or the next refresh.
        // revokeAllSessions deletes this user's session RECORDS (so their
        // access tokens 401 at the next middleware check and re-auth under
        // the new role) AND sweeps the WARP-116 refresh denylist internally
        // as defense-in-depth. Best-effort (the service swallows Redis
        // errors).
        await revokeAllSessions(req.params.id);

        // WARP-1259 (T7): the box-wide `droplet-admins` invariant (ADR-029
        // §3.5 Tier 1 admin-see-all — mask 31 on every active groupfolder)
        // must track owner/admin promotion and demotion through the SAME
        // code path that already revokes sessions on a role change. Wired
        // right beside revokeAllSessions per the ticket. Best-effort and
        // non-blocking: an NC outage must not fail the role change itself
        // (the reconciler's droplet-admins-everywhere convergence pass
        // eventually re-attaches the group to every folder regardless, but
        // the direct user<->group membership here has no reconciler sweep
        // of its own yet — a persistent NC outage needs operator follow-up,
        // logged at error).
        const wasAdminTier = ADMIN_TIER_ROLES.has(existing.role);
        const isAdminTierNow = ADMIN_TIER_ROLES.has(parsed.data.role);
        if (wasAdminTier !== isAdminTierNow && existing.nextcloudUsername) {
          const ncUsername = existing.nextcloudUsername;
          try {
            const adminToken = adminBasicToken();
            if (isAdminTierNow) {
              await ncAddUserToGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
            } else {
              await ncRemoveUserFromGroup(adminToken, ncUsername, DROPLET_ADMINS_GROUP);
            }
          } catch (err) {
            logger.error(
              { err, userId: existing.id, ncUsername, isAdminTierNow },
              "role change: droplet-admins NC group sync failed (non-blocking)",
            );
          }
        }

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "shield",
          what: "Role changed",
          sub: `${existing.username}: ${existing.role} → ${parsed.data.role}`,
          refs: {
            actor: req.user?.username ?? null,
            targetUserId: existing.id,
            targetUsername: existing.username,
            previousRole: existing.role,
            nextRole: parsed.data.role,
          },
          actor: actorFromRequest(req),
        });

        res.json({ user: result.updated });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/people/:id/scope ─────────────────────────────
  // owner + admin can replace the user's scope bindings wholesale.
  // PATCH semantics: send the full desired set; the server diffs by
  // deleting all existing bindings and recreating from the payload.
  // Wrapped in a transaction so a partial failure doesn't leave the
  // user with no bindings at all.
  router.patch(
    "/people/:id/scope",
    requireRole("owner", "admin"),
    // Scope axis (WARP-455) — second guard, see PATCH /people/:id/role.
    requireScope("exec_only", loadUserScopes),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. See the matching block on
        // PATCH /people/:id/role for the full rationale; same shape
        // here so the dashboard can render one error path. Runs
        // BEFORE the body parse to save a roundtrip on the refusal.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const parsed = scopeSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid scopes",
            details: parsed.error.flatten(),
          });
        }

        // WARP-1539 — projected: returned to the caller at the end of this
        // handler. Only `id` and `username` are read off it (the audit row).
        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
          select: PUBLIC_USER_SELECT,
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }

        // Drop the old bindings, write the new ones. The deleteMany +
        // recreate pair runs inside a single interactive $transaction so a
        // transient DB error or process crash between the delete commit and
        // the last create can't leave the user with zero bindings — which
        // would silently lock them out of every scope-guarded route. Same
        // shape as the PATCH /role last-owner invariant transaction above;
        // serializable isolation is Prisma's $transaction default on Postgres.
        const targetUserId = req.params.id;
        const actor = req.user?.username ?? null;

        await prisma.$transaction(async (tx) => {
          await tx.scopeBinding.deleteMany({
            where: { userId: targetUserId },
          });
          await tx.scopeBinding.createMany({
            data: parsed.data.scopes.map((scope) => ({
              userId: targetUserId,
              scope: scope as any, // Scope enum literal; cast for Prisma input
              grantedBy: actor,
            })),
            skipDuplicates: true,
          });
        });

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "shield",
          what: "Scope bindings updated",
          sub: `${existing.username}: [${parsed.data.scopes.join(", ")}]`,
          refs: {
            actor,
            targetUserId: existing.id,
            targetUsername: existing.username,
            scopes: parsed.data.scopes,
          },
          actor: actorFromRequest(req),
        });

        res.json({
          user: existing,
          scopes: parsed.data.scopes,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/people/:id ──────────────────────────────────
  // owner + admin only. Cascade on User deletes ScopeBindings and
  // GroupMemberships per the schema's onDelete: Cascade. We refuse to
  // delete OCS-owned rows (isLocal=false) — Nextcloud upstream owns
  // those identities; deleting locally would create drift the next
  // sync would rewrite anyway.
  router.delete(
    "/people/:id",
    requireRole("owner", "admin"),
    // Scope axis (WARP-455) — second guard, see PATCH /people/:id/role.
    requireScope("exec_only", loadUserScopes),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-480 self-action guard. An owner could otherwise DELETE
        // their own row and lock the household out of every owner-only
        // route. Account removal goes through a separate workflow (not
        // in this surface) so an operator can never accidentally delete
        // themselves with one wrong click.
        if (req.params.id === req.user?.id) {
          return res.status(409).json({
            error: "Cannot modify your own role, scope, or account",
            code: "SELF_ACTION_NOT_ALLOWED",
          });
        }

        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }
        if (!existing.isLocal) {
          // 409 Conflict — \"the resource state forbids this\". 403 would
          // imply auth/permission; the caller IS allowed, the resource
          // just isn't deletable from here.
          return res.status(409).json({
            error: "Cannot delete OCS-owned identity from local directory",
          });
        }

        // WARP-480 last-owner invariant. Deleting an owner is only
        // allowed when at least one other owner remains. count + delete
        // run inside one interactive $transaction so a concurrent
        // demotion of the other owner can't slip past the check window.
        const result = await prisma.$transaction(async (tx) => {
          if (existing.role === "owner") {
            const owners = await tx.user.count({ where: { role: "owner" } });
            if (owners <= 1) {
              return { kind: "last-owner" as const };
            }
          }
          await tx.user.delete({ where: { id: req.params.id } });
          return { kind: "ok" as const };
        });

        if (result.kind === "last-owner") {
          return res.status(409).json({
            error:
              "Cannot remove the only owner. Promote another user to owner first.",
            code: "LAST_OWNER_INVARIANT",
          });
        }

        // WARP-490 — a deletion is a hard revocation, so kill the removed
        // user's live credentials immediately rather than letting an
        // already-issued access token ride out its ≤15-min TTL:
        //   • revokeAllSessions deletes their session RECORDS (sid-carrying
        //     access tokens 401 at the next request) and sweeps the WARP-116
        //     refresh denylist — the same call the role/scope handlers make;
        //     DELETE was the one mutation that had been missing it.
        //   • denylistUser writes auth:denylist:user:<id> for the access-
        //     token max-age so the middleware also rejects sid-LESS grace-
        //     path tokens (which skip the session check) within that window;
        //     the entry self-expires once no such token can still be valid.
        // Both are best-effort (Redis errors are swallowed) — the row is
        // already gone, so /auth/refresh fails closed regardless.
        await revokeAllSessions(existing.id);
        await denylistUser(existing.id, ACCESS_TOKEN_TTL_SECONDS);

        await recordActivity({
          kind: "auth",
          severity: "warn",
          sourceIcon: "user-x",
          what: "User removed",
          sub: existing.username,
          refs: {
            actor: req.user?.username ?? null,
            targetUserId: existing.id,
            targetUsername: existing.username,
            role: existing.role,
          },
          actor: actorFromRequest(req),
        });

        res.json({ ok: true, removed: existing.username });
      } catch (err) {
        // Prisma's P2025 (record not found) shouldn't reach here
        // because of the findUnique above, but stay defensive.
        logger.warn({ err, id: req.params.id }, "DELETE /people failed");
        next(err);
      }
    },
  );

  // ── PUT /api/people/:id/usage ───────────────────────────────
  // WARP-1271 (T19a). owner + admin only. Upserts UserUsagePolicy and
  // best-effort pushes the storage quota to Nextcloud
  // (usage-policy.service.ts); `maxUploadSizeMb` is orchestrator-local
  // (enforced in files.ts's multer path). No self-action guard here — an
  // owner/admin editing THEIR OWN storage quota/upload cap is normal
  // (unlike role/scope/delete, this can't lock anyone out of the box).
  router.put(
    "/people/:id/usage",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = usageSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }
        if (
          parsed.data.storageQuotaBytes === undefined &&
          parsed.data.maxUploadSizeMb === undefined
        ) {
          return res.status(400).json({
            error: "At least one of storageQuotaBytes / maxUploadSizeMb is required",
          });
        }

        const input: UsagePolicyInput = {
          storageQuotaBytes:
            parsed.data.storageQuotaBytes === undefined
              ? undefined
              : parsed.data.storageQuotaBytes === null
                ? null
                : BigInt(parsed.data.storageQuotaBytes),
          maxUploadSizeMb: parsed.data.maxUploadSizeMb,
        };

        const { policy } = await upsertUsagePolicy(
          prisma,
          req.params.id,
          req.user?.id ?? "unknown",
          input,
        );
        res.json({ policy: formatUsagePolicy(policy) });
      } catch (err) {
        if (err instanceof TargetUserNotFoundError) {
          return res.status(404).json({ error: "User not found" });
        }
        logger.warn({ err, id: req.params.id }, "PUT /people/:id/usage failed");
        next(err);
      }
    },
  );

  // ── GET /api/people/:id/usage ───────────────────────────────
  // WARP-1271 (T19a). owner + admin only. Returns the policy row (or null
  // if never set) plus a live, display-only used-bytes read-back from
  // Nextcloud — never policy truth (ADR-029 §5).
  router.get(
    "/people/:id/usage",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { policy, usedBytes } = await getUsagePolicyWithUsage(
          prisma,
          req.params.id,
        );
        res.json({
          policy: policy ? formatUsagePolicy(policy) : null,
          usedBytes: usedBytes !== null ? usedBytes.toString() : null,
        });
      } catch (err) {
        if (err instanceof TargetUserNotFoundError) {
          return res.status(404).json({ error: "User not found" });
        }
        logger.warn({ err, id: req.params.id }, "GET /people/:id/usage failed");
        next(err);
      }
    },
  );

  return router;
}

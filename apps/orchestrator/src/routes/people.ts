/**
 * WARP-455 — A1 local user directory + scope bindings + guest time-box.
 *
 * Surface owned by this file:
 *   GET    /api/people                — owner+admin list of local User rows
 *   GET    /api/people/permissions    — role × ability matrix (read-only)
 *   PATCH  /api/people/:id/role       — owner+admin, emits ActivityRow
 *   PATCH  /api/people/:id/scope      — owner+admin, emits ActivityRow
 *   DELETE /api/people/:id            — owner+admin, emits ActivityRow
 *   PATCH  /api/people/:id/access            — WARP-1527: custom role / built-in tier
 *   GET    /api/people/:id/effective-access  — WARP-1527: the ADR-032 §3 resolver output
 *   PUT    /api/people/:id/access-exceptions — WARP-1527: replace the exception set
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
import { requireScope, type ScopeLoader } from "../middleware/scope.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
// WARP-1526 (RBAC v2 T2): every person-mutation on this surface runs the
// consolidated rails — owner-untouchable, self-action, rank cap, assignable
// narrowing pre-tx; last-owner + last-operator in-tx; revoke/denylist/
// Activity/NC-cascade post-commit — through ONE service shared with the
// /api/auth/users* surface (ADR-032 draft §4). The WARP-480 / WARP-1523 /
// WARP-247 / WARP-1259 inline blocks this file used to carry live there now.
import {
  RoleMutationRefusedError,
  SERIALIZABLE_TX,
  isConcurrencyConflict,
  readGuardTargetTx,
  ASSIGNABLE_ROLES,
  type AssignableRole,
  assertNotSelf,
  assertRoleChangeAllowed,
  assertScopeChangeAllowed,
  assertRemovalAllowed,
  assertUsageWriteAllowed,
  assertAssignableForCreate,
  assertRoleChangeInvariantsTx,
  assertRemovalInvariantsTx,
  runRoleChangePostEffects,
  runRemovalPostEffects,
} from "../services/role-mutation-guard.service.js";
// WARP-1527 (RBAC v2 T3): the per-person access surface — custom-role /
// built-in-tier assignment, the §3 resolver read, and the feature-axis
// exception editor.
import {
  AccessPreconditionError,
  isAccessPreconditionError,
} from "../lib/access-precondition.js";
import { revokeAllSessions } from "../services/session.service.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import { GATEABLE_MODULE_IDS, type GateableModuleId } from "../services/access-catalog.js";
import {
  createTeamInvite,
  isInviteRole,
  InvalidInviteEmailError,
  InvalidInviteRoleError,
} from "../services/onboarding-team-invite.service.js";
import {
  validateInviteAccessRole,
  InviteAccessRoleError,
  type ValidatedInviteAccessRole,
} from "../services/invite-access-role.service.js";
import {
  sendInviteEmail,
  type SendOptions,
} from "../services/email-channel.service.js";
import { buildInviteUrl } from "../lib/invite-url.js";
import { createLogger } from "../lib/logger.js";
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

// The rank ladder, the assignable-role narrowing, the admin-tier set, and
// every other mutation rail live in role-mutation-guard.service.ts
// (WARP-1526) — the WARP-623 / WARP-1523 single-source-of-truth discipline,
// now one step further: this file registers routes and maps refusals; the
// rails themselves are shared with routes/auth.ts. `service` and `owner`
// stay in ROLE_VALUES so zod keeps 400-ing unknown STRINGS while the guard
// 403s known-but-unassignable ROLES (ROLE_NOT_ASSIGNABLE) — two different
// failure classes on purpose.

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
  // WARP-1526 (pr-reviewer #1229 N2): the guard's in-transaction invariants
  // need the target's CURRENT enable state — a DEACTIVATED sole operator
  // must stay demotable/removable (they hold no live access, so removing
  // them cannot strand the box). Deliberate allow-list addition: the
  // enable/disable state is the same fact the roster already renders, it
  // carries no credential material, and every route here is owner/admin.
  directoryStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

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

// WARP-1527 (RBAC v2 T3): PATCH /people/:id/access — the T8 contract's two
// shapes: `{ accessRoleId }` assigns a custom role; `{ accessRoleId: null,
// tier }` assigns a BUILT-IN tier (clears the role pointer, sets User.role).
// `tier` reuses the T2 assignable vocabulary — never owner/service; sending
// both a role id AND a tier is ambiguous and refused.
const personAccessSchema = z
  .object({
    accessRoleId: z.string().min(1).max(128).nullable(),
    tier: z.enum(ASSIGNABLE_ROLES).optional(),
  })
  .refine((body) => (body.accessRoleId === null ? body.tier !== undefined : body.tier === undefined), {
    message: "Send { accessRoleId } for a custom role, or { accessRoleId: null, tier } for a built-in tier",
  });

// WARP-1527: PUT /people/:id/access-exceptions — the small, feature-axis-only
// v1 exception list (O-3). `level` is REQUIRED when effect=allow (the carried
// zod obligation); the always-on chat module is exception-immune, so its id
// is simply not in the vocabulary; duplicates are a client bug → 400.
const accessExceptionSchema = z.object({
  moduleId: z.enum(GATEABLE_MODULE_IDS as unknown as [GateableModuleId, ...GateableModuleId[]]),
  effect: z.enum(["allow", "deny"]),
  level: z.enum(["view", "act", "manage"]).nullable().optional(),
});

const accessExceptionsSchema = z.object({
  exceptions: z
    .array(accessExceptionSchema)
    .max(GATEABLE_MODULE_IDS.length)
    .refine((arr) => new Set(arr.map((x) => x.moduleId)).size === arr.length, {
      message: "Duplicate exception modules not allowed",
    })
    .refine((arr) => arr.every((x) => x.effect !== "allow" || (x.level !== null && x.level !== undefined)), {
      message: "`level` is required when effect is `allow`",
    }),
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

        // Rails 3 + 7 (WARP-1526, guard service): the rank cap that mirrors
        // the POST /auth/invites fix — requireRole proves the caller MAY
        // invite, not WHICH role they may assign — plus the assignable-enum
        // narrowing: invites only ever assign {admin, family, guest}
        // (design brief §6.2 "never Owner or Service"; exactly one owner by
        // design, so even an owner cannot mint a second owner invite —
        // this consciously supersedes the earlier owner→owner-allowed pin).
        // Only recognized invite roles reach the rails; an unknown role
        // string falls through to createTeamInvite's typed 400. Fail closed
        // if the actor's role claim is absent (inside the guard).
        //
        // `inviterRole` is read out here because BOTH the tier rails (moved
        // below the access-role validation, see the ORDER note there) and
        // the WARP-1533 access-role validation apply a rank cap — the guard
        // rails cover the tier, the shared invite-access-role service
        // covers the custom role's startingPoint.
        const inviterRole = req.user?.role;

        // WARP-1533 (RBAC v2 T9): validate the optional custom access role
        // BEFORE any write — fail-closed via the shared service (exists,
        // active, assignable startingPoint, WARP-623 rank cap on the role's
        // startingPoint, and tier agreement so the accept path's fallback
        // tier can never drift from the operator's pick).
        //
        // ORDER (WARP-1526 × WARP-1533, decided at rebase): when the
        // operator picked a custom role, its validation runs FIRST so the
        // specific diagnosis wins — an owner-startingPoint row answers
        // ACCESS_ROLE_NOT_ASSIGNABLE (400) rather than being masked by the
        // coarser tier refusal, which would otherwise always fire first
        // because T9's own tier-agreement check forces tier == startingPoint.
        // Both are fail-closed and nothing is written by either. With no
        // accessRoleId (every pre-T9 caller) this block is skipped entirely
        // and the tier rails below are still the first thing that runs.
        //
        // WARP-1572 (F4): the declared type is the validator's BRANDED
        // output — createTeamInvite's seam only accepts a role that went
        // through validateInviteAccessRole, so the reorder above cannot
        // become a path that hands the seam an unvalidated row.
        let accessRole: ValidatedInviteAccessRole | null = null;
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

        if (isInviteRole(parsed.data.role)) {
          assertAssignableForCreate({
            actorRole: inviterRole,
            requestedRole: parsed.data.role,
            rankMessage:
              "You cannot invite someone to a role higher than your own",
          });
        }

        let invite;
        try {
          invite = await createTeamInvite(prisma, {
            email: parsed.data.email,
            role: parsed.data.role,
            createdBy: req.user?.username ?? "unknown",
            // Branded object, not a bare id — the seam only accepts a role
            // that went through validateInviteAccessRole (review F4).
            accessRole,
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
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        // pr-reviewer #1229 B1: the SERIALIZABLE loser (P2034) and the
        // optimistic-write miss (P2025) both mean "nothing was applied,
        // retry" — a 409, never the 500 an unmapped Prisma error becomes.
        if (isConcurrencyConflict(err)) {
          const conflict = RoleMutationRefusedError.concurrentMutation();
          return res.status(conflict.status).json(conflict.toJSON());
        }
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
        // Rail 2 (WARP-480 self-action). Runs FIRST so the refusal path
        // skips the body parse + DB read entirely — the shipped placement,
        // now routed through the guard service so /api/auth/users* shares
        // the identical rail. Operators must use the appropriate workflow
        // (re-invite, ownership-transfer) to change their own role; a
        // self-edit here is almost always a misclick that ends in lockout.
        // Refusals do NOT emit an ActivityRow: the audit log is reserved
        // for actual state changes; refused calls are noise.
        assertNotSelf(req.user?.id, req.params.id);

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
        // dashboard re-submits the same form on focus loss. Pinned to run
        // BEFORE the rails (WARP-1523 tests): an admin re-submitting an
        // owner row unchanged stays a quiet 200 — a no-op is not a
        // mutation, so the owner-untouchable rail has nothing to refuse.
        if (existing.role === parsed.data.role) {
          return res.json({ user: existing });
        }

        // Rails 1 → 3 → 7 (WARP-1526, guard service): owner-untouchable
        // (any actual change targeting an owner row is refused with the
        // design copy — closes "another admin can edit the owner"), the
        // WARP-1523 rank cap (<= — equal rank allowed, fail closed on a
        // missing actor claim), then the assignable-enum narrowing
        // ({admin, family, guest} only; never owner or service, design
        // brief §6.2). Rank runs before the narrowing so admin→owner
        // keeps its exact ROLE_RANK_EXCEEDED refusal.
        assertRoleChangeAllowed({
          actor: { id: req.user?.id, role: req.user?.role },
          target: { id: existing.id, role: existing.role },
          requestedRole: parsed.data.role,
        });

        // Rails 4 + 5 in-transaction (WARP-480 last-owner backstop +
        // WARP-1526 last-operator), then the write — all inside ONE
        // SERIALIZABLE transaction (pr-reviewer #1229 B1: Prisma inherits
        // the Postgres default, READ COMMITTED, under which two concurrent
        // demotions of the last two operators both pass the count and both
        // commit). Refusals throw out of the transaction and roll it back;
        // the catch below maps them to their 4xx, and a serialization
        // loser to CONCURRENT_MUTATION rather than a 500.
        const updated = await prisma.$transaction(async (tx) => {
          // B2 — re-read INSIDE the transaction. `existing` is a pre-tx
          // snapshot, and whether rail 5 runs at all is derived from the
          // target's tier: a stale `family` would skip the operator check
          // entirely while a concurrent promotion made this row the only
          // admin. The rails decide on THIS row, never the snapshot.
          const fresh = await readGuardTargetTx(tx, req.params.id);
          if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
          await assertRoleChangeInvariantsTx(tx, {
            target: fresh,
            requestedRole: parsed.data.role,
          });
          // WARP-1539 — the updated row is returned to the caller, so it
          // gets the same projection as every other read here.
          // B2 — optimistic concurrency: pinning `role` closes the window
          // between the re-read above and this write. A miss is P2025,
          // mapped to CONCURRENT_MUTATION below.
          return tx.user.update({
            where: { id: req.params.id, role: fresh.role },
            data: { role: parsed.data.role },
            select: PUBLIC_USER_SELECT,
          });
        }, SERIALIZABLE_TX);

        // Rail 6 (consolidated post-commit effects): WARP-247 session
        // revocation so the new role propagates at the next request, the
        // WARP-1259 droplet-admins NC cascade on tier crossings (best-
        // effort + logged; the department-reconciler's admin-group sweep
        // now converges residual drift from User.role), and the audit row.
        await runRoleChangePostEffects({
          target: {
            id: existing.id,
            username: existing.username,
            nextcloudUsername: existing.nextcloudUsername,
          },
          previousRole: existing.role,
          nextRole: parsed.data.role,
          actorUsername: req.user?.username ?? null,
          actor: actorFromRequest(req),
        });

        res.json({ user: updated });
      } catch (err) {
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        // pr-reviewer #1229 B1: the SERIALIZABLE loser (P2034) and the
        // optimistic-write miss (P2025) both mean "nothing was applied,
        // retry" — a 409, never the 500 an unmapped Prisma error becomes.
        if (isConcurrencyConflict(err)) {
          const conflict = RoleMutationRefusedError.concurrentMutation();
          return res.status(conflict.status).json(conflict.toJSON());
        }
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
        // Rail 2 (WARP-480 self-action) — see PATCH /people/:id/role for
        // the rationale; routed through the guard service, still BEFORE
        // the body parse to save a roundtrip on the refusal.
        assertNotSelf(req.user?.id, req.params.id);

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

        // Rail 1 (WARP-1526 owner untouchable): an owner's scope bindings
        // are inert today (requireScope short-circuits owners) but they
        // are still a mutation of the owner's row — "can't be changed
        // here" covers them too.
        assertScopeChangeAllowed({
          actor: { id: req.user?.id, role: req.user?.role },
          target: { id: existing.id, role: existing.role },
        });

        // Drop the old bindings, write the new ones. The deleteMany +
        // recreate pair runs inside a single interactive $transaction so a
        // transient DB error or process crash between the delete commit and
        // the last create can't leave the user with zero bindings — which
        // would silently lock them out of every scope-guarded route. Same
        // shape — and the same explicit SERIALIZABLE_TX — as the PATCH /role
        // invariant transaction above, so two concurrent rewrites of the
        // same user's bindings can't interleave into a merged set. Prisma's
        // default is READ COMMITTED, never serializable.
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
        }, SERIALIZABLE_TX);

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
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        // pr-reviewer #1229 B1: the SERIALIZABLE loser (P2034) and the
        // optimistic-write miss (P2025) both mean "nothing was applied,
        // retry" — a 409, never the 500 an unmapped Prisma error becomes.
        if (isConcurrencyConflict(err)) {
          const conflict = RoleMutationRefusedError.concurrentMutation();
          return res.status(conflict.status).json(conflict.toJSON());
        }
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
        // Rail 2 (WARP-480 self-action). An owner could otherwise DELETE
        // their own row and lock the household out of every owner-only
        // route. Account removal goes through a separate workflow (not
        // in this surface) so an operator can never accidentally delete
        // themselves with one wrong click.
        assertNotSelf(req.user?.id, req.params.id);

        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }

        // Rail 1 (WARP-1526 owner untouchable): owner rows cannot be
        // removed by ANY actor — regardless of how many owner rows exist.
        // Off-boarding an owner belongs to the future ownership-transfer
        // flow. This supersedes the earlier two-owner off-boarding path
        // and shadows the last-owner invariant below (kept as the in-tx
        // backstop).
        assertRemovalAllowed({
          actor: { id: req.user?.id, role: req.user?.role },
          target: { id: existing.id, role: existing.role },
        });

        if (!existing.isLocal) {
          // 409 Conflict — \"the resource state forbids this\". 403 would
          // imply auth/permission; the caller IS allowed, the resource
          // just isn't deletable from here.
          return res.status(409).json({
            error: "Cannot delete OCS-owned identity from local directory",
          });
        }

        // Rails 4 + 5 in-transaction (WARP-480 last-owner backstop +
        // WARP-1526 last-operator: removing the final non-disabled
        // owner-or-admin is refused), then the delete — checks + write in
        // one interactive $transaction so a concurrent demotion can't slip
        // past the check window.
        // SERIALIZABLE + in-tx re-read + optimistic delete (pr-reviewer
        // #1229 B1/B2), same shape as PATCH /role above.
        await prisma.$transaction(async (tx) => {
          const fresh = await readGuardTargetTx(tx, req.params.id);
          if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
          await assertRemovalInvariantsTx(tx, { target: fresh });
          await tx.user.delete({
            where: { id: req.params.id, role: fresh.role },
          });
        }, SERIALIZABLE_TX);

        // Rail 6 (consolidated post-commit effects) — WARP-490 hard
        // revocation: session RECORDS swept + the sid-less access-token
        // denylist written (both best-effort; the row is already gone, so
        // /auth/refresh fails closed regardless), then the mandatory-emit
        // audit row.
        await runRemovalPostEffects({
          targetUserId: existing.id,
          targetUsername: existing.username,
          targetRole: existing.role,
          actorUsername: req.user?.username ?? null,
          actor: actorFromRequest(req),
        });

        res.json({ ok: true, removed: existing.username });
      } catch (err) {
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        // pr-reviewer #1229 B1: the SERIALIZABLE loser (P2034) and the
        // optimistic-write miss (P2025) both mean "nothing was applied,
        // retry" — a 409, never the 500 an unmapped Prisma error becomes.
        if (isConcurrencyConflict(err)) {
          const conflict = RoleMutationRefusedError.concurrentMutation();
          return res.status(conflict.status).json(conflict.toJSON());
        }
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

        // Rail 1 (WARP-1526 owner untouchable): a usage-policy write IS a
        // mutation targeting the person, so the owner's row is off-limits
        // here too — an admin must not be able to cap the owner's storage
        // (and the owner's own usage stays "full control", not a policy
        // row). Rail 2 intentionally does NOT apply: a non-owner operator
        // editing THEIR OWN quota/upload cap is normal (WARP-1271) — it
        // can't lock anyone out of the box.
        const target = await prisma.user.findUnique({
          where: { id: req.params.id },
          select: { id: true, role: true },
        });
        if (!target) {
          return res.status(404).json({ error: "User not found" });
        }
        assertUsageWriteAllowed({ target });

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
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        // pr-reviewer #1229 B1: the SERIALIZABLE loser (P2034) and the
        // optimistic-write miss (P2025) both mean "nothing was applied,
        // retry" — a 409, never the 500 an unmapped Prisma error becomes.
        if (isConcurrencyConflict(err)) {
          const conflict = RoleMutationRefusedError.concurrentMutation();
          return res.status(conflict.status).json(conflict.toJSON());
        }
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

  // ── PATCH /api/people/:id/access ────────────────────────────
  // WARP-1527 (RBAC v2 T3). The per-person assignment path of ADR-032 §5:
  // a custom role sets `accessRoleId` AND `User.role = startingPoint` in
  // the same transaction (the §2 rule that keeps the ADR-004 enum floor
  // authoritative); `{ accessRoleId: null, tier }` returns the person to a
  // plain built-in tier. Both shapes run the full T2 rails + post-effect
  // runners; the response's pending syncState drives the UI's
  // "Saved. Applying…" line.
  router.patch(
    "/people/:id/access",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Rail 2 first — the shipped placement (see PATCH /people/:id/role).
        assertNotSelf(req.user?.id, req.params.id);

        const parsed = personAccessSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        // Everything that DECIDES the write — the role row (state +
        // startingPoint), the target row, the rails — is read INSIDE the
        // serializable transaction (review B2). Read outside, a concurrent
        // archive or re-base of the role would let this write a tier the
        // role no longer carries, and layer-1 requireRole would honour that
        // stale tier indefinitely. SERIALIZABLE_TX is passed EXPLICITLY,
        // exactly like the sibling role/scope/delete paths (WARP-1526):
        // Prisma/Postgres default to READ COMMITTED.
        //
        // WARP-1583: precondition failures THROW `AccessPreconditionError`,
        // the same mechanism the sibling assign path in routes/access.ts
        // uses. This path previously returned a discriminated `{ kind }`
        // union — equivalent while every check precedes the first write, and
        // fail-OPEN the day one does not, because a returned outcome commits
        // what the transaction already wrote. Unwinding rolls it back, and
        // collapses the catch below to the one shape the rails already use.
        const outcome = await prisma.$transaction(async (tx) => {
          let requestedRole: AssignableRole;
          let accessRoleId: string | null;
          let roleName: string | null = null;
          if (parsed.data.accessRoleId !== null) {
            const role = await tx.accessRole.findUnique({
              where: { id: parsed.data.accessRoleId },
            });
            if (!role) throw AccessPreconditionError.roleNotFound();
            if (role.state === "archived") throw AccessPreconditionError.roleArchived();
            requestedRole = role.startingPoint as AssignableRole;
            accessRoleId = role.id;
            roleName = role.name;
          } else {
            // zod's refine guarantees tier is present on this branch.
            requestedRole = parsed.data.tier as AssignableRole;
            accessRoleId = null;
          }

          // WARP-1539 — projected at the query: this row feeds the guards
          // and the post-effect runners, so the hash/blind-index must never
          // materialize here even though the response body is only
          // `{ syncState }`.
          const existing = await tx.user.findUnique({
            where: { id: req.params.id },
            select: PUBLIC_USER_SELECT,
          });
          if (!existing) throw AccessPreconditionError.userNotFound();

          // Rails 1 → 3 → 7 — identical to a direct role change: the
          // assigned tier is the role's startingPoint (or the tier itself).
          // A refusal throws out of the transaction and rolls it back; the
          // route catch maps it (the DELETE /people/:id precedent).
          assertRoleChangeAllowed({
            actor: { id: req.user?.id, role: req.user?.role },
            target: { id: existing.id, role: existing.role },
            requestedRole,
          });

          // Rails 4 + 5, then the paired write — accessRoleId and the enum
          // tier move together or not at all.
          //
          // WARP-1526 (pr-reviewer #1229 N2): the in-tx rails also take the
          // target's enable state — rail 5 counts NON-disabled operators, so
          // a DEACTIVATED sole admin must stay demotable. `existing` is read
          // inside this transaction through PUBLIC_USER_SELECT, which
          // carries directoryStatus, so no extra round-trip is needed.
          await assertRoleChangeInvariantsTx(tx, {
            target: {
              id: existing.id,
              role: existing.role,
              directoryStatus: existing.directoryStatus,
            },
            requestedRole,
          });
          await tx.user.update({
            where: { id: existing.id },
            data: { accessRoleId, role: requestedRole },
          });

          return { existing, requestedRole, accessRoleId, roleName };
        }, SERIALIZABLE_TX);

        const { existing, requestedRole, accessRoleId, roleName } = outcome;

        // Rail 6. A tier crossing runs the consolidated runner (revoke →
        // NC droplet-admins cascade → "Role changed" audit); a same-tier
        // change (role swap / role clear) still revokes — the person's
        // effective access changed even though the enum floor didn't.
        if (existing.role !== requestedRole) {
          await runRoleChangePostEffects({
            target: {
              id: existing.id,
              username: existing.username,
              nextcloudUsername: existing.nextcloudUsername,
            },
            previousRole: existing.role,
            nextRole: requestedRole,
            actorUsername: req.user?.username ?? null,
            actor: actorFromRequest(req),
          });
        } else {
          await revokeAllSessions(existing.id);
        }

        if (accessRoleId !== null) {
          await recordActivity({
            kind: "auth",
            severity: "ok",
            sourceIcon: "shield",
            what: "Access role assigned",
            sub: `${roleName} → ${existing.username}`,
            refs: {
              actor: req.user?.username ?? null,
              roleId: accessRoleId,
              roleName,
              targetUserId: existing.id,
              targetUsername: existing.username,
            },
            actor: actorFromRequest(req),
          });
        }

        res.json({ syncState: "pending" });
      } catch (err) {
        // One shape for both (WARP-1583) — see the sibling assign path in
        // routes/access.ts.
        if (isAccessPreconditionError(err) || err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        next(err);
      }
    },
  );

  // ── GET /api/people/:id/effective-access ────────────────────
  // WARP-1527 (RBAC v2 T3). The ADR-032 §3 resolver output verbatim —
  // powers the person editor's read-only drawer and every honest
  // disabled-state in the dashboard (T8 seeds its exception editor from
  // the `exceptions` array).
  router.get(
    "/people/:id/effective-access",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const access = await resolveEffectiveAccess(req.params.id);
        if (!access) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json(access);
      } catch (err) {
        logger.warn(
          { err, id: req.params.id },
          "GET /people/:id/effective-access failed",
        );
        next(err);
      }
    },
  );

  // ── PUT /api/people/:id/access-exceptions ───────────────────
  // WARP-1527 (RBAC v2 T3). Replace-wholesale semantics (the scope-PATCH
  // precedent — the editor never diffs rows client-side); rails 2 + 1
  // apply (§4: self-action extends to exceptions; the owner's row is
  // untouchable). No session revocation: exceptions resolve live per
  // request through the layer-2 resolver, nothing role-shaped is cached
  // in the JWT.
  router.put(
    "/people/:id/access-exceptions",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        assertNotSelf(req.user?.id, req.params.id);

        const parsed = accessExceptionsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid request",
            details: parsed.error.flatten(),
          });
        }

        // WARP-1539 — projected at the query (see PATCH /:id/access above).
        const existing = await prisma.user.findUnique({
          where: { id: req.params.id },
          select: PUBLIC_USER_SELECT,
        });
        if (!existing) {
          return res.status(404).json({ error: "User not found" });
        }
        // Rails 2 + 1 (same composite the scope rewrite uses).
        assertScopeChangeAllowed({
          actor: { id: req.user?.id, role: req.user?.role },
          target: { id: existing.id, role: existing.role },
        });

        const previous = await prisma.userAccessException.findMany({
          where: { userId: existing.id },
          select: { moduleId: true, effect: true, level: true },
        });

        const grantedBy = req.user?.id ?? "unknown";
        // Same replace-wholesale shape — and the same explicit
        // SERIALIZABLE_TX — as the scope-binding rewrite above (WARP-1526):
        // two concurrent PUTs of the same person's exceptions must not
        // interleave into a merged set, and a crash between the delete and
        // the recreate must not leave the person with zero rows.
        await prisma.$transaction(async (tx) => {
          await tx.userAccessException.deleteMany({
            where: { userId: existing.id },
          });
          if (parsed.data.exceptions.length > 0) {
            await tx.userAccessException.createMany({
              data: parsed.data.exceptions.map((x) => ({
                userId: existing.id,
                moduleId: x.moduleId,
                effect: x.effect,
                level: x.effect === "allow" ? (x.level as "view" | "act" | "manage") : null,
                grantedBy,
              })),
            });
          }
        }, SERIALIZABLE_TX);

        // Audit the delta with the house vocabulary: rows added/changed →
        // "set"; rows dropped → "removed". One row per verb, refs carry
        // the module lists + target UUID.
        const prevByModule = new Map(previous.map((x) => [x.moduleId as string, x]));
        const nextByModule = new Map(parsed.data.exceptions.map((x) => [x.moduleId as string, x]));
        const setModules = parsed.data.exceptions
          .filter((x) => {
            const prev = prevByModule.get(x.moduleId);
            return !prev || prev.effect !== x.effect || (prev.level ?? null) !== (x.level ?? null);
          })
          .map((x) => x.moduleId);
        const removedModules = previous
          .filter((x) => !nextByModule.has(x.moduleId as string))
          .map((x) => x.moduleId);
        const baseRefs = {
          actor: req.user?.username ?? null,
          targetUserId: existing.id,
          targetUsername: existing.username,
        };
        if (setModules.length > 0) {
          await recordActivity({
            kind: "auth",
            severity: "ok",
            sourceIcon: "shield",
            what: "Access exception set",
            sub: `${existing.username}: ${setModules.join(", ")}`,
            refs: { ...baseRefs, modules: setModules },
            actor: actorFromRequest(req),
          });
        }
        if (removedModules.length > 0) {
          await recordActivity({
            kind: "auth",
            severity: "ok",
            sourceIcon: "shield",
            what: "Access exception removed",
            sub: `${existing.username}: ${removedModules.join(", ")}`,
            refs: { ...baseRefs, modules: removedModules },
            actor: actorFromRequest(req),
          });
        }

        const rows = await prisma.userAccessException.findMany({
          where: { userId: existing.id },
          select: { id: true, moduleId: true, effect: true, level: true },
          orderBy: { createdAt: "asc" },
        });
        res.json({ exceptions: rows });
      } catch (err) {
        if (err instanceof RoleMutationRefusedError) {
          return res.status(err.status).json(err.toJSON());
        }
        next(err);
      }
    },
  );

  return router;
}

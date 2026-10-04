/**
 * WARP (SCIM directory sync) — provisioning service: the SCIM ↔ local-User /
 * Group mapping, idempotency, and SOFT deactivation.
 *
 * This is the DB boundary the SCIM route (routes/scim.ts) delegates to. It
 * mirrors the account-linking policy of the SSO callback (routes/sso.ts):
 * a SCIM user is keyed by the NORMALIZED work email and linked through the
 * EXISTING `SsoIdentity` table (provider="okta", subject = the SCIM
 * externalId, falling back to the local User.id when Okta omits externalId).
 * The local `User.id` UUID is always preserved (WARP-485).
 *
 * Idempotency (Okta retries every call): every operation is create-or-update
 * keyed on a stable identifier, never a blind insert. Re-running a POST /
 * PUT / PATCH / DELETE converges to the same state.
 *
 * Deactivation is SOFT (architecture-guard rule 10): `active:false` / DELETE
 * sets `directoryStatus = DEACTIVATED` (an explicit enum), never a row
 * delete — Okta owns the lifecycle and may re-activate the same person later.
 *
 * ROLE writes (group → role mapping) go through
 * `role-mutation-guard.service.ts` like every other person-mutation surface,
 * and are capped at `SCIM_ROLE_CEILING` — WARP-1568. `provisionUser` never
 * touches `role` at all.
 *
 * DEACTIVATION writes go through the same guard — WARP-2016. POST (on an
 * email-matched EXISTING row — WARP-2550), PUT, PATCH and DELETE all funnel
 * into `setUserActive`/`deactivateUser`, which run the disable rails
 * (owner-immutability 403, last-operator 409) and the disable post-effects.
 * An Okta push can therefore be REFUSED; the route renders the rail's code
 * in the SCIM Error envelope.
 */
import type { PrismaClient, User } from "@prisma/client";
import { findUserByEmail, emailWriteData } from "./user-directory.service.js";
import {
  effectiveRoleForGroupNames,
  highestRole,
  matchedLegacyElevationRule,
  roleForScimGroupName,
  ROLE_PRIVILEGE,
  SCIM_ROLE_CEILING,
} from "./scim-role-mapping.service.js";
import type { DirectoryRole } from "./scim-role-mapping.service.js";
import type { ParsedScimUser } from "./scim-resource.js";
import type { Role } from "./jwt.service.js";
import {
  ADMIN_TIER_ROLES,
  assertDisableAllowed,
  assertDisableInvariantsTx,
  assertRoleChangeAllowed,
  assertRoleChangeInvariantsTx,
  isConcurrencyConflict,
  readGuardTargetTx,
  RoleMutationRefusedError,
  runDisablePostEffects,
  runRoleChangePostEffects,
  SERIALIZABLE_TX,
  type GuardActor,
} from "./role-mutation-guard.service.js";
import { createLogger } from "../lib/logger.js";
import { isUserIdShaped } from "@droplet/auth-policy";

const logger = createLogger("scim-service");

/** The "okta" provider id — SCIM provisioning links live under it in
 *  SsoIdentity, the same row a later Okta SSO sign-in resolves by sub. */
const OKTA_PROVIDER = "okta";

/**
 * WARP-1568 — the SCIM principal, as the role-mutation guard sees it.
 *
 * `id: null` because SCIM is not a person: rail 2 (self-action) compares
 * identities and a null actor id can never self-match, which is exactly right
 * — there is no "self" for an IdP to protect.
 *
 * `role: SCIM_ROLE_CEILING` is the load-bearing half. Rail 3 (the WARP-1523
 * rank cap) refuses any requested role that outranks the ACTOR's, so giving
 * the SCIM principal the ceiling as its own rank expresses "Okta provisions
 * as an admin, and cannot assign above itself" in the vocabulary the guard
 * already speaks — rather than as a second, separately-maintained check that
 * could drift from the ceiling constant. `owner` is therefore refused twice
 * over: ROLE_RANK_EXCEEDED by rail 3, ROLE_NOT_ASSIGNABLE by rail 7.
 */
const SCIM_ACTOR: GuardActor = { id: null, role: SCIM_ROLE_CEILING };

/**
 * Actor attribution for the audit rows this service emits (rail 6).
 *
 * The colon is deliberate: `usernameSeedFromEmail` strips everything outside
 * [A-Za-z0-9._-], so no local User.username can ever be this string, and an
 * auditor can never mistake a SCIM-originated role change for one made by a
 * person who happens to be called "scim". `actor.type` stays `system` —
 * the same attribution the SCIM route already records (routes/scim.ts).
 */
const SCIM_AUDIT_ACTOR = `scim:${OKTA_PROVIDER}`;

/** Rail 3's refusal copy on this surface (the message stays per-site). */
const SCIM_RANK_MESSAGE =
  "SCIM cannot assign a role above the directory-sync ceiling";

/** Local-part of an email, sanitized into a username seed (mirrors sso.ts).
 *  WARP-2911: never the shape of a `User.id` — notifications refuse a
 *  UUID-shaped recipient, so such a username would be refused every one. */
function usernameSeedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 48);
  return cleaned.length >= 2 && !isUserIdShaped(cleaned) ? cleaned : `scim-${cleaned}`;
}

export interface ProvisionUserResult {
  user: User;
  /** True when a NEW local User row was created; false when an existing row
   *  (matched by email) was updated in place. */
  created: boolean;
}

/**
 * Create-or-update a directory user from a parsed SCIM payload. Keyed by the
 * normalized email:
 *   - existing row → update displayName + active status IN PLACE (id + role
 *     preserved; SCIM never demotes an existing owner/admin).
 *   - no row → create a least-privilege (`family`), `isLocal`, no-passwordHash
 *     (SCIM users can't password-login) row, ACTIVE unless active:false.
 * Either way, ensure the SsoIdentity(okta, externalId|id) link exists (idempotent).
 */
export async function provisionUser(
  prisma: PrismaClient,
  parsed: ParsedScimUser,
): Promise<ProvisionUserResult> {
  const targetStatus = parsed.active ? "ACTIVE" : "DEACTIVATED";

  // WARP-233: blind-index lookup (email at rest is a dcv1 ciphertext).
  const existing = await findUserByEmail(prisma, parsed.email);
  if (existing) {
    // WARP-3193 SEC-AUTH-1 — refused BEFORE any write (same ordering contract
    // as below): the Okta link is what routes/sso.ts signs in by, so binding
    // a new subject to an operator row hands that account to whoever holds
    // the Okta identity named in `externalId`. An operator already linked to
    // this exact subject (an Okta retry) is not a new binding and converges.
    if (isOperatorTier(existing.role)) {
      const link = await prisma.ssoIdentity.findUnique({
        where: { provider_subject: { provider: OKTA_PROVIDER, subject: parsed.externalId ?? existing.id } },
      });
      if (link?.userId !== existing.id) throw operatorAccountRefusal();
    }
    // WARP-2550 — an email-matched POST is a full replace in everything but
    // the verb: it carries `active`, so it MUST flip active-state through the
    // one guarded funnel, exactly like `replaceUser` (PUT). Until this it did
    // a bare `prisma.user.update` writing `directoryStatus`, which made POST
    // the fourth active-state verb and the only unrailed one — an Okta push
    // with active:false whose userName matched the sole owner, or the last
    // ACTIVE admin, deactivated them with no owner-immutability rail (403),
    // no last-operator invariant (409), no session revocation and no audit
    // row: the exact operator lockout WARP-2016 closed on PUT/PATCH/DELETE.
    //
    // Reusing `replaceUser` rather than re-deriving the rails here is the
    // point — the ordering contract (guarded flip FIRST, so a refused call
    // applies no part of the upsert, displayName included) lives in ONE
    // place and cannot drift per-verb.
    const user = await replaceUser(prisma, existing.id, parsed);
    // A null here means the row we resolved a moment ago was hard-deleted
    // inside the window. Nothing was applied — the guard's own answer for a
    // lost race; Okta's retry then converges down the create path.
    if (!user) throw RoleMutationRefusedError.concurrentMutation();
    // NB: role is intentionally NOT changed here — an existing owner/admin
    // keeps their role; group membership (provisionGroup) is the only thing
    // that elevates, and never via a plain user upsert.
    await ensureOktaLink(prisma, user.id, parsed);
    return { user, created: false };
  }

  // WARP-2550 — a NEW row created with active:false is deliberately NOT
  // routed through the disable funnel: there is no prior row holding live
  // access, and the row is minted least-privilege `family`, so rail 1
  // (owner immutability) has no owner to protect and rail 5 (last operator)
  // no operator to strand. Create-disabled is a plain create; running the
  // rails would mean create-then-deactivate, which emits a "User disabled"
  // audit row for a person who was never enabled.
  const user = await prisma.user.create({
    data: {
      username: usernameSeedFromEmail(parsed.email),
      displayName: parsed.displayName,
      ...emailWriteData(parsed.email),
      role: "family", // least privilege; provisionGroup raises it
      isLocal: true,
      // WARP-2858: explicit origin — the box never sets a local password on it.
      provisionSource: "SCIM",
      directoryStatus: targetStatus,
      // No passwordHash — SCIM-provisioned users authenticate via Okta SSO
      // only; /auth/login fails closed on a null hash.
    },
  });
  await ensureOktaLink(prisma, user.id, parsed);
  return { user, created: true };
}

/** Ensure exactly one SsoIdentity(okta, subject) link for this user. The
 *  subject is the SCIM externalId when Okta supplies it, else the local
 *  User.id (stable). Idempotent — a retry finds the row and no-ops. */
async function ensureOktaLink(prisma: PrismaClient, userId: string, parsed: ParsedScimUser): Promise<void> {
  const subject = parsed.externalId ?? userId;
  const found = await prisma.ssoIdentity.findUnique({
    where: { provider_subject: { provider: OKTA_PROVIDER, subject } },
  });
  if (found) return;
  await prisma.ssoIdentity.create({
    data: { userId, provider: OKTA_PROVIDER, subject, email: parsed.email },
  });
}

/**
 * Soft-deactivate a user by local id (the SCIM resource id). Sets
 * DEACTIVATED; never deletes. Idempotent. Returns null for an unknown id.
 *
 * WARP-2016 — this write goes through role-mutation-guard.service.ts, the
 * ONE place the person-mutation rails live, exactly like the WARP-1568 role
 * writes above (`raiseUserRoleTo`). Until this change SCIM deactivation was
 * the last active-state surface still writing `directoryStatus` bare, so an
 * Okta push could deactivate the sole owner — or the last ACTIVE admin —
 * and strand the box with zero operators able to sign in, with no session
 * revocation and no audit row. Not privilege escalation (auth middleware
 * re-reads directoryStatus and fails closed); total operator lockout.
 *
 * The shape mirrors POST /auth/users/:username/disable:
 *   • pre-tx: `assertDisableAllowed` (rail 2 self-action — vacuous for the
 *     id-less SCIM principal — then rail 1 owner-immutability, 403);
 *   • the write inside ONE SERIALIZABLE transaction, after re-reading the
 *     target in-transaction and running rail 5 (last-operator, 409) against
 *     THAT row, with `directoryStatus` pinned in the write's `where` so a
 *     status flip landing in the window is a 0-row P2025 no-op instead of a
 *     decision made on stale state;
 *   • rail 6 post-commit: `runDisablePostEffects` — session revocation plus
 *     the mandatory "User disabled" audit row, attributed to the system
 *     actor like every other SCIM emit.
 *
 * Re-deactivating an already-DEACTIVATED row stays an idempotent success:
 * rail 5 early-returns for a DEACTIVATED target (it holds no live access to
 * strand), the pinned write is a no-op rewrite, and the post-effects run per
 * call — Okta retries converge, they never wedge.
 *
 * A SERIALIZABLE loser / optimistic-pin miss is rethrown as the guard's
 * CONCURRENT_MUTATION refusal (409): nothing was applied and Okta's retry
 * converges — the same mapping auth.ts applies.
 */
export async function deactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;

  // Rails 2 → 1 on the snapshot (the pre-tx composite the interactive
  // disable surface runs). Rail 1 is what stops Okta deactivating the owner.
  assertDisableAllowed({
    actor: SCIM_ACTOR,
    target: { id: existing.id, role: existing.role as Role },
  });

  let updated: User;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fresh = await readGuardTargetTx(tx, id);
      if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
      // Rail 5 against the IN-TRANSACTION row: whether it runs at all is
      // derived from the target's tier, so the snapshot is not good enough.
      await assertDisableInvariantsTx(tx, { target: fresh });
      return tx.user.update({
        where: { id, directoryStatus: fresh.directoryStatus },
        data: { directoryStatus: "DEACTIVATED" },
      });
    }, SERIALIZABLE_TX);
  } catch (err) {
    if (isConcurrencyConflict(err)) {
      logger.warn({ userId: id }, "SCIM deactivate lost a write race; retry converges");
      throw RoleMutationRefusedError.concurrentMutation();
    }
    throw err;
  }

  // Rail 6 (consolidated): WARP-116/247 session revocation + the WARP-1062
  // mandatory-emit audit row — previously this path revoked and emitted
  // NOTHING, leaving live sessions behind a "deactivated" row.
  await runDisablePostEffects({
    targetUserId: existing.id,
    username: existing.username,
    actor: { type: "system", id: null },
    devices: { prisma, username: existing.username },
  });
  return updated;
}

/** Re-activate a soft-deactivated user (active:true on a DEACTIVATED row).
 *  An already-ACTIVE row is an idempotent no-op (Okta PUTs active:true on
 *  every sync).
 *
 *  WARP-3193 SEC-AUTH-1 — a DEACTIVATED owner/admin is refused: that state
 *  is a local operator decision, and SCIM must not undo it. This is no
 *  lockout (the WARP-2016 worry): the owner is disable-immutable and rail 5
 *  always leaves one ACTIVE operator, who re-enables from the dashboard.
 *  The write pins role + status so a promotion landing in the window is a
 *  0-row miss (CONCURRENT_MUTATION), not a stale decision. */
export async function reactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;
  if (existing.directoryStatus === "ACTIVE") return existing;
  if (isOperatorTier(existing.role)) throw operatorAccountRefusal();
  // WARP-3113: pinned to NONE, as the dashboard enable is. A person
  // scheduled for deletion (PENDING, or PURGING under the nightly job) is
  // not brought back by the IdP; an admin cancels the deletion first.
  // Also pinned to role + directoryStatus (WARP-3193), so a concurrent
  // promotion or disable is a miss, not a silent overwrite.
  const reactivated = await prisma.user.updateMany({
    where: {
      id,
      role: existing.role,
      directoryStatus: existing.directoryStatus,
      deletionStatus: "NONE",
    },
    data: { directoryStatus: "ACTIVE" },
  });
  if (reactivated.count === 0) {
    throw existing.deletionStatus === "NONE"
      ? RoleMutationRefusedError.concurrentMutation()
      : RoleMutationRefusedError.deletionPending();
  }
  return prisma.user.findUnique({ where: { id } });
}

/** WARP-3193 SEC-AUTH-1 — operator rows are outside SCIM's reach for
 *  identity binding and reactivation. Rail 3's code: the ceiling is admin,
 *  and SCIM may not act on a row at or above it. */
function isOperatorTier(role: string): boolean {
  return (ADMIN_TIER_ROLES as readonly string[]).includes(role);
}

function operatorAccountRefusal(): RoleMutationRefusedError {
  return RoleMutationRefusedError.rankExceeded(
    "SCIM cannot bind identities to, or reactivate, operator accounts",
  );
}

/** Apply a SCIM PATCH/PUT `active` change by id (true → ACTIVE, false →
 *  DEACTIVATED). Returns null for an unknown id. THE shared funnel: every
 *  SCIM verb that flips active-state routes through here (WARP-2016), so
 *  the disable rails cannot be bypassed per-verb. */
export async function setUserActive(prisma: PrismaClient, id: string, active: boolean): Promise<User | null> {
  return active ? reactivateUser(prisma, id) : deactivateUser(prisma, id);
}

/**
 * SCIM PUT full-replace (WARP-2016): apply the `active` state THROUGH the
 * shared funnel first, then the attribute update. Order is the contract —
 * a replace the rails refuse applies NO part of the replace (the route
 * renders the refusal envelope and Okta sees the resource unchanged), so
 * the guarded flip must precede the displayName write. Previously this verb
 * performed its own bare `prisma.user.update` writing `directoryStatus`,
 * bypassing scim.service.ts entirely — railing PATCH/DELETE alone would
 * have left PUT as the open door.
 */
export async function replaceUser(
  prisma: PrismaClient,
  id: string,
  parsed: ParsedScimUser,
): Promise<User | null> {
  const active = await setUserActive(prisma, id, parsed.active);
  if (!active) return null;
  return prisma.user.update({ where: { id }, data: { displayName: parsed.displayName } });
}

export async function findUserById(prisma: PrismaClient, id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export async function findUserByUserName(prisma: PrismaClient, email: string): Promise<User | null> {
  // WARP-233: SCIM userName IS the email — resolve through the blind index.
  return findUserByEmail(prisma, email);
}

export interface ProvisionGroupInput {
  displayName: string;
  externalId?: string;
  /** Local User.ids of the group's members (SCIM group `members[].value`). */
  memberUserIds: string[];
}

export interface ScimGroupResult {
  id: string;
  displayName: string;
  mappedRole: string;
}

/**
 * Upsert a SCIM group and apply its role mapping to listed members.
 *
 * The group's `mappedRole` comes from the operator-configured map
 * (`SCIM_GROUP_ROLE_MAP`, exact group id or name; `family` when unlisted —
 * WARP-3631), capped at SCIM_ROLE_CEILING — `admin` is the most privileged
 * role an Okta group can grant, and `owner` is not assignable from a
 * directory at all (WARP-1568). Each member's role is RAISED to at least that
 * role (highest-privilege-wins floor); a higher-privileged member added to a
 * lower group is NOT demoted. Every role write goes through the role-mutation
 * guard (see `writeScimRole`).
 *
 * WARP-3631: the push's member list is persisted on the group. A person who
 * was in the previous push and is absent from this one is recomputed from the
 * groups they remain in (`lowerRoleAfterRemoval`) and lowered when the group
 * is what had granted their role. The same applies to everyone the group
 * previously raised when the configured mapping for it is lowered. Only
 * SCIM-provisioned people are touched, and the same guard rails apply (owner
 * immutability, last operator).
 */
export async function provisionGroup(
  prisma: PrismaClient,
  input: ProvisionGroupInput,
): Promise<ScimGroupResult> {
  const mappedRole: DirectoryRole = roleForScimGroupName(input.displayName, input.externalId);
  const memberUserIds = [...new Set(input.memberUserIds)];

  // Upsert by externalId OR displayName (both unique) so Okta retries
  // converge to one row.
  const or: Array<Record<string, string>> = [{ displayName: input.displayName }];
  if (input.externalId) or.unshift({ externalId: input.externalId });
  const existing = await prisma.scimGroup.findFirst({ where: { OR: or } });
  const previousMembers: string[] = existing?.memberUserIds ?? [];
  const previousRole = (existing?.mappedRole as DirectoryRole | undefined) ?? mappedRole;

  let groupRow;
  if (existing) {
    groupRow = await prisma.scimGroup.update({
      where: { id: existing.id },
      data: {
        displayName: input.displayName,
        externalId: input.externalId ?? existing.externalId,
        mappedRole,
        memberUserIds,
      },
    });
  } else {
    groupRow = await prisma.scimGroup.create({
      data: { displayName: input.displayName, externalId: input.externalId ?? null, mappedRole, memberUserIds },
    });
  }

  // A rail refusal is PER MEMBER, not per request (WARP-1568). The refusal
  // already IS the safe outcome (that member's role is left untouched), and
  // SCIM has no per-member error channel in this minimal Group surface — so
  // failing the whole push would only stop the group and its other members
  // from converging, and would 4xx-loop Okta's retry forever. Logged at warn
  // with the machine-readable rail code; never swallowed silently.
  const perMember = async (userId: string, apply: () => Promise<void>): Promise<void> => {
    try {
      await apply();
    } catch (err) {
      if (err instanceof RoleMutationRefusedError) {
        logger.warn(
          { userId, code: err.code, mappedRole, group: input.displayName },
          "SCIM group role mapping refused by the role-mutation guard; member's role left unchanged",
        );
        return;
      }
      // Nothing was applied (SERIALIZABLE loser / optimistic-write miss);
      // Okta's next push re-converges this member.
      if (isConcurrencyConflict(err)) {
        logger.warn(
          { userId, mappedRole, group: input.displayName },
          "SCIM group role mapping lost a write race; retry converges",
        );
        return;
      }
      throw err;
    }
  };

  // Raise each member's role to at least the group's mapped role.
  for (const userId of memberUserIds) {
    await perMember(userId, () => raiseUserRoleTo(prisma, userId, mappedRole));
  }
  // WARP-3631 — lower anyone this push dropped from the group, and, when the
  // operator lowered the group's mapping, everyone the old mapping had raised.
  const recompute =
    ROLE_PRIVILEGE[previousRole] > ROLE_PRIVILEGE[mappedRole]
      ? previousMembers
      : previousMembers.filter((id) => !memberUserIds.includes(id));
  for (const userId of recompute) {
    await perMember(userId, () => lowerRoleAfterRemoval(prisma, userId, previousRole));
  }

  return { id: groupRow.id, displayName: groupRow.displayName, mappedRole: groupRow.mappedRole };
}

/**
 * WARP-3631 upgrade notice. Group names no longer elevate by substring, so a
 * box that relied on a directory group called "Admins" or "Managers" stops
 * granting admin to its members until the operator names the group's SCIM id
 * in `SCIM_GROUP_ROLE_MAP`. Nothing is granted automatically: this logs, at
 * every start, each stored group that used to elevate and no longer does, with
 * the exact entry that would restore it.
 */
export async function warnLegacyScimRoleMapping(prisma: PrismaClient): Promise<void> {
  const groups = await prisma.scimGroup.findMany({
    select: { displayName: true, externalId: true, mappedRole: true },
  });
  for (const g of groups) {
    const wasElevated =
      ROLE_PRIVILEGE[g.mappedRole as DirectoryRole] > ROLE_PRIVILEGE.family || matchedLegacyElevationRule(g.displayName);
    const now = roleForScimGroupName(g.displayName, g.externalId);
    if (!wasElevated || ROLE_PRIVILEGE[now] > ROLE_PRIVILEGE.family) continue;
    logger.warn(
      {
        group: g.displayName,
        restoreWith: g.externalId
          ? { variable: "SCIM_GROUP_ROLE_MAP", entry: { [`id:${g.externalId}`]: "admin" } }
          : "no SCIM group id on record; the directory must send externalId for this group before it can be mapped",
      },
      "SCIM group no longer grants admin by name (WARP-3631); its members keep their current role but are not raised again. Add the entry shown to SCIM_GROUP_ROLE_MAP to restore it.",
    );
  }
}

/**
 * WARP-3631 — a person left a group. Recompute their role from the groups they
 * still belong to (family when none) and lower them to it, but only when:
 *   - they are SCIM-provisioned (a local or SSO person's role is not the IdP's), and
 *   - their current role is no higher than what the removed group granted (so a
 *     role an owner set by hand above the group's grant is left alone).
 */
async function lowerRoleAfterRemoval(
  prisma: PrismaClient,
  userId: string,
  removedGroupRole: DirectoryRole,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.provisionSource !== "SCIM") return;
  const remaining = await prisma.scimGroup.findMany({
    where: { memberUserIds: { has: userId } },
    select: { mappedRole: true },
  });
  const target = highestRole(remaining.map((g) => g.mappedRole as DirectoryRole));
  await writeScimRole(prisma, userId, target, (current) => {
    const rank = ROLE_PRIVILEGE[current as DirectoryRole];
    return rank !== undefined && rank > ROLE_PRIVILEGE[target] && rank <= ROLE_PRIVILEGE[removedGroupRole];
  });
}

/**
 * Raise a user's role to `target` if `target` is more privileged than their
 * current role; otherwise leave it (no demotion). The internal `service`
 * role is never produced by SCIM so it isn't considered here.
 *
 * WARP-1568 — this write goes through role-mutation-guard.service.ts, the
 * ONE place the person-mutation rails live. Until this change SCIM was the
 * last surface still writing `User.role` directly, so an Okta group named
 * "Business Owners" could set `role: "owner"` on a provisioned user with none
 * of the rails the interactive surfaces (people.ts, auth.ts) have enforced
 * since WARP-1526 — no rank cap, no assignable-enum narrowing, no owner
 * immutability, no last-owner / last-operator invariant, and no audit row.
 *
 * The shape mirrors PATCH /api/people/:id/role exactly:
 *   • the no-op short-circuit runs FIRST (a raise that isn't a raise is not a
 *     mutation, so there is nothing for a rail to refuse and nothing to
 *     audit) — the people.ts precedent, pinned by the WARP-1523 tests;
 *   • rails 1 / 2 / 3 / 7 pre-transaction on the snapshot;
 *   • the write inside ONE SERIALIZABLE transaction, after re-reading the
 *     target in-transaction and running rails 4 + 5 against THAT row, with
 *     `role` pinned in the write's `where` so a promotion landing in the
 *     window is a 0-row no-op instead of a decision made on stale state;
 *   • rail 6 post-commit: session revocation, the droplet-admins Nextcloud
 *     cascade, and the "Role changed" Activity row — byte-identical to the
 *     interactive surfaces, attributed to the SCIM principal.
 *
 * NOTE on the in-transaction re-read: the direction rule is re-evaluated
 * against the FRESH row, so a concurrent change turns the write into a no-op.
 * Since WARP-3631 a person leaving a group CAN be lowered, so rails 4 + 5
 * (the last-operator invariant) are live on this path: an Okta push cannot
 * leave the box with nobody able to manage access.
 */
async function raiseUserRoleTo(prisma: PrismaClient, userId: string, target: DirectoryRole): Promise<void> {
  await writeScimRole(prisma, userId, target, (current) => outranksCurrent(target, current));
}

/**
 * The ONE guarded SCIM role write, shared by the raise and the WARP-3631
 * lower. `applies` is the direction rule ("is this still a raise / a lower
 * for the row as it is now?"); it runs on the snapshot and again on the
 * in-transaction row so a racing writer turns the write into a no-op.
 */
async function writeScimRole(
  prisma: PrismaClient,
  userId: string,
  target: DirectoryRole,
  applies: (currentRole: string) => boolean,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  // Read off the snapshot ONCE: `previousRole` is what the audit row states
  // happened, so it must be the value the decision was made on, never a
  // re-read of a row the write has already moved.
  const previousRole = user.role as Role;
  if (!applies(previousRole)) return;

  // Rails 1 → 2 → 3 → 7 (WARP-1526). Rail 3 is what stops `owner` even if a
  // future mapping rule forgets the ceiling; rail 7 refuses it again.
  assertRoleChangeAllowed({
    actor: SCIM_ACTOR,
    target: { id: user.id, role: previousRole },
    requestedRole: target,
    rankMessage: SCIM_RANK_MESSAGE,
  });

  const applied = await prisma.$transaction(async (tx) => {
    const fresh = await readGuardTargetTx(tx, userId);
    if (!fresh) throw RoleMutationRefusedError.concurrentMutation();
    // Re-evaluate the direction rule on the in-transaction row: a change that
    // landed since the snapshot makes this a no-op, never a write that
    // contradicts it.
    if (!applies(fresh.role)) return false;
    await assertRoleChangeInvariantsTx(tx, { target: fresh, requestedRole: target });
    await tx.user.update({
      where: { id: userId, role: fresh.role },
      data: { role: target },
    });
    return true;
  }, SERIALIZABLE_TX);

  if (!applied) return;

  await runRoleChangePostEffects({
    target: {
      id: user.id,
      username: user.username,
      nextcloudUsername: user.nextcloudUsername,
    },
    previousRole,
    nextRole: target,
    actorUsername: SCIM_AUDIT_ACTOR,
    actor: { type: "system", id: null },
  });
}

/**
 * Is `target` strictly more privileged than the role this row currently
 * holds? An unrecognized current role (only `service`, which SCIM never
 * mints) is compared at the `family` floor, unchanged from the shipped
 * behaviour.
 */
function outranksCurrent(target: DirectoryRole, currentRole: string): boolean {
  const currentRank = ROLE_PRIVILEGE[currentRole as DirectoryRole] ?? ROLE_PRIVILEGE.family;
  return ROLE_PRIVILEGE[target] > currentRank;
}

/** Re-export for callers that want to compute a role from a name list. */
export { effectiveRoleForGroupNames };

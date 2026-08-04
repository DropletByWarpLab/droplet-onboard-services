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
 */
import type { PrismaClient, User } from "@prisma/client";
import { findUserByEmail, emailWriteData } from "./user-directory.service.js";
import {
  effectiveRoleForGroupNames,
  roleForScimGroupName,
  ROLE_PRIVILEGE,
  SCIM_ROLE_CEILING,
} from "./scim-role-mapping.service.js";
import type { DirectoryRole } from "./scim-role-mapping.service.js";
import type { ParsedScimUser } from "./scim-resource.js";
import type { Role } from "./jwt.service.js";
import {
  assertRoleChangeAllowed,
  assertRoleChangeInvariantsTx,
  isConcurrencyConflict,
  readGuardTargetTx,
  RoleMutationRefusedError,
  runRoleChangePostEffects,
  SERIALIZABLE_TX,
  type GuardActor,
} from "./role-mutation-guard.service.js";
import { createLogger } from "../lib/logger.js";

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

/** Local-part of an email, sanitized into a username seed (mirrors sso.ts). */
function usernameSeedFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const cleaned = local.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 48);
  return cleaned.length >= 2 ? cleaned : `scim-${cleaned}`;
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
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: parsed.displayName,
        directoryStatus: targetStatus,
        // NB: role is intentionally NOT changed here — an existing
        // owner/admin keeps their role; group membership (provisionGroup) is
        // the only thing that elevates, and never via a plain user upsert.
      },
    });
    await ensureOktaLink(prisma, user.id, parsed);
    return { user, created: false };
  }

  const user = await prisma.user.create({
    data: {
      username: usernameSeedFromEmail(parsed.email),
      displayName: parsed.displayName,
      ...emailWriteData(parsed.email),
      role: "family", // least privilege; provisionGroup raises it
      isLocal: true,
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

/** Soft-deactivate a user by local id (the SCIM resource id). Sets
 *  DEACTIVATED; never deletes. Idempotent. Returns null for an unknown id. */
export async function deactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;
  return prisma.user.update({ where: { id }, data: { directoryStatus: "DEACTIVATED" } });
}

/** Re-activate a soft-deactivated user (active:true on a DEACTIVATED row). */
export async function reactivateUser(prisma: PrismaClient, id: string): Promise<User | null> {
  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return null;
  return prisma.user.update({ where: { id }, data: { directoryStatus: "ACTIVE" } });
}

/** Apply a SCIM PATCH/PUT `active` change by id (true → ACTIVE, false →
 *  DEACTIVATED). Returns null for an unknown id. */
export async function setUserActive(prisma: PrismaClient, id: string, active: boolean): Promise<User | null> {
  return active ? reactivateUser(prisma, id) : deactivateUser(prisma, id);
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
 * The group's `mappedRole` is resolved from its display name by the explicit
 * policy (scim-role-mapping.service), capped at SCIM_ROLE_CEILING — `admin`
 * is the most privileged role an Okta group can grant, and `owner` is not
 * assignable from a directory at all (WARP-1568). Each member's role is then
 * RAISED to at least that role (highest-privilege-wins floor) — a member of
 * "Admins" becomes admin; a higher-privileged member added to a lower group
 * is NOT demoted. This keeps role mapping idempotent (re-applying is a no-op)
 * without standing up the gated Team-membership UI. Every one of those role
 * writes goes through the role-mutation guard (see `raiseUserRoleTo`).
 *
 * NB (documented simplification): without a persisted SCIM membership table,
 * removing a user from a group does NOT auto-lower their role here. Role
 * elevation is sticky until an explicit People-surface change. This matches
 * the AC ("respect the EXISTING role model; do NOT build the gated Team UI")
 * and is called out in the PR handoff.
 */
export async function provisionGroup(
  prisma: PrismaClient,
  input: ProvisionGroupInput,
): Promise<ScimGroupResult> {
  const mappedRole: DirectoryRole = roleForScimGroupName(input.displayName);

  // Upsert by externalId OR displayName (both unique) so Okta retries
  // converge to one row.
  const or: Array<Record<string, string>> = [{ displayName: input.displayName }];
  if (input.externalId) or.unshift({ externalId: input.externalId });
  const existing = await prisma.scimGroup.findFirst({ where: { OR: or } });

  let groupRow;
  if (existing) {
    groupRow = await prisma.scimGroup.update({
      where: { id: existing.id },
      data: { displayName: input.displayName, externalId: input.externalId ?? existing.externalId, mappedRole },
    });
  } else {
    groupRow = await prisma.scimGroup.create({
      data: { displayName: input.displayName, externalId: input.externalId ?? null, mappedRole },
    });
  }

  // Raise each member's role to at least the group's mapped role.
  //
  // WARP-1568: a rail refusal is PER MEMBER, not per request. The refusal
  // already IS the safe outcome (that member's role is left untouched), and
  // SCIM has no per-member error channel in this minimal Group surface — so
  // failing the whole push would only stop the group and its other members
  // from converging, and would 4xx-loop Okta's retry forever. Logged at warn
  // with the machine-readable rail code; never swallowed silently.
  for (const userId of input.memberUserIds) {
    try {
      await raiseUserRoleTo(prisma, userId, mappedRole);
    } catch (err) {
      if (err instanceof RoleMutationRefusedError) {
        logger.warn(
          { userId, code: err.code, mappedRole, group: input.displayName },
          "SCIM group role mapping refused by the role-mutation guard; member's role left unchanged",
        );
        continue;
      }
      // Nothing was applied (SERIALIZABLE loser / optimistic-write miss);
      // Okta's next push re-converges this member.
      if (isConcurrencyConflict(err)) {
        logger.warn(
          { userId, mappedRole, group: input.displayName },
          "SCIM group role mapping lost a write race; retry converges",
        );
        continue;
      }
      throw err;
    }
  }

  return { id: groupRow.id, displayName: groupRow.displayName, mappedRole: groupRow.mappedRole };
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
 * NOTE on the in-transaction re-read: because the raise-only rule is
 * re-evaluated against the FRESH row, a concurrent promotion turns this into
 * a no-op rather than a demotion. That is why rails 4/5 cannot currently fire
 * from this path — every write SCIM performs raises within, or into, the
 * operator tier, and neither invariant is concerned with those. They are
 * wired anyway (and asserted in the suite) so that the day SCIM group
 * membership becomes authoritative — i.e. leaving a group lowers a role —
 * the invariant that stops an IdP from stranding the box with zero operators
 * is already in the path rather than something the next author must remember.
 */
async function raiseUserRoleTo(prisma: PrismaClient, userId: string, target: DirectoryRole): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;
  // Read off the snapshot ONCE: `previousRole` is what the audit row states
  // happened, so it must be the value the decision was made on, never a
  // re-read of a row the write has already moved.
  const previousRole = user.role as Role;
  if (!outranksCurrent(target, previousRole)) return;

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
    // Re-evaluate the raise-only rule on the in-transaction row: a promotion
    // that landed since the snapshot must make this a no-op, never a
    // demotion (SCIM raises, it never lowers).
    if (!outranksCurrent(target, fresh.role)) return false;
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
